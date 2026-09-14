# Step M5-06 — Retention, redaction, export/import

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M5-04, M5-01, M5-02, M5-03, M0-04 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `apps/daemon` (`src/application/history`, `src/infrastructure/recorder`, `src/infrastructure/bundle`, `src/interface/http`), `apps/cli`, `apps/web`, `packages/ui` |
| Risk | Medium |
| Owner | |

## 1. Goal
History becomes a managed, user-owned asset instead of an ever-growing directory. Per-artifact TTLs sweep old recordings, attachments, events and transcripts (dry-run first, pinned sessions exempt); a user can select text in a replay or transcript and **redact** it after the fact — the recording, the messages and the search index are rewritten, and an audit row records who removed what without storing the secret; every session can be pinned, tagged, forked, resumed, soft-deleted or hard-purged; and `orch history export` writes a versioned mission bundle (tasks, results, reviews, recordings, events, plans, transcripts) that `orch history import` restores on a fresh database, replayable in the Timeline.

## 2. Why
- C13 ("secrets never stored; scrubbed from recordings") names manual redaction in M5-06 as the second half of the control; capture-time regexes (M5-01) are best-effort and cannot catch a customer name, a private URL or a novel token shape.
- `07-compliance-rules.md` "Data handling": "Recordings and DB are user-owned files; retention TTL and purge are user-controlled (M5-06)."
- G5: total recall is only usable if it is prunable and portable — source plan §13 lists "pin/tag/fork/resume/delete/purge · retention TTL · redaction · export/import mission bundles" as part of the history feature set.
- C10: purge, redaction and export all spend or destroy user data, so each is previewed, permissioned and audited.
- Unblocks M9-03 (audit/SIEM export reuses the bundle writer and its schema version) and M9-05 (retention must exist before recordings move to S3).

## 3. Scope
### In scope
- `RetentionPolicy` per artifact kind with TTL, `minKeep` and `action`; layered defaults in config, overridable per workspace (full editor is M8-02).
- `SweepRetention` use case with `--dry-run`, batching, pin/tag exemptions, audit rows and a `retention.swept` event.
- Manual redaction: select a range in the Timeline transcript or enter a literal → rewrite `messages.content`, `message_tool_calls.args_json`, matching `events.payload_json` and every `.cast` segment; FTS reindex via existing triggers; `redaction_audit` row with a SHA-256 of the removed text (never the plaintext).
- Session lifecycle actions: `pin`, `tag`, `fork`, `resume`, `delete` (soft), `purge` (hard) with previews and confirmations.
- Mission/session bundle: deterministic zip with `manifest.json{schemaVersion}`, JSON/JSONL parts, recordings, attachments, `checksums.txt`.
- `POST /history/exports`, `GET /history/exports/:id`, extended `POST /history/imports`; CLI `orch history export|import|sweep|redact`.
- Global disk-usage view (recordings + attachments + DB) on the History screen with "what would the sweeper remove" preview.
### Out of scope (deferred to …)
- Layered settings UI for retention policies (form + YAML + precedence) — deferred to M8-01/M8-02; this step ships config keys plus a single read-only panel.
- Hash-chained immutable audit and SIEM export formats — deferred to M9-03 (this step writes ordinary `audit_log` rows).
- S3/object-store lifecycle rules — deferred to M9-05 (`RecordingStore.remove` already abstracts it).
- Encryption at rest — deferred to M9-09.
- Cross-host bundle sync / registry publishing — deferred to M7-05 / M10-03.
- Automatic (policy-driven) redaction beyond M5-01's capture-time rules — not planned for 1.0; manual only.
- Resuming a *crashed* session's provider thread is implemented here as a thin action over `manifest.limits.resume`; richer recovery flows stay with M5-05.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `RetentionPolicy` value object: `{ kind: ArtifactKind, ttl: IsoDuration, minKeep: number, action: 'purge' | 'keep' }`. `ArtifactKind = 'recording' | 'attachment' | 'message' | 'event' | 'task_result' | 'restore_run' | 'telemetry_inbox'`.
- `SweepPlan`: `{ policyVersion, items: SweepItem[], totals: { rows, bytes }, dryRun }`; `SweepItem = { kind, id, sessionId?, ts, bytes, reason: 'ttl' | 'over_budget' }`.
- `RedactionRequest`: `{ targets: RedactionTarget[], literal?: string, scope: 'session' | 'mission' | 'global', reason: string }`; `RedactionTarget = { kind: 'message' | 'tool_call' | 'event' | 'recording', id, range?: { start: number; end: number } }`.
- `RedactionRecord`: `{ id, actorId, ts, scope, literalSha256, occurrences: { messages, toolCalls, events, castEvents }, reason, reversible: false }`.
- `SessionDisposition`: `{ pinnedAt?, tags: string[], deletedAt?, purgedAt?, forkedFromSessionId?, forkedAtTs? }`.
- `BundleManifest`: `{ schemaVersion, orchestraVersion, exportedAt, hostId, scope: 'session' | 'mission', rootIds: string[], parts: BundlePart[], counts: Record<string, number>, redactionRulesVersion, checksumAlgo: 'sha256' }`.
- Rules (pure, 100 % branch):
  - A pinned session is exempt from every TTL policy; `action:'keep'` on a kind disables sweeping for it entirely; `minKeep` always wins over `ttl` (the newest `minKeep` items of a kind per session are never swept).
  - Purge is only legal for a session in `stopped | crashed | failed` — never for `running | waiting_for_input` (a running session must be stopped first).
  - Soft delete hides rows from lists and search but leaves files and rows intact and is reversible; purge is irreversible and always writes an audit row.
  - Redaction never deletes a row or an asciicast event: it replaces text in place with `[REDACTED]` (plus the rule id when it came from a rule), preserving message ids, `seq`, asciicast event count and all timings.
  - `events` of kind `audit.*` are never redacted or swept by this step (M9-03 owns audit retention); their payloads are already redacted at write time (M0-04 serializer).
  - Import is idempotent: a bundle re-imported into the same DB inserts 0 rows, matched by `(sourceHostId, sourceId)` in `import_map`.
  - A bundle whose `schemaVersion` major differs from the daemon's is refused with `BundleSchemaUnsupported`; a lower minor is accepted with defaults for missing fields.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/retention/ (pure)
export function planSweep(inv: ArtifactInventory, policies: RetentionPolicy[], now: Iso8601): SweepPlan;
export function isExempt(a: ArtifactRef, disposition: SessionDisposition, policies: RetentionPolicy[]): boolean;

// packages/core/src/ports/history-admin-port.ts
export interface RecordingRewriter {                 // implemented in infrastructure/recorder
  /** Rewrites every segment of a recording in place (atomic temp+rename), replacing occurrences. */
  rewrite(recordingId: RecordingId, replace: Array<{ literal: string; with: string }>):
    Promise<Result<{ castEventsTouched: number; bytesBefore: number; bytesAfter: number }, HistoryError>>;
}
export interface BundleWriter { write(spec: ExportSpec, sink: WritableStream<Uint8Array>): Promise<Result<BundleManifest, HistoryError>>; }
export interface BundleReader { read(src: ReadableStream<Uint8Array>): Promise<Result<{ manifest: BundleManifest; parts: AsyncIterable<BundlePart> }, HistoryError>>; }
export type HistoryError = {
  code: 'SessionBusy' | 'NotFound' | 'BundleSchemaUnsupported' | 'BundleCorrupt' | 'ChecksumMismatch'
      | 'RedactionNotFound' | 'PolicyInvalid' | 'StoreIo' | 'Forbidden'; message: string };

// apps/daemon/src/application/history/ — one use case per class
export class SweepRetention   { execute(o: { dryRun: boolean; kinds?: ArtifactKind[] }): Promise<Result<SweepPlan, HistoryError>>; }
export class ApplyRedaction   { execute(r: RedactionRequest, actor: Actor): Promise<Result<RedactionRecord, HistoryError>>; }
export class SetDisposition   { execute(o: { sessionId: SessionId; pin?: boolean; addTags?: string[]; removeTags?: string[] }, actor: Actor): Promise<Result<SessionDisposition, HistoryError>>; }
export class ForkSession      { execute(o: { sessionId: SessionId; atTs?: Iso8601; model?: ModelId }, actor: Actor): Promise<Result<SessionId, HistoryError>>; }
export class ResumeSession    { execute(o: { sessionId: SessionId }, actor: Actor): Promise<Result<SessionId, HistoryError>>; }
export class DeleteSession    { execute(o: { sessionId: SessionId; hard: boolean }, actor: Actor): Promise<Result<void, HistoryError>>; }
export class ExportHistory    { execute(spec: ExportSpec, actor: Actor): Promise<Result<{ exportId: string; manifest: BundleManifest }, HistoryError>>; }
export class ImportHistory    { execute(o: { path: string; dryRun: boolean }, actor: Actor): Promise<Result<ImportReport, HistoryError>>; }
export interface ExportSpec { scope: 'session' | 'mission'; ids: string[]; include: { recordings: boolean; attachments: boolean; events: boolean; transcripts: boolean }; redactLiterals?: string[] }
export interface ImportReport { manifest: BundleManifest; inserted: Record<string, number>; skipped: Record<string, number>; warnings: string[] }
```

### 4.3 Data / schema changes
Migration `0055_retention_redaction` (extends `04-domain-model.md` §4):
- `sessions` add `pinned_at text null`, `deleted_at text null`, `purged_at text null`, `forked_from_session_id text null`, `forked_at_ts text null`, `origin text not null default 'local'` (`local|import`).
- `session_tags(session_id text, tag text, created_at text)` primary key `(session_id, tag)`; index `(tag)`.
- `retention_policies(kind text pk, ttl text not null, min_keep integer not null default 0, action text not null default 'purge', updated_at text)` — seeded from config on boot when empty.
- `redaction_audit(id text pk, ts text not null, actor_id text, scope text not null, literal_sha256 text not null, reason text, occurrences_json text not null, targets_json text not null)` — **never** stores the redacted text.
- `import_map(source_host_id text, source_kind text, source_id text, local_id text not null, imported_at text)` primary key `(source_host_id, source_kind, source_id)`.
- `history_exports(id text pk, created_at, scope, root_ids_json, path, bytes, schema_version, state)`.
- `recordings` add `redacted_at text null`, `sha256_after_redaction text null`; `messages.redacted` already exists (M5-02) and its update trigger already refreshes FTS (M5-03).
- New events: `retention.swept`, `retention.policy_changed`, `redaction.applied`, `session.pinned`, `session.tagged`, `session.forked`, `session.deleted`, `session.purged`, `history.exported`, `history.imported`.
- Config (Zod): `features.history.retention`, `features.history.export`, `history.retention.<kind>.{ttl,minKeep,action}` (defaults: recordings `P30D`/minKeep 3, attachments `P90D`, events `P365D`, messages `P365D`, `telemetry_inbox` `P7D` for `parsed` rows), `history.retention.sweepCron` (daily 03:30 local), `history.export.dir` (`~/.orchestra/exports/`), `history.export.maxBytes` (5 GB).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Sweeper**: a scheduled job (daemon lifecycle, not cron on the host) builds an `ArtifactInventory` with one indexed query per kind, calls the pure `planSweep`, and — when not a dry run — deletes in batches of 500 inside a transaction per batch: DB rows first (FTS triggers clean the index), then `RecordingStore.remove` / attachment unlink, then an `audit_log` row per batch. A crash mid-sweep leaves orphan files, so a `reconcileOrphans` pass at the start of every sweep removes files with no row (never the reverse — a row with no file is reported, not deleted).
- **Recording rewrite**: `AsciicastRewriter` streams the segment, parses each `["t","o",data]` event, applies literal replacements, writes to `NNN.cast.tmp` (`0600`), `fsync`, then `rename` over the original (atomic on the same filesystem); recomputes `sha256`. Event count, order and times are preserved exactly; the header is copied verbatim except for a `redacted: true` extension field. If a literal straddles two asciicast events, the rewriter joins the events' data in a sliding window (same carry-over bound as M5-01's redactor) and redistributes the replacement across the same event boundaries so timings survive.
- **Fork**: `git worktree add` (M1-03) from the commit selected at the fork moment (M5-04's `commitAt(ts)`), then a new session on the same provider/model; if `manifest.limits.fork` is true and the adapter exposes a native fork/resume flag, the launcher uses it with the stored `external_session_id`, otherwise the new session starts fresh with the transcript up to `atTs` attached as context (documented difference, shown in the confirm dialog — verify per-provider fork/resume flags against each vendor's docs at step start).
- **Resume**: only for `stopped|crashed` sessions whose manifest declares `limits.resume`; reuses the existing worktree and `external_session_id` and creates a new session row linked by `forked_from_session_id` with `forked_at_ts = null`.
- **Bundle format** (zip, deterministic order, no compression for `.cast` to keep diffs cheap):
  ```
  manifest.json          BundleManifest (schemaVersion semver, counts, checksums algo)
  sessions.json          missions.json  tasks.json  task_results.json
  reviews.json           review_findings.json  plan_versions.json  routing_decisions.json
  conversations/<sessionId>.jsonl     messages + tool calls + attachment refs, seq-ordered
  events.jsonl                        append-only events for the scope, ts-ordered
  recordings/<sessionId>/NNN.cast     segments (already redacted)
  attachments/<sha256>                content-addressed
  checksums.txt                       sha256 per part
  ```
  The writer streams every part through the same `Redactor` (M5-01) plus any `redactLiterals` from the spec, and **never** includes `config.yaml`, `~/.orchestra/token`, hook/MCP config files, provider auth status or env dumps (C3/C13). A contract test asserts the bundle contains no field matching `/token|secret|key|cookie|authorization/i` outside redacted placeholders.
- **Importer**: streams the zip, validates `manifest.json` with Zod and each part's checksum, remaps ids through `import_map` (new local ULIDs, original ids retained as `source_id`), inserts in dependency order inside one transaction per part, and restores recordings into `history.recordings.dir/<newSessionId>/`. Imported sessions get `origin='import'`, `state='stopped'` and are never re-attachable (M5-05 ignores them).
- No network access anywhere in this step; export/import are local files only.

### 4.5 API / UI surface
- `GET /history/retention` → policies + current usage; `PUT /history/retention` (guarded, audited) → update; `POST /history/sweep?dryRun=true|false` → `SweepPlan`.
- `POST /history/redactions` (`RedactionRequest`, Zod) → `RedactionRecord`; `GET /history/redactions?sessionId=` → audit list (no plaintext).
- `POST /sessions/:id/pin` · `DELETE /sessions/:id/pin` · `POST /sessions/:id/tags` · `DELETE /sessions/:id/tags/:tag`.
- `POST /sessions/:id/fork` `{ atTs?, model? }` · `POST /sessions/:id/resume` · `DELETE /sessions/:id` (soft) · `POST /sessions/:id/purge` (hard, requires `confirm: '<sessionId>'` in the body).
- `POST /history/exports` `{ scope, ids, include, redactLiterals? }` → `202 { exportId }`; `GET /history/exports/:id` → status; `GET /history/exports/:id/download` → `application/zip`; `POST /history/imports` accepts `{ bundlePath, dryRun }` (extends M5-02's importer with a `bundle` mode).
- CLI: `orch history export --session <id> | --mission <id> --out <file> [--no-recordings] [--redact <literal>]`, `orch history import --bundle <file> [--dry-run] [--json]`, `orch history sweep [--dry-run] [--kind recording]`, `orch history redact --session <id> --literal <text> --reason <text>`.
- Web:
  - Timeline toolbar (slot reserved in M5-04): **Redact** — select text in the transcript or type a literal → preview dialog listing occurrence counts per artifact, an explicit "this cannot be undone" warning and a required reason → apply → toast + banner "redacted N occurrences"; the player reloads the rewritten cast.
  - Session header: pin toggle, tag chips (typeahead), overflow menu → Fork from this moment · Resume · Export · Delete · Purge. Purge dialog requires typing the session's short id (C10 zero-surprise).
  - History screen: "Storage" panel (recordings / attachments / DB bytes, per-kind TTL, next sweep time) with a **Preview sweep** button showing the dry-run plan grouped by kind, and a "pinned sessions are never swept" note; tag filter chips added to the M5-03 filter bar.
  - States for every destructive action: idle → preview (counts + bytes) → confirming → applying (progress) → done/failed with typed `code`. All keyboard-reachable, RTL-safe.
- Audit: every mutating endpoint here goes through the M0-04 audit interceptor with `before/after` (redacted).

### 4.6 Flow / sequence
```
REDACT   select text ─▶ POST /history/redactions{targets, literal, scope, reason}
         ├─ find occurrences: messages, message_tool_calls, events(payload), recordings(segments)
         ├─ preview (dry) → counts + bytes → user confirms
         ├─ rewrite messages/tool calls/events (UPDATE → FTS triggers reindex)
         ├─ RecordingRewriter.rewrite per segment (temp + fsync + rename, sha256 recomputed)
         └─ redaction_audit row (literalSha256 only) + redaction.applied event + audit_log
SWEEP    cron ─▶ reconcileOrphans ─▶ planSweep(inventory, policies, now)
         ├─ dryRun → return plan (UI/CLI preview)
         └─ apply → batches of 500: rows → files → audit row ─▶ retention.swept
EXPORT   POST /history/exports ─▶ BundleWriter streams parts ─▶ redactor ─▶ zip + checksums.txt
         └─ history_exports row + history.exported event ─▶ GET …/download
IMPORT   orch history import --bundle ─▶ BundleReader ─▶ Zod(manifest) + checksums
         ├─ schemaVersion major mismatch → Err(BundleSchemaUnsupported)
         ├─ remap ids via import_map (skip if present) ─▶ insert per part in dependency order
         └─ restore recordings/attachments ─▶ history.imported ─▶ Timeline replays the imported session
PURGE    POST /sessions/:id/purge{confirm} ─▶ state check (not running) ─▶ delete rows (FTS follows)
         ─▶ RecordingStore.remove ─▶ attachments unlink ─▶ session.purged + audit_log
```

## 5. Tasks
- [ ] `packages/core/src/retention/`: `RetentionPolicy`, `planSweep`, `isExempt`, purge/soft-delete legality rules (100 % branch coverage).
- [ ] `packages/core/src/redaction/` additions: `RedactionRequest`/`RedactionRecord` value objects and occurrence-counting rules (reusing M5-01's rule types).
- [ ] Ports `RecordingRewriter`, `BundleWriter`, `BundleReader`, `HistoryError` union.
- [ ] Migration `0055_retention_redaction` + repositories (`session_tags`, `retention_policies`, `redaction_audit`, `import_map`, `history_exports`).
- [ ] `AsciicastRewriter` (streaming, event-count preserving, cross-event literal handling, atomic replace, sha256).
- [ ] `SweepRetention` with dry-run, batching, orphan reconciliation, audit rows, scheduled job registration.
- [ ] `ApplyRedaction` across messages, tool calls, event payloads and recordings; FTS refresh verified.
- [ ] `SetDisposition`, `ForkSession`, `ResumeSession`, `DeleteSession` (soft/hard) use cases with state-machine guards.
- [ ] `BundleWriter` / `BundleReader` (deterministic zip, checksums, schemaVersion, redaction pass, no-secrets contract test).
- [ ] `ExportHistory` / `ImportHistory` use cases with `import_map` idempotency and dry-run.
- [ ] HTTP controllers for retention, redaction, disposition, fork/resume/delete/purge, exports/imports + OpenAPI + Zod schemas.
- [ ] `orch history export|import|sweep|redact` in `apps/cli` (`--json` output).
- [ ] Web: Timeline redact flow, session header pin/tags/overflow actions, purge confirm dialog, History "Storage" panel with sweep preview, tag filter chips.
- [ ] Contract/e2e fixtures: a reference bundle `fixtures/history/bundle-v1.zip` used by import tests and kept as the schema-version regression fixture.
- [ ] Update `SECURITY.md` (redaction is best-effort at capture, authoritative when manual; bundles exclude credentials) and the M5 README exit-criteria checkboxes.
- [ ] Package README (`application/history`, `infrastructure/bundle`) + `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-06-01 | unit (fast-check) | `planSweep` over random inventories/policies incl. pinned sessions, `minKeep`, `action:'keep'` | pinned artifacts never planned; `minKeep` newest per session always kept; plan is deterministic and total; 100 % branch |
| UT-M5-06-02 | unit | purge/soft-delete legality for every session state | `running`/`waiting_for_input` → `Err(SessionBusy)`; soft delete reversible; purge always emits an audit intent |
| UT-M5-06-03 | unit | `AsciicastRewriter` on a cast where the literal straddles two `o` events | literal gone; event count, order and all timestamps identical; header preserved with `redacted:true` |
| UT-M5-06-04 | unit | `BundleManifest` schema-version gate | same major → accepted; lower minor → accepted with defaults; higher major → `Err(BundleSchemaUnsupported)` |
| IT-M5-06-01 | integration (sqlite + fs) | seed 3 sessions (1 pinned), TTL `P0D` on recordings; dry-run then apply | dry-run deletes nothing and lists only the 2 unpinned; apply removes rows + files, pinned untouched, `retention.swept` + audit rows present |
| IT-M5-06-02 | integration | redact a literal present in 2 messages, 1 tool-call arg, 1 event payload and 2 cast segments | all occurrences replaced; FTS search for the literal returns 0 hits and for `[REDACTED]` returns the rows; `redaction_audit` holds only the sha256; recordings' `sha256_after_redaction` updated |
| IT-M5-06-03 | integration | export a mission, wipe the DB, import the bundle; then import it again | first import restores all counts from the manifest; Timeline data (clock, lanes, diff-less) reconstructs; second import inserts 0 rows |
| IT-M5-06-04 | integration (negative) | corrupt one byte of a `.cast` part and of `checksums.txt` | `Err(ChecksumMismatch)` / `Err(BundleCorrupt)`; nothing partially inserted (transaction rolled back) |
| IT-M5-06-05 | integration | purge a session | rows gone from `sessions`, `messages`, `events`, `recordings`; FTS returns nothing; files removed; exactly one `session.purged` audit row; other sessions unaffected |
| AT-M5-06-01 | contract | bundle no-secrets scan over an export built from the FakeProvider secrets scenario (M5-01) | no field or file content matches `/token|secret|key|cookie|authorization/i` except `[REDACTED:*]` placeholders; `config.yaml`/`token` absent |
| E2E-M5-06-01 | e2e (Playwright + FakeProvider) | Timeline redact flow | preview shows occurrence counts, reason required, apply rewrites and the player reloads; search for the literal returns nothing |
| E2E-M5-06-02 | e2e | purge confirmation | purge blocked until the short id is typed; after purge the session is gone from History and Terminals |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-06-01 | TTL sweep with dry-run first | 1. Set `history.retention.recording.ttl=PT1M`, `minKeep=0`. 2. `orch history sweep --dry-run`. 3. `orch history sweep`. 4. Restore the config. | Dry-run lists the eligible recordings with bytes and removes nothing; the real run removes exactly those files, sets `recordings.state='purged'`, writes `retention.swept` and audit rows; History "Storage" panel usage drops accordingly | ⬜ |
| TC-M5-06-02 | Pinned session is never swept | 1. Pin a Claude session. 2. Repeat TC-01 with a TTL that would cover it. | The pinned session's recording, attachments and transcript are all untouched in both dry-run and apply; the panel shows "1 session pinned (exempt)" | ⬜ |
| TC-M5-06-03 | Manual redaction end-to-end (C13) | 1. In a real Claude session, `echo my-private-string-7719` (no capture rule matches it) and ask the agent about it. 2. Open Timeline, select the string in the transcript → Redact, give a reason. 3. Replay around that second. 4. Search the string in History. 5. `grep -rc 'my-private-string-7719' ~/.orchestra/recordings/<sid>/`. | Occurrence preview lists messages + cast events; after apply the player shows `[REDACTED]`, search returns 0 hits, grep prints `0`; `redaction_audit` row exists with a sha256 and the reason, and contains no plaintext | ⬜ |
| TC-M5-06-04 | Redaction preserves replay timing | 1. Note the player duration and the position of 3 lane markers before TC-03. 2. Compare after. | Duration identical, markers at the same seconds, no desync between player, transcript and events; `AsciicastRewriter` reports equal event counts before/after | ⬜ |
| TC-M5-06-05 | Pin, tag and filter | 1. Pin two sessions and tag them `spike` and `bugfix`. 2. Filter History by tag `spike`. | Tags persist across restart; filter chips work with search; pin state visible on the session header and in the Storage panel | ⬜ |
| TC-M5-06-06 | Fork from a moment | 1. Open Timeline for a finished Claude session; scrub to just before a bad edit. 2. Overflow → Fork from this moment. | Confirm dialog shows the commit that will be checked out and whether the provider supports native fork/resume; a new worktree + branch is created at that commit; the new session starts and is linked by `forked_from_session_id`; the original is untouched | ⬜ |
| TC-M5-06-07 | Resume a crashed session | 1. Produce a crashed session (M5-05 TC-05 or stop the pane). 2. Overflow → Resume. | Resume is offered only when the manifest declares `limits.resume`; the new session reuses the worktree and `external_session_id`; when unsupported the action is disabled with an explanation, not an error | ⬜ |
| TC-M5-06-08 | Soft delete then purge | 1. Soft-delete a Codex session. 2. Check History, search and the files. 3. Purge it with the confirm dialog. | After soft delete: hidden from lists and search, files and rows intact, action reversible ("undelete"); after purge: rows and files gone, search empty, exactly one `session.purged` audit row | ⬜ |
| TC-M5-06-09 | Purge refused for a running session (negative) | 1. Start a session. 2. Try `POST /sessions/:id/purge` from the CLI and the UI. | `409 SessionBusy` with a clear message; UI disables the action with a tooltip; nothing deleted | ⬜ |
| TC-M5-06-10 | Export → wipe → import → replay | 1. `orch history export --session <claudeSessionId> --out ~/s.zip`. 2. `unzip -l ~/s.zip`. 3. Start a second daemon with a temp DB. 4. `orch history import --bundle ~/s.zip`. 5. Open Timeline there. 6. Import the same bundle again. | Zip contains `manifest.json` (with `schemaVersion`), transcripts, events, recordings and `checksums.txt`; the import restores the session; the Timeline replays it with chat and events in sync (diff pane reports "worktree not available" — expected); second import inserts 0 rows | ⬜ |
| TC-M5-06-11 | Bundle carries no credentials (C3/C13) | 1. Export a session that ran `env` and a `curl` with an `Authorization` header. 2. `unzip -p ~/s.zip \| grep -iE 'token\|secret\|authorization\|ghp_\|sk-'`. | Only `[REDACTED:*]` placeholders appear; no `config.yaml`, no `token` file, no hook/MCP config inside the bundle | ⬜ |
| TC-M5-06-12 | Corrupt / future bundle (negative) | 1. Edit one byte inside the zip and import. 2. Bump `schemaVersion` major in a copy and import. | Case 1: `BundleCorrupt`/`ChecksumMismatch`, nothing inserted; Case 2: `BundleSchemaUnsupported` naming the supported range; both messages actionable, no stack traces | ⬜ |
| TC-M5-06-13 | Sweep interrupted by `kill -9` (resilience) | 1. Start a sweep over ≥ 2 GB of recordings. 2. `kill -9` the daemon mid-sweep. 3. Restart and re-run the sweep. | No half-deleted state that breaks the UI: rows with missing files are reported (not crashed on), orphan files are reconciled and removed on the next sweep, the Timeline of an unaffected session still replays | ⬜ |
| TC-M5-06-14 | Redaction while the session is running (resilience) | 1. In a live session, redact a string that was printed a minute ago. 2. Keep the agent working. | The active segment keeps recording (rewrite applies to closed segments; the active one is rotated first, then rewritten); no bytes lost, no `recording.gap` for a reason other than rotation; player reloads cleanly | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M5-06-01 … 14 pass on real Claude Code and Codex sessions.
- [ ] Dry-run precedes every destructive path (sweep, purge, redaction) and the preview counts match what is actually removed.
- [ ] Pinned sessions and `minKeep` are never violated by the sweeper (UT-01, TC-02).
- [ ] Manual redaction removes the literal from messages, tool-call args, event payloads, every recording segment and the FTS index, while preserving asciicast event count and timings (TC-03, TC-04, UT-03).
- [ ] `redaction_audit` never stores the redacted text; every destructive action has an `audit_log` row with actor, target and redacted before/after.
- [ ] Export bundles are reproducible, checksummed, schema-versioned and free of credentials (AT-01, TC-11); import is idempotent and transactional (IT-03, IT-04).
- [ ] `packages/core/src/retention` at 100 % branch coverage; no `fs` or `zip` usage outside `apps/daemon/src/infrastructure/**`.
- [ ] Milestone M5 exit criteria in `06-m5-history-replay/README.md` can be ticked (this is the last step of the milestone).
- [ ] No new lint / dependency-cruiser violations; OpenAPI, CLI help, `SECURITY.md` and package READMEs updated.

## 8. Risks / open questions
- Redaction is not forensic: the literal may survive in OS backups, Time Machine snapshots, the agent's own vendor-side session logs (outside `~/.orchestra/`) and any PR already opened. The confirm dialog and `SECURITY.md` must say so explicitly; we only guarantee Orchestra-owned artifacts.
- Vendor-owned session logs (e.g. Claude's projects JSONL) are the user's files but not ours; deleting or rewriting them is out of scope and would break the vendor CLI's own resume. The dialog offers a copy-paste command for the user to handle them instead (verify each provider's log location and resume dependency against vendor docs at step start).
- Rewriting an active recording races the recorder helper. Mitigation: rotate the active segment first, then rewrite closed segments only; TC-14 proves it, but the rotation adds an extra segment boundary to every live redaction.
- `fork`/`resume` semantics differ per provider (`manifest.limits.fork|resume`); a "fork" that cannot reuse the vendor thread is really a new session seeded with transcript context. The dialog must state which of the two is happening (verify per-provider flags at step start) — silently degrading would violate the truth-labelling principle.
- Zip determinism (entry order, timestamps, permissions) matters for reproducible bundles and for M9-03's audit export; fixed mtimes and sorted entries are required, which makes bundles non-identical to a plain `zip -r` — document it in the Plugin/Docs site.
- Deleting `events` rows conflicts with the append-only stance in `04-domain-model.md` §4 ("never deleted except retention purge"); the sweeper is that exception and must never delete `audit.*` events. A unit test asserts the exclusion.
- Very large exports (multi-GB recordings) can outrun the request lifetime; exports are therefore asynchronous with a download endpoint, and `history.export.maxBytes` refuses the rest — consider `--no-recordings` as the common default in docs.
- Import creates sessions that look real but can never be re-attached; M5-05's reconcile must skip `origin='import'` rows or it will report them as `pane_missing` crashes — covered by a test there and a note in this step's README update.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
