# Step M9-03 — Immutable audit log & SIEM export

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M9-01 |
| Estimated effort | 2 days |
| Packages touched | `packages/core` (`src/audit/`), `apps/daemon` (`src/application/audit`, `src/infrastructure/persistence`, `src/infrastructure/audit/sinks`, `src/infrastructure/egress`, `src/interface/http`), `apps/cli` (`orch audit`), `apps/web` (Settings → Audit, Health card), `packages/catalog` (`schemas/audit-export.schema.ts`) |
| Risk | High (an audit log that can be silently rewritten is worse than none) |
| Owner | |

## 1. Goal
Every mutating action — allowed or denied, by a user, an agent, a policy or the system — is written to an append-only, hash-chained `audit_log` that the database itself refuses to `UPDATE` or `DELETE`. `orch audit verify` walks the chain and reports `ok` with the head hash, or the exact `seq` where it breaks. `orch audit export` streams the log as JSONL validated against a published schema, and the daemon can additionally ship every entry live to a syslog (RFC 5424 over TLS) or webhook SIEM sink with at-least-once delivery and a durable spool. Retention purges old entries without breaking verification, because each purge leaves a signed anchor behind and is itself audited. A security reviewer can therefore answer "who did what, when, and was anything removed?" from the log alone.

## 2. Why
- C10 ("every spend/keys action previewed, permissioned, audited") is only half-satisfied by the M0-04 audit interceptor: rows exist but are mutable and never leave the host. This step finishes the control.
- M9-01 made the *actor* real (users, roles, denied attempts); without an immutable chain, a compromised Admin could erase their own denials.
- D8: the chain must work identically on SQLite and Postgres, because M9-05 swaps the driver underneath it. Hashing is done in the application, enforcement in the DB, so both dialects can satisfy it.
- G5 ("total recall"): audit is the one event class M5-06 explicitly refuses to sweep or redact — this step owns its retention instead.
- C2: SIEM egress (syslog/webhook) is user-configured egress and must go through the single allowlisted `infrastructure/egress` module introduced in M9-02, or the `no-vendor-endpoints` rule is being weakened rather than respected.
- C13 / C3: audit rows carry before/after images of settings and policies, which is exactly where a secret could leak; redaction must be part of the write path, not the reader.
- Prerequisite for M9-04 (gate decisions must be provably non-repudiable) and M9-09 (threat model treats the audit chain as a detection control).

## 3. Scope
### In scope
- `AuditEntry` domain type + pure `chainHash()` and `verifyChain()` in `packages/core/src/audit/` (100 % branch).
- Migration `0092_audit_chain`: `seq`, `prev_hash`, `hash`, `actor_*`, `outcome`, `reason`, `correlation_json`, plus append-only enforcement.
- Append-only enforcement in the DB: SQLite `BEFORE UPDATE`/`BEFORE DELETE` triggers raising unless a maintenance flag is set; Postgres equivalent (`BEFORE UPDATE OR DELETE` trigger + `REVOKE UPDATE, DELETE` from the app role) prepared here and activated by M9-05.
- Single write path `AppendAuditEntry` (serialised per host), replacing direct inserts from the M0-04 interceptor.
- Redaction of `before_json`/`after_json` at write time through the M5-01 `Redactor` plus a field-name deny list.
- Sinks: `jsonl-file` (rotating), `syslog` (RFC 5424, TCP+TLS, octet-counted framing), `webhook` (HTTPS POST, batched, HMAC-signed), all behind one `AuditSink` port with a durable spool and retry.
- `orch audit verify | export | tail | anchor | sinks status`; Settings → Audit screen; Health card `orchestra_audit_chain_ok`.
- Retention: `audit.retentionDays` with anchor-preserving purge, itself audited; `audit.retention: never` supported.
- Published export schema `audit-export.schema.ts` (+ generated JSON Schema) and `docs/deployment/audit.md`.
### Out of scope (deferred to …)
- Cryptographic signing of anchors with an external KMS/HSM key — deferred to M9-09 (which decides the key-management story); this step signs anchors with an HMAC key derived from a config secret.
- Shipping *logs* (pino) to a collector — that is M9-08's "structured logs shipping guidance".
- Postgres row-level security and the actual driver swap — M9-05.
- Gate-specific audit semantics (who approved what) — M9-04 emits into this log, but the gate model lives there.
- Anonymised community telemetry — M10-02, opt-in and unrelated.
- Tamper-evident *recordings* (asciicast hashing) — M9-09 decides whether to add `sha256` verification to M5-01's `recordings.sha256`.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `AuditEntry { seq, id, ts, actor: Actor, action, target: { kind, id? }, outcome: 'allowed'|'denied'|'error', reason?, permission?, before?, after?, correlation: { sessionId?, taskId?, missionId?, promptId?, gateId?, automationRunId? }, ip?, prevHash, hash }`.
- `seq` is a monotonically increasing integer per host (the chain order); `id` stays a ULID for cross-referencing with `events`.
- Pure rules (`packages/core/src/audit/chain.ts`, 100 % branch):
  - `canonicalise(entry)` → a deterministic byte string: JCS-style canonical JSON (sorted keys, no insignificant whitespace, numbers as shortest round-trip form, `undefined` fields omitted), covering every field **except** `hash`.
  - `chainHash(prevHash, entry) = sha256(prevHash ++ '\n' ++ canonicalise(entry))`, hex-encoded. The genesis entry uses `prevHash = '0'.repeat(64)`.
  - `verifyChain(entries, expectedStartHash)` → `Result<{ head, count }, ChainBroken>` where `ChainBroken = { seq, kind: 'hash_mismatch' | 'prev_mismatch' | 'seq_gap' | 'anchor_mismatch' }`. It walks in `seq` order, tolerates a **purge anchor** row (see below) that legitimately re-bases `prevHash`, and rejects any other gap.
  - Rule: an entry is immutable once written; the only legal shrink of the log is a purge that removes a contiguous prefix and replaces it with one anchor.
- `AuditAnchor { seq, coversFromSeq, coversToSeq, coveredCount, coveredHeadHash, createdAt, signature }` — written as a normal audit entry with `action: 'audit.anchor'` so it is itself chained; `signature = HMAC-SHA256(anchorKey, canonicalise(anchor))`.
- Rule: purge deletes entries with `seq ≤ coversToSeq` only after the anchor is committed in the same transaction; verification of a purged log starts from the anchor's `coveredHeadHash`.
- Rule: `outcome: 'denied'` entries are never purged before `audit.retentionDays × 2` (denials are the security-relevant half) — configurable, floor 30 days.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/audit/chain.ts (pure)
export function canonicalise(e: Omit<AuditEntry, 'hash'>): string;
export function chainHash(prevHash: string, e: Omit<AuditEntry, 'hash'>): string;
export type ChainBroken = { code: 'ChainBroken'; seq: number; kind: 'hash_mismatch' | 'prev_mismatch' | 'seq_gap' | 'anchor_mismatch' };
export function verifyChain(entries: Iterable<AuditEntry>, startHash: string): Result<{ head: string; count: number }, ChainBroken>;

// packages/core/src/audit/ports.ts
export interface AuditRepository {
  append(e: Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'>): Promise<Result<AuditEntry, AuditError>>;  // assigns seq+hashes in one tx
  head(): Promise<Result<{ seq: number; hash: string } | null, AuditError>>;
  readRange(from: number, to?: number, limit?: number): AsyncIterable<AuditEntry>;
  query(f: AuditFilter): Promise<Result<AuditPage, AuditError>>;
  purgeThrough(seq: number, anchor: AuditAnchor): Promise<Result<{ removed: number }, AuditError>>;   // one tx, maintenance flag set
}
export interface AuditSink {                       // DI strategy map keyed by id — no switch
  readonly id: 'jsonl-file' | 'syslog' | 'webhook';
  deliver(batch: readonly AuditEntry[]): Promise<Result<void, SinkError>>;
  health(): Promise<Result<{ ok: boolean; lastDeliveredSeq: number; pending: number }, SinkError>>;
}
export type AuditError = { code: 'AppendFailed' | 'ImmutabilityViolation' | 'HeadMissing' | 'StoreIo'; message: string };
export type SinkError  = { code: 'Unreachable' | 'Rejected' | 'TlsFailed' | 'EgressBlocked' | 'SpoolFull'; message: string; retryable: boolean };

// apps/daemon/src/application/audit/ — one use case per class
export class AppendAuditEntry { execute(i: AuditInput): Promise<Result<AuditEntry, AuditError>>; }
export class VerifyAuditChain { execute(o?: { from?: number; to?: number }): Promise<Result<{ head: string; count: number }, ChainBroken | AuditError>>; }
export class ExportAudit      { execute(spec: ExportSpec, actor: Actor): Promise<Result<AsyncIterable<string>, AuditError>>; }
export class PurgeAudit       { execute(o: { olderThanDays: number; dryRun: boolean }, actor: Actor): Promise<Result<{ removed: number; anchor: AuditAnchor }, AuditError>>; }
export class FlushAuditSpool  { execute(): Promise<Result<{ delivered: number; pending: number }, SinkError>>; }
```
`AuditInput` is Zod-validated at the edge; `before`/`after` pass the redactor before hashing, so the hash covers exactly what is stored (a reader can never claim "the original had more").

### 4.3 Data / schema changes
Migration `0092_audit_chain` (extends the `audit_log` baseline from `04-domain-model.md` §4; the baseline had only `id, ts, user_id, action, target, before_json, after_json, ip`):
- Add `seq integer not null unique` (SQLite: `AUTOINCREMENT`-free — assigned by `max(seq)+1` inside the append transaction; Postgres: same, not a sequence, so gaps cannot appear), `actor_kind text`, `actor_id text`, `actor_roles_json text`, `outcome text not null default 'allowed'`, `reason text null`, `permission text null`, `correlation_json text`, `prev_hash text not null`, `hash text not null unique`, `redaction_rules_version text not null`.
- Indices: `(ts)`, `(actor_id, ts)`, `(action)`, `(outcome)`, `(target)`; `seq` is the clustering/ordering key.
- New table `audit_spool (id text pk, seq integer, sink_id text, attempts integer, next_attempt_at text, last_error text null, unique(seq, sink_id))` — the durable at-least-once queue.
- New table `audit_anchors (seq integer pk, covers_from_seq integer, covers_to_seq integer, covered_count integer, covered_head_hash text, created_at text, signature text)` (mirror of the anchor entry, for fast verification start).
- Append-only enforcement (SQLite):
  ```sql
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  WHEN (SELECT value FROM orch_maintenance WHERE key='audit_maintenance') IS NOT 'on'
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  -- same shape for BEFORE DELETE
  ```
  `orch_maintenance` is a one-row-per-key table; the flag is set and cleared **inside** `purgeThrough`'s transaction and nowhere else (an architecture test greps for other writers). Postgres variant (activated by M9-05): a `BEFORE UPDATE OR DELETE` trigger function checking `current_setting('orchestra.audit_maintenance', true)`, plus `REVOKE UPDATE, DELETE ON audit_log FROM orchestra_app`.
- Config:

| Key | Type | Default | Notes |
|---|---|---|---|
| `audit.enabled` | boolean | `true` | cannot be `false` when `auth.mode: team` (boot assertion) |
| `audit.retentionDays` | number \| `'never'` | `'never'` | purge is opt-in |
| `audit.deniedRetentionDays` | number | `max(retentionDays*2, 30)` | |
| `audit.anchorKeyEnv` | string | `ORCH_AUDIT_ANCHOR_KEY` | HMAC key source; secrets never in `config.yaml` |
| `audit.sinks[]` | `{ id, enabled, ... }` | `[]` | per-sink options below |
| `audit.spool.maxEntries` | number | `100000` | `SpoolFull` ⇒ Attention item, never drop silently |
| `audit.sinks[].syslog` | `{ host, port, tls: { caFile?, rejectUnauthorized }, facility, appName }` | — | RFC 5424, octet-counted framing |
| `audit.sinks[].webhook` | `{ url, hmacSecretEnv, batchSize, timeoutMs }` | — | `X-Orch-Signature: sha256=<hex>` over the body |
| `audit.sinks[].jsonlFile` | `{ dir, maxBytes, maxFiles }` | — | 0600 files, 0700 dir |

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No tmux/git. `AppendAuditEntry` runs behind a per-process async mutex so `seq` assignment and hashing are serialised; the DB unique constraints on `seq` and `hash` are the second line of defence (two daemons on one DB is refused by the single-instance lock from M0-04 and, in Kubernetes, by the `Recreate` strategy in M9-06).
- Write ordering: the audit row is committed in the **same transaction** as the action's own state change where the action already runs in a transaction; otherwise it is committed immediately before the response is returned (the M0-04 interceptor's position). Denials are written by the guard, so they never depend on the handler.
- Sinks run in a background `AuditShipper` service: it reads `audit_spool` in `seq` order, batches up to `batchSize`, calls `AuditSink.deliver`, and on success deletes the spool rows. Backoff `1s, 2s, 4s … 5m` with full jitter; a sink that fails for `> 15 min` raises an Attention item `platform.audit_sink_down` and sets `orchestra_audit_sink_up{sink=...} = 0` (M9-08).
- Syslog sink: TCP + TLS via `node:tls` through the egress allowlist; message is `<PRI>1 <ts> <hostname> orchestrad <pid> <msgid> [orchestra@<pen> seq="…" hash="…"] <json>` with octet-counted framing (`<len> <msg>`); structured-data escaping per RFC 5424 §6.3.3. UDP is deliberately not offered (loss is indistinguishable from tampering).
- Webhook sink: HTTPS POST of a JSONL body through the egress module, `X-Orch-Signature` HMAC and `X-Orch-Batch-Range: <fromSeq>-<toSeq>` so the receiver can detect gaps; 2xx ⇒ delivered, 4xx (non-429) ⇒ `Rejected` and the batch is parked with an Attention item (never silently dropped), 5xx/429 ⇒ retry.
- Egress: sink hosts are added to the `infrastructure/egress` allowlist from config at boot (same module as M9-02). No sink may target a vendor host — a boot assertion checks sink hosts against the `BinaryRegistry`/manifest vendor domains and refuses to start (keeps C2 honest).
- `jsonl-file` sink writes `~/.orchestra/audit/audit-YYYYMMDD-NN.jsonl` (0600) with size rotation; in the container (M9-06) it points at the PVC.

### 4.5 API / UI surface
- `GET /audit?from&to&actorId&action&outcome&cursor&limit` → `AuditPage` — `@RequirePermission('audit.read')`.
- `GET /audit/verify?from&to` → `{ ok, head, count } | { ok: false, seq, kind }` — `audit.read`.
- `GET /audit/export?format=jsonl&since&until` → streamed `application/x-ndjson`, `@RequirePermission('audit.export')` (Admin only per the M9-01 matrix); the export itself is audited with the row count and filter.
- `GET /audit/sinks` → per-sink health; `POST /audit/sinks/:id/flush` → `automation.manage`-free, requires `audit.export`.
- `POST /audit/purge` `{ olderThanDays, dryRun }` → `audit.export` **and** `user.manage` (Admin-only in practice); returns the anchor.
- WS topic `audit` (Admin/Lead only, filtered by `VisibilityFilter` from M9-01): new entries for a live tail in Settings → Audit.
- Web: **Settings → Audit** — filter bar (actor, action, outcome, date range), virtualised table, a row drawer showing redacted before/after as a diff, a "Chain: ok · head `abc123…`" status chip that turns into a `status-blocked` chip with the broken `seq` when verification fails, an Export button (format + range), and a Sinks panel with per-sink last-delivered seq and pending count. **Health screen** (M6-07) gains an "Audit chain" card with the same state and a "Verify now" action.
- CLI: `orch audit verify [--from N] [--json]`, `orch audit export --format jsonl [--since 24h] [--out FILE]`, `orch audit tail [--follow]`, `orch audit anchor --older-than 90d [--dry-run]`, `orch audit sinks status`. All support `--json` per M7-06.

### 4.6 Flow / sequence
```
guard/interceptor/use case
  → AppendAuditEntry(input)
      redact(before, after) → canonicalise → prevHash = head().hash → hash = chainHash(prev, e)
      BEGIN; INSERT audit_log(seq = max+1, …, prev_hash, hash);
             INSERT audit_spool(seq, sink_id) per enabled sink; COMMIT
      → publish ws 'audit' delta
AuditShipper (interval 1s)
  → read spool ordered by seq → batch → sink.deliver → on ok DELETE spool rows
  → on retryable error: attempts++, next_attempt_at = now + backoff
  → on 15 min down: Attention 'platform.audit_sink_down' + metric 0

orch audit verify
  → latest anchor (or genesis) → readRange(anchor.coversToSeq+1 … head) → verifyChain
  → ok  ⇒ print "ok (n=…, head=…)"      exit 0
  → err ⇒ print "BROKEN at seq N (hash_mismatch)" exit 4 ; emit doctor.drift_detected{kind:'audit_chain'} (M6-02 case)

PurgeAudit(olderThanDays)
  → compute cutoff seq (respecting deniedRetentionDays)
  → BEGIN; build anchor{coveredHeadHash = hash at cutoff}; INSERT audit_anchors;
           AppendAuditEntry(action:'audit.anchor') (chained normally);
           SET orch_maintenance.audit_maintenance='on'; DELETE FROM audit_log WHERE seq <= cutoff;
           CLEAR flag; COMMIT
  → verify from anchor → must be ok, else ROLLBACK
```

## 5. Tasks
- [ ] `packages/core/src/audit/`: `AuditEntry`, `canonicalise`, `chainHash`, `verifyChain`, `AuditAnchor`; property tests (fast-check) that canonicalisation is stable across key order and unicode; 100 % branch.
- [ ] Migration `0092_audit_chain`: columns, indices, `orch_maintenance`, SQLite triggers, `audit_spool`, `audit_anchors`; Postgres trigger + grant script staged for M9-05.
- [ ] `KyselyAuditRepository` (append with serialised `seq`, `readRange` as an async iterable, `query`, `purgeThrough`) + in-memory twin + shared contract spec.
- [ ] Rewire the M0-04 audit interceptor and the M9-01 guards to the single `AppendAuditEntry` write path; grep test proves no other `INSERT INTO audit_log`.
- [ ] Write-time redaction: reuse `createStreamingRedactor` (M5-01) over `before`/`after` plus a field-name deny list (`token|secret|password|apiKey|authorization|cookie|clientSecret`), record `redaction_rules_version`.
- [ ] `AuditSink` port + `JsonlFileSink`, `SyslogSink` (RFC 5424 + TLS), `WebhookSink` (HMAC, batch range header); DI strategy map.
- [ ] `AuditShipper` background service: spool reader, batching, backoff with jitter, sink health, Attention item on prolonged failure, `SpoolFull` handling.
- [ ] Use cases `VerifyAuditChain`, `ExportAudit`, `PurgeAudit`, `FlushAuditSpool`; export schema `packages/catalog/schemas/audit-export.schema.ts` + generated JSON Schema artifact.
- [ ] HTTP routes `/audit*` with permissions from the M9-01 matrix; WS `audit` topic with visibility filtering.
- [ ] `orch audit verify|export|tail|anchor|sinks status` with `--json` and documented exit codes.
- [ ] Web: Settings → Audit (filters, table, drawer diff, chain chip, sinks panel, export dialog) + Health "Audit chain" card; EN/AR.
- [ ] Retention wiring: register `audit` with the M5-06 sweeper as `action: 'keep'` so the generic sweeper never touches it; schedule `PurgeAudit` from `audit.retentionDays`.
- [ ] Boot assertions: `audit.enabled` in team mode, anchor key present when retention is numeric, no sink host matching a vendor domain.
- [ ] Docs `docs/deployment/audit.md`: field reference, chain math, verification procedure for an auditor, sink setup (rsyslog/Splunk HEC-style webhook/Elastic), purge semantics, what "immutable" does and does not promise.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-03-01 | unit | `canonicalise` stability: same entry with shuffled keys, unicode NFC/NFD, `undefined` vs missing fields | identical bytes; property test over 1 000 generated entries |
| UT-M9-03-02 | unit | `verifyChain` on: clean chain, flipped byte in `after_json`, deleted middle row, reordered `seq`, valid anchor re-base | `ok` / `hash_mismatch` / `seq_gap` / `prev_mismatch` / `ok`; 100 % branches |
| UT-M9-03-03 | unit | redaction before hashing: an entry whose `after` contains `sk-ant-…` | stored and hashed value contains `[REDACTED:anthropic-key]`; the raw value appears nowhere |
| AT-M9-03-01 | application | 500 concurrent `AppendAuditEntry` calls | `seq` is dense 1…500, every `prevHash` links, no duplicate hash |
| AT-M9-03-02 | application | `PurgeAudit` dry-run then real, with denials inside the window | dry-run removes 0; real keeps denials younger than `deniedRetentionDays`; anchor written; `verifyChain` ok afterwards |
| IT-M9-03-01 | integration | direct `UPDATE audit_log SET action='x'` and `DELETE FROM audit_log` via the raw driver | both raise `audit_log is append-only`; row count unchanged |
| IT-M9-03-02 | integration | syslog sink against a local RFC 5424 TLS listener; kill the listener for 30 s mid-stream, restart it | zero entries lost, order preserved, duplicates allowed (at-least-once) and detectable by `seq`; spool drains |
| IT-M9-03-03 | integration | webhook sink returns 500 ×3 then 200; then returns 400 once | retries with backoff then delivers; the 400 batch is parked and raises `platform.audit_sink_down`, spool not dropped |
| IT-M9-03-04 | integration | `ExportAudit` of 10 000 entries | streams as NDJSON, every line validates against `audit-export.schema.json`, memory stays < 100 MB, export itself audited |
| E2E-M9-03-01 | e2e | Playwright: Viewer denied `session.start` → Admin opens Settings → Audit, filters `outcome=denied`, sees the row and the chain chip `ok` | UI shows actor, permission, reason; "Verify now" returns ok |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-03-01 | Chain over a real day of work | 1. Run the M8 demo end to end in team mode. 2. `orch audit verify --json`. 3. `orch audit export --format jsonl --since 24h > /tmp/a.jsonl`. 4. `wc -l /tmp/a.jsonl` and compare with the reported `count`. | `ok` with a head hash; line count equals `count`; every line validates against the published schema (`ajv validate`); actions cover session start/stop, prompt answer, delegate, merge, settings edit. | ⬜ |
| TC-M9-03-02 | Negative: tampered row | 1. `sqlite3 ~/.orchestra/orchestra.db "UPDATE audit_log SET action='benign' WHERE seq=(SELECT max(seq)-5 FROM audit_log)"`. 2. Retry with the maintenance flag set manually. 3. `orch audit verify`. 4. Open Health. | (1) fails with `audit_log is append-only` and changes nothing; (2) succeeds (that is the documented escape hatch) and (3) reports `BROKEN at seq N (hash_mismatch)` with exit code 4; Health shows a `status-blocked` Audit chain card; `orchestra_audit_chain_ok` = 0. | ⬜ |
| TC-M9-03-03 | Negative: denied action is recorded and cannot be erased | 1. As Viewer, force `POST /sessions` with curl (403). 2. As Admin, try to delete that row with `DELETE FROM audit_log WHERE outcome='denied'`. 3. `orch audit purge --older-than 0d --dry-run`. | The denial row exists with permission `session.start` and reason `no_grant`; the DELETE is refused by the trigger; the purge dry-run reports it as retained because of `deniedRetentionDays`. | ⬜ |
| TC-M9-03-04 | SIEM delivery to a real collector | 1. Start `rsyslog` (or `syslog-ng`) with TLS in Docker. 2. Configure the syslog sink and restart the daemon. 3. Generate 200 actions. 4. Stop the collector for 60 s during generation, restart it. | All 200 entries arrive with `seq` and `hash` in the structured data; the gap is filled after the collector returns; `orch audit sinks status` shows `pending: 0` and a `lastDeliveredSeq` equal to the head. | ⬜ |
| TC-M9-03-05 | Purge with anchor | 1. Seed ≥ 10 000 entries (`orch dev seed-audit`). 2. `orch audit anchor --older-than 7d --dry-run` then for real. 3. `orch audit verify`. 4. Inspect `audit_anchors`. | Purge removes the expected prefix, writes one anchor entry and one `audit_anchors` row, and is itself in the log; verification starts from the anchor and reports `ok`; the anchor's HMAC validates with the configured key. | ⬜ |
| TC-M9-03-06 | Resilience: kill -9 during a burst | 1. Start a load script writing 50 audit-generating actions/s. 2. `kill -9` the daemon mid-burst. 3. Restart and run `orch audit verify`. 4. Check `audit_spool`. | No partial row (append is transactional); the chain verifies with no gap; the spool still holds undelivered entries and drains after restart with no loss and no reordering. | ⬜ |
| TC-M9-03-07 | Secrets never land in the log | 1. Edit a policy whose value contains `ghp_` and `sk-ant-` shaped strings. 2. Answer a prompt whose payload contains a JWT. 3. `orch audit export --since 1h \| grep -E 'ghp_\|sk-ant-\|eyJ'`. | Zero matches; the corresponding rows show `[REDACTED:<ruleId>]`; `redaction_rules_version` is recorded on each row. | ⬜ |
| TC-M9-03-08 | Export for an auditor | 1. `orch audit export --format jsonl --since 30d --out audit.jsonl`. 2. Hand `audit.jsonl` + `docs/deployment/audit.md` to a reviewer (yourself, using the doc only). 3. Follow the doc's verification procedure offline. | The reviewer can recompute every hash from the file alone and confirm the head, without access to the daemon. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `audit_log` rejects `UPDATE`/`DELETE` at the database level; the only bypass is the maintenance flag set inside `purgeThrough`, and an architecture test proves no other code sets it.
- [ ] `chainHash`/`verifyChain` are pure with 100 % branch coverage and a passing canonicalisation property test.
- [ ] `AppendAuditEntry` is the single write path (grep test), covers allowed *and* denied outcomes, and redacts before hashing.
- [ ] `orch audit verify` reports `ok` with a head hash on a ≥ 10 000-entry log and pinpoints the `seq` of a tampered row (TC-M9-03-02).
- [ ] Syslog and webhook sinks deliver 100 % of entries at least once across a collector outage, with a durable spool and no silent drops (IT-M9-03-02/03, TC-M9-03-04).
- [ ] Exported JSONL validates against the published `audit-export.schema.json` and is independently verifiable offline (TC-M9-03-08).
- [ ] Retention purge preserves verifiability via signed anchors, keeps denials for at least 30 days, and audits itself.
- [ ] All SIEM egress goes through `infrastructure/egress`; a sink host matching a vendor domain fails boot (C2 intact).
- [ ] All TC-M9-03-* pass and are recorded.
- [ ] No new lint/arch violations; `docs/deployment/audit.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- Append-only triggers with a maintenance flag are *tamper-evident*, not tamper-proof: anyone with write access to the DB file can still rewrite the chain from the break forward if they also hold the anchor key. The honest promise — "detectable unless the attacker also controls the anchor key and every shipped copy" — must be stated plainly in the docs; real non-repudiation needs the external sink or a KMS-signed anchor (M9-09 decides).
- Canonical JSON is a classic source of cross-language mismatches. JCS (RFC 8785) is the intended reference; confirm the chosen implementation (or hand-rolled canonicaliser) matches it for floats and unicode escapes, or state a locally defined canonicalisation in the docs instead (verify).
- Per-entry SHA-256 plus a serialised append could bound write throughput. Budget: ≥ 500 appends/s on the dev machine; measure in AT-M9-03-01 and, if short, batch `seq` assignment rather than parallelise hashing.
- SQLite triggers cannot be enforced against a process that opens the DB file directly with `PRAGMA writable_schema` or simply drops the trigger. Postgres (M9-05) is the stronger story via `REVOKE`; document the difference honestly.
- `audit_spool` and `audit_anchors` and the extra `audit_log` columns are not in `04-domain-model.md` §4 — the domain model doc needs an update (not done here).
- Ordering guarantee across a restart: entries are chained by `seq`, but a sink may see duplicates after a crash between delivery and spool deletion. At-least-once is the documented contract; a SIEM that cannot dedupe on `seq` will double count (verify with the first real collector).
- RFC 5424 message size: some collectors truncate above 8 KB. Large `before/after` diffs must be truncated with `truncated: true` in the syslog projection while the full row stays in the DB and the JSONL export (verify the collector's limit before choosing the cap).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
