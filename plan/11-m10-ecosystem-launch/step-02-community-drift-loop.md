# Step M10-02 — Community drift loop

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M6-02, M6-03, M10-03, M8-01, M8-08 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon`, `apps/web`, `apps/cli`, `docs/` |
| Risk | High (privacy; this is the only feature that sends anything off the host) |
| Owner | |

## 1. Goal
A user can turn on **Share anonymised drift reports** in Settings › Privacy (default **off**). When it is on and the drift classifier opens a `RepairCase`, the daemon builds a `DriftReport` — provider, CLI version, manifest version, drift kind, a hash of the failing fixture, signal-kind counts, daemon version, coarse platform — with no file paths, no code, no prompts, no repository names, no session/task/user ids, and no stable installation identifier. The report is shown verbatim in a preview dialog the first time, queued in a local outbox the user can inspect and purge, and POSTed to the one configured registry host. The registry aggregates reports per `(provider, cliVersion, manifestVersion, driftKind)` and marks that manifest version **stale** in the signed index; every daemon that refreshes the index then sees the stale flag, shows "known issue, fix in preparation" in Health instead of raising a fresh case storm, and picks up the corrected manifest through M6-03 as soon as maintainers publish it. With the toggle off, the daemon opens zero outbound connections for this feature — proven by the egress test.

## 2. Why
- **D6** and source plan §10.3 rung 4: "community loop (opt-in, anonymised): drift reports per CLI version → registry marks manifests stale → maintainers notified → fix propagates to everyone". Rungs 1–3 fix *one* host; rung 4 is what makes a vendor change cost the ecosystem one fix instead of N.
- **G6** — "vendor changes surfaced as actionable items": a stale marker turns one user's 03:00 breakage into everyone else's pre-emptive warning.
- **G7 / D5** — the registry is the distribution channel for the resulting manifest, so the loop closes without an app release.
- **C13 / `07-compliance-rules.md` "Data handling"**: "Everything stays on the user's infra. No telemetry leaves the host unless the user opts into anonymised drift/outcome sharing (M10-02)." This step is the *only* implementation of that sentence, so it must be conservative enough that the sentence stays true in spirit.
- **C2** — the report endpoint is on the already-allowlisted registry host under a new `EgressReason`; no vendor host is ever contacted, and the report never contains vendor payloads.
- **D10 / ADR-001**: an open-source project asking for telemetry must be able to show exactly what it sends; the preview dialog and `orch drift report show` are that proof.

## 3. Scope
### In scope
- `DriftReport` schema (Zod, versioned) + `DriftReportSanitizer` (pure, deny-by-construction allowlist of fields and value shapes).
- `privacy.shareDriftReports` setting (default `false`), first-send preview dialog, revocation, audit rows for every toggle.
- Outbox store (`~/.orchestra/drift-reports/`), batching, rate limit, retry with backoff, offline tolerance, TTL purge.
- `DriftReportUploader` port + HTTP implementation reusing M6-03's hardened client and `EgressPolicy` (new reason `drift-report`).
- Consumption of `stale` / `staleSince` / `reportCount` / `advisory` on index entries; Doctor + Health behaviour when a manifest is known-stale; suppression of duplicate case noise.
- `orch drift report list|show|purge|send-now` CLI; Health "Community" panel; Settings privacy panel copy (EN + AR).
- Privacy review artifact: `docs/security/drift-reports.md` with the exact field list, the threat/linkability analysis and the retention statement; a test that fails if a field is added without updating it.
### Out of scope (deferred to …)
- The registry **service** that receives, aggregates and publishes staleness — defined as a contract here, implemented in M10-03 (its fixture registry serves the endpoint for tests).
- Maintainer-side notification routing (issue creation, Discord) — operational runbook in M10-07; this step only defines the aggregate the registry exposes.
- Sharing **outcomes** / scorecard data — already opt-in and separate (M8-06 `orch outcomes export --anonymised`); it must not be coupled to this toggle.
- Sending fixtures, payload bodies, `--help` output or diffs — never; the Repair Agent (M10-01) keeps those local.
- Any automatic enablement, nag, or bundling with another consent — forbidden by acceptance criteria.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/maintenance/community/{drift-report.ts, report-sanitizer.ts, outbox-policy.ts}` — pure, `Clock` injected.

Rules:
- **P1 Allowlist, not denylist.** `sanitize()` builds a *new* object from a fixed field list. Anything not enumerated cannot reach the wire, so adding a field to `RepairCase` can never leak it.
- **P2 No free text.** Every string field is either an enum, a semver, a lowercase hex hash, or an ISO date truncated to the hour. `evidenceKey` (a schema id / type name / model id) is hashed, never sent raw.
- **P3 No stable identity.** There is no installation id. The only correlation token is `dedupeToken = sha256(installSecret || fingerprint || YYYY-MM-DD)[0..16]` — rotates daily, unlinkable across days, lets the registry count *distinct hosts per day* without recognising one across days. `installSecret` is a local random 32-byte value in `~/.orchestra/` (0600) that is never sent.
- **P4 Coarse everything.** `platform` ∈ `darwin | linux | win32`; no arch, no OS version, no locale, no timezone, no hostname. Timestamps truncated to the hour, UTC.
- **P5 Threshold.** A report is only *created* for a case with `confidence ≥ 0.5` and `kind ≠ 'unknown'`; `unknown` drifts are too shapeless to be useful and too descriptive to be safe.
- **P6 One report per fingerprint per day.** Repeats increment a local counter and are dropped; the registry sees at most one row per host per fingerprint per day (`dedupeToken`).
- **P7 Revocation is immediate.** Turning the toggle off deletes the outbox and stops the scheduler before the settings write returns. Nothing already sent can be recalled — the UI copy says so.
- **P8 Size cap.** A serialized report > 2 KB is a bug; the sanitizer returns `Err(OversizeReport)` and the case is logged locally only.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/community/drift-report.ts  (public: the registry implements the other end)
export interface DriftReport {
  schemaVersion: 1;
  reportId: string;                     // ULID, generated per report, never reused, not derived from anything local
  dedupeToken: string;                  // 16 hex chars, see P3 — rotates daily
  provider: ProviderId;                 // 'claude' | 'codex' | 'agy' | 'kimi' | 'opencode' | third-party plugin id
  pluginId?: string;                    // npm name for third-party providers, e.g. 'orchestra-provider-demo'
  cliVersion: string;                   // semver as reported by the CLI's --version
  manifestVersion: string;              // semver of the manifest that was active
  manifestSource: 'bundled' | 'registry' | 'local-override';
  driftKind: DriftKind;                 // M6-02 union, minus 'unknown' (P5)
  confidence: number;                   // 0..1, two decimals
  evidenceHash: string;                 // sha256(evidenceKey) hex — schema id / event type / model id, hashed
  fixtureHash: string | null;           // sha256 of the failing fixture FILE CONTENT as shipped in the plugin (public data)
  signalCounts: Partial<Record<SignalKind, number>>;   // counts only
  ladderOutcome: 'auto_failed' | 'registry_failed' | 'assisted_proposed' | 'needs_human';
  daemonVersion: string;                // semver
  platform: 'darwin' | 'linux' | 'win32';
  observedAtHour: string;               // '2026-09-14T21:00:00Z' — truncated to the hour, UTC
}

// POST {registryUrl}/v1/drift-reports    Content-Type: application/json
// Body: { reports: DriftReport[] }  (≤ 20 per batch, ≤ 32 KB)
// 202 { accepted: number, rejected: { reportId: string, reason: string }[] }
// 400 malformed · 413 too large · 429 { retryAfterMs } · 5xx → retry with backoff
// No auth header, no cookies, no user agent beyond `orchestrad/<version>`.

// index extension consumed here (published by M10-03, signed as part of the M6-03 index envelope)
export interface RegistryIndexStaleness {
  stale?: boolean; staleSince?: string; reportCount?: number;   // distinct dedupeTokens, bucketed: 1-5 | 6-20 | 20+
  advisory?: { id: string; summary: string; url: string; fixedInManifestVersion?: string };
}

// packages/core/src/maintenance/community/report-sanitizer.ts  (pure, 100 % branch)
export type SanitizeError =
  | { code: 'NotShareable'; reason: 'unknown-kind' | 'low-confidence' | 'third-party-optout' }
  | { code: 'OversizeReport'; bytes: number }
  | { code: 'ForbiddenValue'; field: string; detail: string };   // e.g. a value containing '/', '\\', '@', or > 64 chars
export declare function buildDriftReport(c: RepairCase, ctx: ReportContext): Result<DriftReport, SanitizeError>;

// apps/daemon/src/application/ports/community.ports.ts
export interface DriftReportOutbox {
  enqueue(r: DriftReport): Promise<Result<{ queued: boolean; deduped: boolean }, StorageError>>;
  take(max: number): Promise<Result<DriftReport[], StorageError>>;
  ack(ids: string[]): Promise<Result<void, StorageError>>;
  list(): Promise<Result<{ report: DriftReport; queuedAt: string; attempts: number }[], StorageError>>;
  purge(): Promise<Result<{ removed: number }, StorageError>>;
}
export interface DriftReportUploader {          // implemented over M6-03's HttpRegistryClient transport
  send(batch: DriftReport[]): Promise<Result<{ accepted: number }, UploadError>>;
}
export type UploadError = { code: 'Unreachable' } | { code: 'Rejected'; status: number }
  | { code: 'RateLimited'; retryAfterMs: number } | EgressDenied;
```
Use cases (`apps/daemon/src/application/community/`): `MaybeQueueDriftReport` (subscriber on `doctor.case_classified` / ladder-exhausted events), `FlushDriftReports` (scheduler + `send-now`), `SetDriftSharing` (audited settings mutation + outbox purge on disable), `GetCommunityStatus`.

### 4.3 Data / schema changes
- No new DB table. Outbox is on disk (JSON lines, 0600, dir 0700) so that "purge" is a file delete the user can verify:
```
~/.orchestra/drift-reports/
  outbox.jsonl        queued reports (one JSON per line)
  sent.jsonl          last 200 sent reports, verbatim, for user inspection (TTL 30 d)
  state.json          { lastFlushAt, backoffUntil, dailyCount, dedupeTokensToday[] }
```
- `install-secret` (32 random bytes, 0600) written at first enablement, deleted on disable.
- Events: `community.report_queued` `{provider, driftKind, deduped}`, `community.report_sent` `{count}`, `community.report_failed` `{code}`, `community.sharing_changed` `{enabled, actor}` (+ `audit.*` row), `community.advisory_seen` `{provider, manifestVersion, advisoryId}`. Payloads carry no report body beyond provider + kind.
- Settings (M8-01 layer `user.yaml`, never org-forced): `privacy: { shareDriftReports: false, flushIntervalMs: 3600000, maxPerDay: 20 }`. `shareDriftReports` may be **pinned off** by an org layer but never pinned on (enforced by a settings-engine rule + unit test).

### 4.4 Infrastructure
- Transport reuses `apps/daemon/src/infrastructure/registry/http-registry.client.ts` (M6-03): the same single allowlisted host, undici, 10 s timeout, 32 KB request cap, no redirects to other hosts, no cookies, no auth headers. New `EgressReason: 'drift-report'`; `EgressPolicy.assertAllowed` is called before every send, and the reason is denied outright when `privacy.shareDriftReports === false`, so a bug in the scheduler still cannot send.
- Scheduler: flush on `flushIntervalMs` ± 10 % jitter and on `orch drift report send-now`; never on the boot path (no startup beacon — a beacon would be a de-facto identifier, P3).
- Backoff: `Unreachable`/5xx → exponential 5 min → 6 h, capped; `RateLimited` honours `retryAfterMs`; failures are logged at `debug`, never surfaced as user errors (this feature must never nag).
- Index consumption: `RefreshRegistry` (M6-03) already verifies and caches the index; this step reads the new optional staleness fields from the *verified* payload only. `advisory.url` is displayed as text and opened by the user's browser — the daemon never fetches it.
- Doctor/Health behaviour when the active manifest version is marked stale: the `manifest.signature` check reports `warn: known-stale` with the advisory summary; new cases with the same `(provider, driftKind)` are still opened (local truth wins) but are grouped under the advisory in Health, and the ladder skips rung 2 retries for that manifest version until `fixedInManifestVersion` appears.

### 4.5 API / UI surface
- `GET /api/community/status` → `{ enabled, queued, sentToday, lastFlushAt, lastError?, advisories: [...] }`.
- `POST /api/community/sharing {enabled}` (`Idempotency-Key`, RBAC Admin, audited) · `POST /api/community/flush` · `GET /api/community/outbox` (the reports verbatim) · `DELETE /api/community/outbox`.
- WS topic `health.community`: `{event:'queued'|'sent'|'failed'|'advisory', …}`.
- CLI: `orch drift report list [--json]` · `orch drift report show <reportId>` · `orch drift report send-now` · `orch drift report purge` · `orch drift sharing on|off`.
- Web — Settings › Privacy, single switch, exact copy (EN; AR translation with the same meaning, RTL):
  > **Share anonymised drift reports** (off)
  > When a vendor CLI changes and breaks a provider, send a short report so the fix reaches everyone. We send: provider, CLI version, manifest version, what kind of drift, a hash of the failing fixture, and counts. We never send file paths, code, prompts, repository names, your account, or anything that identifies you or this machine. Reports go only to the Orchestra registry. You can read every report before and after it is sent, and delete the queue at any time. Reports already sent cannot be recalled.
  > [ Preview a report ] [ See what has been sent ] [ Delete queue ]
- Web — Health › Community panel: advisories for installed providers (summary, since, bucketed report count, "fixed in manifest X" with a **Refresh manifests** button wired to M6-03), plus queue state.
- First send only: a modal showing the exact JSON to be sent with **Send** / **Don't send** / **Turn sharing off**. No modal afterwards; the data is always inspectable in Settings.

### 4.6 Flow / sequence
```
DriftClassifier opens/updates RepairCase (M6-02)  ─event─▶ MaybeQueueDriftReport
   1 privacy.shareDriftReports ? continue : stop (nothing built, nothing stored)
   2 buildDriftReport(case, ctx)  → SanitizeError ⇒ log locally, stop
   3 outbox.enqueue → deduped (P6) ⇒ counter++ , stop
   4 first-ever report ⇒ WS 'preview_required' → modal → user confirms → continue
scheduler / send-now ─▶ FlushDriftReports
   5 EgressPolicy.assertAllowed(registryUrl,'drift-report')
   6 uploader.send(batch ≤ 20) → 202 ⇒ outbox.ack + append to sent.jsonl + community.report_sent
                                → error ⇒ backoff, keep queued, debug log only
registry (M10-03) aggregates ⇒ index entry gains { stale, staleSince, reportCount, advisory }
every daemon ─▶ RefreshRegistry (M6-03, signed, verified) ─▶ Health advisory + Doctor 'known-stale'
maintainers publish corrected manifest ⇒ resolveManifest upgrades ⇒ case closed 'remediated'
```

## 5. Tasks
- [ ] `DriftReport` Zod schema + TypeScript type in `packages/sdk/src/community/`; export for registry implementors; JSON-Schema emitted next to it.
- [ ] `buildDriftReport` sanitizer in `packages/core` with P1–P8 as named branches; 100 % branch coverage; property test that no output value contains `/`, `\`, `@`, whitespace, or exceeds 64 chars.
- [ ] `dedupeToken` derivation + `install-secret` lifecycle (create on enable, delete on disable, 0600).
- [ ] `DriftReportOutbox` fs implementation (append-only JSONL, atomic rotate, TTL 30 d on `sent.jsonl`, purge).
- [ ] `DriftReportUploader` over the M6-03 client; new `EgressReason: 'drift-report'` + policy rule "denied when sharing is off".
- [ ] Use cases `MaybeQueueDriftReport`, `FlushDriftReports`, `SetDriftSharing`, `GetCommunityStatus`; event registration.
- [ ] Settings-engine rule: org layer may pin `shareDriftReports: false` but never `true`; unit test.
- [ ] Index staleness fields in the M6-03 index Zod schema (optional, verified-payload-only) + `GetRegistryStatus` surfacing.
- [ ] Doctor `manifest.signature` check extension: `warn: known-stale` + advisory; ladder rung-2 suppression until `fixedInManifestVersion`.
- [ ] HTTP controller + WS topic + OpenAPI; RBAC (Admin) on the sharing mutation; audit interceptor coverage.
- [ ] CLI `orch drift report …` and `orch drift sharing on|off` with `--json`.
- [ ] Web: Settings › Privacy switch with the copy above (EN + AR), preview modal, outbox viewer, delete-queue; Health › Community panel.
- [ ] Fixture registry (M10-03 / M6-03 `pnpm registry:serve`) gains `POST /v1/drift-reports` + an index that flips to `stale` after N reports, for tests and the demo.
- [ ] Extend the M0-08 egress test: sharing off ⇒ zero outbound connections even with cases open; sharing on ⇒ registry host only.
- [ ] `docs/security/drift-reports.md` (field table, linkability analysis, retention, how to read/purge) + link from `SECURITY.md` and the docs security page (M10-06); add the field-list drift test.
- [ ] Run the TC table on a real injected drift with sharing on and off.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M10-02-01 | unit | `buildDriftReport` output keys vs the allowlist, for a `RepairCase` carrying extra evidence (paths, prompts, diffs) in `detail` | output has exactly the schema keys; no evidence value survives; 100 % branch |
| UT-M10-02-02 | unit | P5/P8 branches: `kind: 'unknown'`, `confidence 0.4`, a 3 KB case | `NotShareable(unknown-kind)`, `NotShareable(low-confidence)`, `OversizeReport` |
| UT-M10-02-03 | unit (fast-check) | random `RepairCase` values incl. unicode, path-like and email-like strings | never throws; every emitted string matches `^[A-Za-z0-9.\-:+]{1,64}$` or is an enum/ISO hour |
| UT-M10-02-04 | unit | `dedupeToken` for the same fingerprint on the same UTC day vs the next day | identical, then different; token never equals or contains `installSecret` |
| UT-M10-02-05 | unit | settings rule: org layer sets `shareDriftReports: true` | rejected with a named error; effective value stays `false` |
| AT-M10-02-01 | application | `MaybeQueueDriftReport` with sharing off, three classified cases | outbox empty, no `install-secret` created, zero events beyond local logging |
| AT-M10-02-02 | application | same fingerprint classified 5× in one day with sharing on | one queued report, `deduped: true` ×4, counter 5 |
| AT-M10-02-03 | application | `FlushDriftReports` with uploader returning 429 then 202 | first attempt honours `retryAfterMs`, nothing acked; second acks and appends to `sent.jsonl` |
| AT-M10-02-04 | application | `SetDriftSharing(false)` with 7 queued reports | outbox purged, `install-secret` deleted, audit row with actor, scheduler stopped |
| IT-M10-02-01 | integration | fixture registry: enable → classify → flush → index refresh | `POST /v1/drift-reports` receives exactly the previewed JSON; index gains `stale: true`; Health shows the advisory |
| IT-M10-02-02 | integration | egress: sharing off, full drift E2E | zero outbound sockets (M0-08 harness); with sharing on, only the registry host |
| IT-M10-02-03 | integration | stale manifest with `fixedInManifestVersion` published | ladder rung 2 resumes, `resolveManifest` upgrades, case closes `remediated` |
| E2E-M10-02-01 | e2e | Settings toggle → preview modal → send → outbox viewer → delete queue | modal shows the exact bytes sent; viewer lists it; delete empties both files |
| CT-M10-02-01 | contract | `DriftReport` JSON-Schema vs the fixture registry's validator | every generated sample validates; an extra property is rejected (`additionalProperties: false`) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-02-01 | Default is silent | 1. Fresh `ORCHESTRA_HOME`. 2. Inject a codex fixture drift and let Doctor classify it. 3. `orch drift report list`. 4. Inspect `~/.orchestra/`. | Sharing off by default; list empty; no `drift-reports/` dir, no `install-secret`; nothing left the host (check with a local proxy or `lsof`) | ⬜ |
| TC-M10-02-02 | Opt in, preview, send | 1. Settings › Privacy → enable. 2. Re-trigger the drift. 3. Preview modal → read the JSON. 4. Send. 5. `orch drift report show <id>`. | Modal JSON = the bytes on the wire (compare with the fixture registry's received body); fields exactly per schema; `community.report_sent` event; audit row for the toggle | ⬜ |
| TC-M10-02-03 | **Negative: nothing identifying in the payload** | 1. Work in a repo named `acme-secret-payments`, in a worktree with a distinctive path, with a prompt containing an email. 2. Trigger the drift. 3. Read the queued report. | No repo name, no path, no email, no username, no hostname, no session/task id, no timezone; only enums, semvers, hashes, counts and an hour-truncated timestamp | ⬜ |
| TC-M10-02-04 | **Negative: registry unreachable** | 1. Stop the fixture registry. 2. `orch drift report send-now` three times. | Reports stay queued; no user-visible error, no toast, no repeated log spam (backoff visible at debug); daemon and sessions unaffected | ⬜ |
| TC-M10-02-05 | **Negative: forbidden egress host** | 1. Point `maintenance.registry.url` at a host not on the allowlist. 2. Enable sharing, trigger a drift, flush. | `EgressDenied` before any socket opens; audit row; nothing sent; reports remain queued | ⬜ |
| TC-M10-02-06 | Revocation | 1. With 3 reports queued, turn sharing off. 2. `ls ~/.orchestra/drift-reports/`. 3. `orch drift report list`. | Directory and `install-secret` gone; list empty; UI states that already-sent reports cannot be recalled | ⬜ |
| TC-M10-02-07 | Staleness reaches another host | 1. Send a report from host A. 2. On host B (second `ORCHESTRA_HOME`) with sharing **off**, `orch registry refresh`. 3. Open Health. | Host B sees `stale: true` + advisory for that manifest version without having shared anything; Doctor check reads `warn: known-stale` | ⬜ |
| TC-M10-02-08 | Fix propagates | 1. Publish a corrected manifest with `fixedInManifestVersion`. 2. Refresh on both hosts. | Advisory clears, manifest upgrades within one refresh, open cases close with `remediated`; total elapsed recorded in the log | ⬜ |
| TC-M10-02-09 | Dedupe and daily cap | 1. Trigger the same drift 30× in one day. | One report queued; `maxPerDay` never exceeded; counters visible in `orch drift report list --json` | ⬜ |
| TC-M10-02-10 | **Negative: org cannot force sharing on** | 1. Add `privacy: { shareDriftReports: true }` to the org layer. 2. `orch settings explain privacy.shareDriftReports`. | Layer rejected with a clear message; effective value `false`; Settings switch still off and user-controlled | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] With the toggle off (the default) the daemon opens **zero** outbound connections for this feature and creates no local artifacts — proven by IT-M10-02-02 and TC-01.
- [ ] Every field that leaves the host is enumerated in `docs/security/drift-reports.md`, and a test fails if the schema and that document diverge.
- [ ] The preview modal, `orch drift report show` and the received body are byte-identical for the same report (TC-02).
- [ ] `buildDriftReport` has 100 % branch coverage and a property test proving no free-text value can escape (UT-01, UT-03).
- [ ] No stable identifier is ever sent; `dedupeToken` rotates daily and `install-secret` never leaves the host (UT-04).
- [ ] Disabling sharing purges the outbox and the secret synchronously and is audited (TC-06).
- [ ] An org policy can pin sharing off but never on (UT-05, TC-10).
- [ ] A stale marker published from one host reaches a second, non-sharing host through the signed index and clears when the fix ships (TC-07, TC-08).
- [ ] All TC-M10-02-01 … 10 pass and are recorded.
- [ ] No new lint / dependency-cruiser violations; the only egress module is still M6-03's client.

## 8. Risks / open questions
- **Linkability.** A rare `(provider, cliVersion, driftKind)` combination on an unusual platform is itself close to an identifier. Mitigations: hour-truncated timestamps, bucketed report counts in the public index, no arch/OS version. Open question for the registry side (M10-03): whether to suppress publication of an advisory below k = 3 distinct `dedupeToken`s — recommended default **yes**.
- `fixtureHash` is a hash of a file we ship publicly, so it leaks nothing about the user — but only if the fixture really is the shipped one. For a third-party plugin the fixture is that plugin's public file; for a *locally modified* fixture the hash is skipped (`null`) to avoid hashing unknown content. Verify this branch during implementation.
- Third-party plugins: reporting drift for a plugin the maintainers do not own is useful but routes the advisory to a repo we do not control. Default: report with `pluginId`, and the registry attributes the advisory to that plugin's `repository` field (M10-03). A plugin may set `driftReports: false` in its manifest to opt its users out (`NotShareable(third-party-optout)`).
- Abuse of the endpoint (flooding to force a false "stale") is a registry-side problem: per-token and per-IP rate limits, k-anonymity threshold, and maintainers confirming before an advisory is published. Record the policy in M10-03.
- Legal review of the wording (EN and AR) before 1.0 — the copy is a privacy notice. Route through the same reviewer as the Antigravity ToS note (R4).
- Whether the registry should accept reports from pre-release daemon builds — default no (`daemonVersion` prerelease ⇒ rejected server-side) so noisy dev builds do not skew counts.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
