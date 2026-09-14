# Step M6-02 — Drift detector & classifier

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M6-01 (Doctor, `driftHint`), M4-01 (quota signals), M1-08 (telemetry pipeline), M0-05 (event store) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon`, `apps/cli` |
| Risk | High |
| Owner | |

## 1. Goal
After this step the daemon continuously watches its own runtime for evidence that a vendor CLI no longer behaves the way its manifest and fixtures say — Zod parse failures, unknown event types, `send-keys` ack timeouts, unexpected exit codes, approval loops, model-not-found errors, rate-limit payloads in an unrecognised shape, and failed Doctor checks — feeds those signals into a pure `DriftClassifier`, and opens (or updates) a durable `RepairCase` with a `DriftKind`, a confidence score, a human-readable rationale and the raw evidence. Nothing is repaired yet: the user can list cases (`orch drift list`, `GET /api/repair-cases`) and see, within 60 s of the first signal, *what* drifted, *for which provider and CLI version*, and *why the classifier thinks so*.

## 2. Why
- D6 — the platform maintains itself; detection is the precondition for every ladder step. G6 — drift detected < 60 s (measured here, reported in M6-07).
- D5 — core knows no vendor: the classifier consumes normalized `DriftSignal`s produced by adapters and the pipeline, never vendor payloads.
- C7 — signals come from structured parsers and process exits only; PTY bytes are never inspected for drift.
- C12 — this step is read-only with respect to the system it observes; it records evidence, opens no files, changes no config. Remediation is M6-04.
- `05-provider-contract.md` §2/§4: "CLI version outside `cliVersionRange` ⇒ Doctor opens a RepairCase" and "fixture drift = failing contract test = vendor changed something" — this step is where those sentences become code.
- R1 (score 20, highest in the register): without this, a weekly vendor release degrades prompts and parsers silently.

## 3. Scope
### In scope
- Core: `DriftSignal`, `DriftKind`, `SignalKind`, `RepairCase` entity + state machine, pure `DriftClassifier` and `SignalWindow` (100 % branch coverage).
- Daemon collectors that turn existing runtime facts into `DriftSignal`s: telemetry `ParseError`s and unknown event types (M1-08), `AckTimeout` from `PaneController` (M1-11), unexpected session exits (M1-02), approval loops (M1-11 prompt repetition), model-not-found exit fixtures, unrecognised rate-limit shapes (M4-01), failed Doctor checks carrying `driftHint` (M6-01).
- Fingerprinting + dedupe window; case reopen rules; TTD measurement written into `evidence_json.metrics.ttdMs`.
- `repair_cases` migration (columns beyond `04-domain-model.md` §4 baseline), repository, `doctor.drift_detected` event, WS topic `health.cases`.
- `orch drift list|show|simulate` and read-only HTTP surface.
- FakeProvider scenarios that inject each signal kind deterministically.
### Out of scope (deferred to …)
- Any fix at all — deferred to M6-04 (ladder 1–2) and M10-01 (ladder 3, assisted).
- Fetching a newer manifest when the case says `manifest-stale` — deferred to M6-03/M6-04.
- Anonymised community drift reporting — deferred to M10-02.
- Health screen rendering of cases — deferred to M6-07 (this step ships API + CLI only).
- Canary-triggered cases on a new CLI version — deferred to M6-05 (it calls `IngestDriftSignal` with `source: 'canary'`).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/maintenance/drift/{drift-signal.ts, drift-kind.ts, signal-window.ts, drift-classifier.ts, repair-case.ts}` — pure, no I/O, `Clock` injected.

`RepairCase` state machine is exactly `04-domain-model.md` §2: `detected → classified → auto_fixing | registry_fix | assisted | needs_human → fixed`. This step only produces `detected → classified` and `classified → needs_human` (when confidence is below the ladder threshold or the kind is `unknown`); the other transitions are owned by M6-04/M10-01 and rejected here by the entity's `canTransition` rule.

Classification rules (each a named branch, each with a golden test):

| # | Rule | Signals (within `windowMs`) | ⇒ `DriftKind` | Confidence |
|---|---|---|---|---|
| R-C1 | Version outside manifest range plus any other signal | `doctor_check_failed(binary.version_in_range)` + ≥ 1 other | `manifest-stale` | 0.9 |
| R-C2 | Repeated structured parse failure of the same source | ≥ `parseErrorThreshold` (3) `parse_error` with equal `(source, schemaId)` | `parser-drift` | 0.85 |
| R-C3 | Unknown event type seen repeatedly | ≥ 3 `unknown_event_type` with equal `typeName` | `parser-drift` | 0.85 |
| R-C4 | Probe/help diff from Doctor | `doctor_check_failed(probe.help_commands \| probe.rpc_schema \| probe.usage_schema)` | `manifest-stale` | 0.8 |
| R-C5 | Auth probe fails while the binary is present and unchanged | `doctor_check_failed(auth.status)` and no `provider.version_changed` in window | `auth-drift` | 0.7 |
| R-C6 | Model not found on launch | ≥ 1 `model_not_found` naming a model that is in the manifest | `model-missing` | 0.9 |
| R-C7 | Ack timeouts across ≥ 2 distinct sessions | ≥ `ackTimeoutThreshold` (2) `ack_timeout` | `transport-broken` | 0.8 |
| R-C8 | RPC transport errors (codex app-server) | ≥ 2 `rpc_error` with transport-level codes | `transport-broken` | 0.85 |
| R-C9 | Hook payloads stop arriving for a session that should emit them | `hook_silence` (session ran > `hookSilenceMs` with ≥ 1 tool call and 0 hook posts) | `hooks-unregistered` | 0.6 |
| R-C10 | Approval loop | same prompt fingerprint re-opened ≥ `approvalLoopThreshold` (3) in one session | `transport-broken` | 0.65 |
| R-C11 | Anything else above the open threshold | signals that match no rule | `unknown` | 0.3 |

Invariants (enforced in `DriftClassifier` and unit-tested):
- **R-D1 429 alone is never drift.** A `rate_limit` signal with `confidence: 'official'` and a parsable `resetAt`/`retryAfterMs` (M4-01) is *discarded* by the collector. Only `rate_limit_unparsed` (the payload matched the provider's rate-limit heuristic but produced no `RateLimitSignal`) is a drift signal, and it maps to R-C2.
- **R-D2 Confidence floor.** `confidence < openThreshold` (default 0.5) ⇒ no case; the signal is persisted as an event only. `unknown` never opens a case on its own unless `signalCount ≥ 5`.
- **R-D3 Determinism.** `classify(window, ctx)` is pure: same signals + same `ctx` (manifest version, CLI version, `now`) ⇒ same `Classification`. No randomness, no wall-clock reads.
- **R-D4 Highest-confidence rule wins**; ties break by rule order R-C1 … R-C11; every rule that fired is listed in `rationale[]` so the UI can show "also matched".
- **R-D5 One open case per fingerprint.** `fingerprint = sha256(provider | cliVersion | manifestVersion | driftKind | evidenceKey)` where `evidenceKey` is the rule's discriminator (schema id, type name, model id, transport name, check id). A new signal with an existing open fingerprint updates the case (`signalCount++`, `lastSignalAt`, evidence appended, capped at `maxEvidenceItems` 50) instead of opening a second one.
- **R-D6 Dedupe/cooldown.** After a case is closed (`fixed`), the same fingerprint is suppressed for `dedupeWindowMs` (default 15 min); a signal inside the window reopens the closed case (`reopenCount++`) rather than creating a new one.
- **R-D7 Scope.** A case is per `(hostId, providerId, cliVersion)`. A version change invalidates open cases for the old version: they are closed with `state: 'fixed', closeReason: 'cli_version_changed'` and a fresh window starts.
- **R-D8 TTD.** `ttdMs = classifiedAt − firstSignalAt`. `firstSignalAt` is the signal's `observedAt` (produced by the collector at the moment the runtime fact occurred), never the ingestion time.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/maintenance/drift/drift-kind.ts
export type DriftKind =
  | 'manifest-stale' | 'parser-drift' | 'auth-drift' | 'model-missing'
  | 'transport-broken' | 'hooks-unregistered' | 'unknown';

// packages/core/src/maintenance/drift/drift-signal.ts
export type SignalKind =
  | 'parse_error' | 'unknown_event_type' | 'ack_timeout' | 'unexpected_exit'
  | 'approval_loop' | 'model_not_found' | 'rate_limit_unparsed' | 'rpc_error'
  | 'hook_silence' | 'doctor_check_failed' | 'launch_failed';
export interface DriftSignal {
  id: string; hostId: string; providerId: ProviderId;
  cliVersion: string | null; manifestVersion: string | null;
  kind: SignalKind; observedAt: string;                 // ISO-8601 UTC, set by the collector
  sessionId?: string; taskId?: string;
  evidenceKey: string;                                  // schemaId | typeName | modelId | transport | checkId
  detail: Readonly<Record<string, unknown>>;            // redacted; ≤ 4 KB after serialization
  source: 'telemetry' | 'pane' | 'supervisor' | 'doctor' | 'quota' | 'canary' | 'cli';
}

// packages/core/src/maintenance/drift/drift-classifier.ts  (pure, 100 % branch)
export interface SignalWindow { readonly signals: readonly DriftSignal[]; readonly windowMs: number; }
export interface ClassifierContext {
  now: string; cliVersionInRange: boolean; versionChangedWithinWindow: boolean;
  manifestModels: readonly ModelId[]; thresholds: DriftThresholds;
}
export interface Classification {
  kind: DriftKind; confidence: number;                  // 0..1, two decimals
  rationale: readonly { rule: DriftRuleId; text: string; signalIds: readonly string[] }[];
  evidenceKey: string; recommendedLadderStep: 1 | 2 | 3; // consumed by M6-04; 3 ⇒ assisted (M10-01)
}
export declare function classify(w: SignalWindow, ctx: ClassifierContext): Classification | null;
export declare function fingerprint(c: Classification, s: DriftSignal): string;

// packages/core/src/maintenance/drift/repair-case.ts
export type RepairCaseState =
  | 'detected' | 'classified' | 'auto_fixing' | 'registry_fix'
  | 'assisted' | 'proposed' | 'approved' | 'applied' | 'fixed' | 'needs_human';
export interface RepairCase {
  id: string; hostId: string; providerId: ProviderId; cliVersion: string | null;
  manifestVersion: string | null; kind: DriftKind; confidence: number; fingerprint: string;
  state: RepairCaseState; ladderStep: 0 | 1 | 2 | 3; patchRef: string | null;
  signalCount: number; reopenCount: number;
  firstSignalAt: string; lastSignalAt: string; classifiedAt: string | null;
  openedAt: string; closedAt: string | null; closeReason?: CaseCloseReason;
  evidence: {
    signals: readonly DriftSignal[];                    // capped, newest first
    rationale: Classification['rationale'];
    metrics: { ttdMs?: number; ttrMs?: number };        // ttrMs written by M6-04
  };
}
export type CaseCloseReason = 'remediated' | 'cli_version_changed' | 'manual' | 'stale_expired';
export declare function canTransition(from: RepairCaseState, to: RepairCaseState): boolean;

// apps/daemon/src/application/ports/drift.ports.ts
export interface RepairCaseRepository {
  openOrUpdate(c: RepairCase): Promise<Result<{ created: boolean; caseId: string }, StorageError>>;
  findOpenByFingerprint(hostId: string, fp: string): Promise<Result<RepairCase | null, StorageError>>;
  list(q: { state?: RepairCaseState[]; providerId?: ProviderId; limit: number }): Promise<Result<RepairCase[], StorageError>>;
  get(id: string): Promise<Result<RepairCase | null, StorageError>>;
  close(id: string, reason: CaseCloseReason, at: string): Promise<Result<void, StorageError>>;
}
export interface DriftSignalBuffer {                    // in-memory ring per (provider, cliVersion)
  push(s: DriftSignal): SignalWindow; prune(now: string): void; snapshot(): readonly DriftSignal[];
}
```
Use cases (one class each, `apps/daemon/src/application/maintenance/`): `IngestDriftSignal`, `ListRepairCases`, `GetRepairCase`, `CloseRepairCase`. Errors: `DriftError = ProviderNotEnabled | SignalTooLarge | StorageError | InvalidTransition`.

### 4.3 Data / schema changes
- Migration `NNN-m6-02-repair-cases`: create `repair_cases` per `04-domain-model.md` §4 (`id, provider_id, cli_version, kind, evidence_json, ladder_step, state, patch_ref, opened_at, closed_at`) **plus** `host_id TEXT NOT NULL`, `manifest_version TEXT`, `confidence REAL NOT NULL`, `fingerprint TEXT NOT NULL`, `signal_count INTEGER NOT NULL DEFAULT 1`, `reopen_count INTEGER NOT NULL DEFAULT 0`, `first_signal_at TEXT NOT NULL`, `last_signal_at TEXT NOT NULL`, `classified_at TEXT`, `close_reason TEXT`, `updated_at TEXT NOT NULL`. Partial-unique index `(host_id, fingerprint)` where `closed_at IS NULL`; index `(state, opened_at DESC)`. Postgres-compatible types only (D8).
- Event `doctor.drift_detected`, Zod-registered: `{ caseId, created: boolean, providerId, cliVersion, kind, confidence, fingerprint, signalCount, ttdMs, ruleIds: DriftRuleId[] }`. Actor `{kind:'system', id:'drift-detector'}`, `source.channel` mirrors the originating signal source.
- Raw signals are **not** a table: each is emitted as an event `doctor.drift_signal` (payload = `DriftSignal`) so retention (M5-06) and FTS (M5-03) already cover them; the in-memory buffer is the only hot store.
- Config `maintenance.drift` (Zod): `{ enabled: true, windowMs: 600000, dedupeWindowMs: 900000, openThreshold: 0.5, ladderThreshold: 0.6, parseErrorThreshold: 3, ackTimeoutThreshold: 2, approvalLoopThreshold: 3, hookSilenceMs: 120000, maxEvidenceItems: 50, maxDetailBytes: 4096, bufferMaxSignals: 500 }`. Behind `features.maintenance`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/maintenance/collectors/*.collector.ts` — one collector per source, each a Nest provider subscribing to the event bus / pipeline; all register into a DI map keyed by `SignalKind` (no `switch`). No collector spawns a process or touches the network.
  - `TelemetryParseErrorCollector` — wraps the M1-08 pipeline result: `Result.err(ParseError)` ⇒ `parse_error` (`evidenceKey = schemaId`); a payload that parses but carries an unmodelled discriminator ⇒ `unknown_event_type` (`evidenceKey = typeName`).
  - `PaneAckCollector` — `Err(AckTimeout)` from `PaneController.sendCommand/answerPrompt` ⇒ `ack_timeout` (`evidenceKey = commandName`).
  - `SupervisorExitCollector` — `session.crashed` / non-zero exit that matches a provider's `fixtures/<ver>/exit/*.txt` classifier: `model-not-found` ⇒ `model_not_found`; auth-missing ⇒ folded into `doctor_check_failed(auth.status)` by the next Doctor run, never a direct `auth-drift`; unmatched exit code ⇒ `unexpected_exit`.
  - `PromptLoopCollector` — counts re-opened `AgentPrompt`s with equal `(sessionId, kind, titleHash)` ⇒ `approval_loop`.
  - `HookSilenceCollector` — timer per running session with the `hooks` capability; `hookSilenceMs` elapsed with ≥ 1 tool call and 0 hook posts ⇒ `hook_silence`.
  - `QuotaShapeCollector` — M4-01 emitted a rate-limit heuristic match but `RateLimitParser` returned `null` ⇒ `rate_limit_unparsed`. A successful `quota.rate_limited` is dropped (R-D1).
  - `DoctorSignalCollector` — for every `CheckResult` with `status: 'fail'` and a `driftHint`, emits `doctor_check_failed` (`evidenceKey = checkId`).
- `DriftDetectorService` — owns one `DriftSignalBuffer` per `(providerId, cliVersion)`, calls `IngestDriftSignal` synchronously on push so TTD is not queue-bound; prunes on a 30 s timer; buffers are rebuilt empty after a restart (documented: a restart resets the window; open cases survive in SQLite).
- Redaction: every `detail` passes the pino redaction serializer (`authorization|token|cookie|apiKey|secret`) plus the M5-01 capture-time secret regexes before persistence, then is truncated to `maxDetailBytes`.
- `orch drift simulate <scenario>` drives FakeProvider scenarios only; it is refused unless `features.devTools` (same guard as M4-01's fixture replay).

### 4.5 API / UI surface
- `GET /api/repair-cases?state=open|closed|all&provider=&limit=` → `RepairCaseDto[]` (evidence summarised: counts + rationale, full signals only in the detail route).
- `GET /api/repair-cases/:id` → full case incl. evidence and metrics. `POST /api/repair-cases/:id/close {reason}` (`Idempotency-Key`; audited) → sets `fixed`/`manual`.
- WS topic `health.cases`: `{event:'opened'|'updated'|'closed', caseId, providerId, kind, confidence, state, ttdMs}`.
- CLI: `orch drift list [--state open] [--json]`, `orch drift show <caseId> [--json]`, `orch drift simulate <parse-error|unknown-event|ack-timeout|model-missing|help-drift|rate-limit-unparsed> --provider fake`, `orch drift close <caseId> --reason manual`.
- No new screen. The Fleet provider row (M1-10) gains an "N open cases" counter linking to `/health` (rendered in M6-07).

### 4.6 Flow / sequence
```
runtime fact (ParseError | AckTimeout | exit | prompt loop | hook silence | doctor fail)
  → Collector.build(DriftSignal{observedAt = fact time})
  → DriftDetectorService.push → buffer.push → SignalWindow
  → IngestDriftSignal.execute
       ├─ emit doctor.drift_signal (always)
       ├─ classify(window, ctx)  → null (below threshold) → stop
       └─ fingerprint → repo.findOpenByFingerprint
            ├─ hit  → update (signalCount++, lastSignalAt, evidence append) → ws 'updated'
            └─ miss → RepairCase{state:'detected'} → transition 'classified'
                      ttdMs = classifiedAt − firstSignalAt
                      → repo.openOrUpdate → emit doctor.drift_detected → ws 'opened'
provider.version_changed → close open cases for the old version (reason cli_version_changed)
```

## 5. Tasks
- [ ] `packages/core/src/maintenance/drift/`: `DriftKind`, `SignalKind`, `DriftSignal`, `SignalWindow`, `DriftThresholds` types.
- [ ] `RepairCase` entity + `canTransition` + `CaseCloseReason`; unit tests for every legal and illegal transition.
- [ ] `classify()` — rules R-C1…R-C11 and invariants R-D1…R-D8; golden fixture table; drive to 100 % branch coverage.
- [ ] `fingerprint()` + dedupe/reopen/cooldown rules with unit tests around the window boundaries.
- [ ] Kysely migration `repair_cases` (+ partial-unique index); SQLite repository + in-memory repository.
- [ ] `IngestDriftSignal`, `ListRepairCases`, `GetRepairCase`, `CloseRepairCase` use cases (`Result`, typed errors).
- [ ] `DriftSignalBuffer` (ring, per provider+version, `bufferMaxSignals` cap, prune timer).
- [ ] `TelemetryParseErrorCollector` + pipeline hook in M1-08 (returns `Result`, must not change pipeline behaviour).
- [ ] `PaneAckCollector`, `SupervisorExitCollector`, `PromptLoopCollector`.
- [ ] `HookSilenceCollector` (per-session timer, cancelled on session end).
- [ ] `QuotaShapeCollector` with the R-D1 discard path.
- [ ] `DoctorSignalCollector` consuming `CheckResult.driftHint` from M6-01.
- [ ] Redaction + size cap on `DriftSignal.detail`; event registration for `doctor.drift_signal` / `doctor.drift_detected`.
- [ ] `DriftDetectorService` wiring behind `features.maintenance`; config schema `maintenance.drift`.
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS topic `health.cases`.
- [ ] `apps/cli/src/commands/drift.ts`: `list`, `show`, `close`, `simulate` (devTools-gated).
- [ ] FakeProvider scenarios: `drift-parse-error.yaml`, `drift-unknown-event.yaml`, `drift-ack-timeout.yaml`, `drift-model-missing.yaml`, `drift-429-noise.yaml` (must **not** open a case).
- [ ] Fleet row "open cases" counter; `packages/core` README section on adding a classification rule.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-02-01 | unit | `classify()` golden table over all 11 rules, each at threshold−1 / threshold / threshold+1 | exact `kind` + `confidence` + `rationale.rule` per row; 100 % branch |
| UT-M6-02-02 | unit | R-D1: 20 parsed `quota.rate_limited` signals in the window | `classify()` returns `null`; no case |
| UT-M6-02-03 | unit | R-D4: window matching R-C2 (0.85) and R-C9 (0.6) | kind `parser-drift`; `rationale` lists both rules in order |
| UT-M6-02-04 | unit | `fingerprint()` stability & dedupe: same evidenceKey twice, then after `dedupeWindowMs` | identical hash; second update, not a new case; post-window reopen increments `reopenCount` |
| UT-M6-02-05 | unit | `canTransition` matrix incl. `classified → applied` (illegal here) | illegal transitions return false; entity returns `InvalidTransition` |
| UT-M6-02-06 | unit (fast-check) | `classify()` over random signal arrays (≤ 200 signals, random kinds/times) | never throws; `confidence ∈ [0,1]`; deterministic across two runs |
| AT-M6-02-01 | application | `IngestDriftSignal` × 3 equal `parse_error` signals | one case created on the 3rd; `signalCount: 3`; one `doctor.drift_detected` event |
| AT-M6-02-02 | application | `provider.version_changed` with two open cases on the old version | both closed with `cli_version_changed`; new signals open a fresh case |
| AT-M6-02-03 | application | signal `detail` containing `"authorization": "Bearer x"` | persisted evidence redacted; no token-shaped string in `evidence_json` |
| IT-M6-02-01 | integration | repository partial-unique index: two concurrent `openOrUpdate` with the same fingerprint | exactly one row; the loser updates it; no constraint error surfaces to the caller |
| IT-M6-02-02 | integration | FakeProvider `drift-unknown-event.yaml` through the real pipeline → `GET /api/repair-cases` | case `parser-drift`, evidence contains the unknown `typeName`, `ttdMs` present |
| E2E-M6-02-01 | e2e | `orch drift simulate ack-timeout --provider fake` then `orch drift list --json` | one open `transport-broken` case; `ttdMs < 60000`; WS `health.cases` `opened` frame observed |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-02-01 | Parser drift is detected and classified | 1. Start a FakeProvider session with `drift-parse-error.yaml` (3 malformed hook bodies, 5 s apart). 2. `orch drift list --json`. 3. `orch drift show <caseId>`. | Exactly one case, `kind: parser-drift`, `confidence 0.85`, `state: classified`, evidence lists 3 signals with the schema id; rationale text names rule R-C2 | ⬜ |
| TC-M6-02-02 | **TTD SLO measurement** | 1. Note the wall clock. 2. Run TC-01's scenario 5 times (fresh fingerprints via different schema ids). 3. For each case read `evidence.metrics.ttdMs`; also compare the first `doctor.drift_signal.ts` with `doctor.drift_detected.ts` in `events`. | All 5 `ttdMs` < 60 000 ms and the event-timestamp delta agrees within 1 s; record p95 in the log | ⬜ |
| TC-M6-02-03 | **Negative: a real 429 is not drift** | 1. `orch drift simulate rate-limit --provider fake` (scenario emits a well-formed 429 with `resetAt`, 20×). 2. `orch drift list --state all`. 3. `sqlite3 orchestra.db "select count(*) from repair_cases"`. | Zero cases; `quota.rate_limited` events present; no `doctor.drift_signal` of kind `rate_limit_unparsed` | ⬜ |
| TC-M6-02-04 | **Negative: one-off parse error is noise** | 1. Inject a single malformed hook payload. 2. Wait 2 × `windowMs`. 3. `orch drift list --state all`. | No case opened; exactly one `doctor.drift_signal` event recorded | ⬜ |
| TC-M6-02-05 | Dedupe & reopen | 1. Trigger TC-01 to open a case. 2. `orch drift close <caseId> --reason manual`. 3. Re-trigger the same scenario within 15 min. 4. `orch drift list --state all`. | Still one row; `reopen_count = 1`; `state` back to `classified`; no duplicate case | ⬜ |
| TC-M6-02-06 | Version change invalidates cases | 1. With an open case for `fake@1.0.0`, run `orch doctor simulate version-bump --provider fake --to 9.9.0`. 2. `orch drift list --state all --json`. | Old case `closed_at` set, `close_reason: cli_version_changed`; subsequent signals open a new case carrying `cli_version: 9.9.0` | ⬜ |
| TC-M6-02-07 | Resilience: daemon restart mid-window | 1. Inject 2 of the 3 signals needed for R-C2. 2. `kill -9` the daemon; restart. 3. Inject 3 more signals. | No crash, no orphan case; the post-restart window opens the case on its own 3rd signal; pre-restart signals remain as events | ⬜ |
| TC-M6-02-08 | Resilience: signal storm | 1. `orch drift simulate storm --provider fake` (1 000 signals in 60 s across 5 evidence keys). 2. Watch daemon RSS and `orch drift list`. | ≤ 5 cases (one per key); buffer stays at `bufferMaxSignals`; daemon RSS growth < 50 MB; UI WS not flooded (≤ 1 frame/s/case, coalesced) | ⬜ |
| TC-M6-02-09 | Secret hygiene in evidence | 1. Inject a malformed payload containing `sk-test-ABCDEFG` and an `Authorization` header. 2. `orch drift show <caseId> --json \| grep -Ei 'sk-|bearer|authorization'`. | No match; the field is present but redacted; detail ≤ 4 KB | ⬜ |
| TC-M6-02-10 | Real CLI sanity (no false positives) | 1. With claude + codex logged in, run a normal 15-minute working session (a Quick Delegate task each). 2. `orch drift list --state all`. | Zero cases opened; zero `doctor.drift_signal` events of kind `parse_error`/`unknown_event_type` (any hit is a real fixture gap — record it) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-02-01 … 10 pass and are recorded with build hash and date.
- [ ] `DriftClassifier`, `SignalWindow`, `fingerprint` and `RepairCase` transitions have **100 % branch coverage**, enforced by the CI coverage gate (`10-testing-strategy.md`).
- [ ] p95 `ttdMs` over ≥ 20 injected cases is **< 60 000 ms** (evidence table in the log).
- [ ] Zero cases opened during TC-10's real-CLI session and during a full `FakeProvider` happy-path E2E run.
- [ ] Every signal kind in `SignalKind` has at least one collector and one FakeProvider scenario.
- [ ] No token-shaped or secret-shaped string in any `repair_cases.evidence_json` row (automated grep in IT).
- [ ] Nothing in this step writes a file, spawns a process, or opens a socket outside the existing pipeline (reviewed against C7/C12).
- [ ] No new lint/dependency-cruiser violations; `packages/core` still imports nothing.
- [ ] `PROGRESS.md` row updated; `packages/core/README.md` documents how to add a classification rule and its golden test.

## 8. Risks / open questions
- **False positives are the main failure mode.** Thresholds are config, but the defaults above are guesses until real fixtures exist; TC-10 is the guard. If a rule fires on healthy CLIs, raise its threshold rather than lowering confidence.
- Exact stderr text for model-not-found and for auth-missing differs per vendor and version — the collector matches the recorded `fixtures/<ver>/exit/*.txt` classifiers, never a hand-written regex; **verify against Claude Code / Codex / Antigravity docs and re-record fixtures at step start**.
- Whether Claude Code's `Notification` hook can go silent while the session is healthy (would make R-C9 noisy) — **verify against Claude Code docs at step start**; if unclear, ship `hookSilenceMs` at 300 s and confidence 0.6 (below `ladderThreshold`, so it never auto-remediates).
- Codex `app-server` transport error codes are experimental (ADR-009, R3) — **verify against Codex docs at step start**; R-C8 keys on codes present in the pinned schema fixture only.
- In-memory buffers mean a restart resets partially accumulated windows; accepted (cases are durable, signals are events). If TTD suffers in practice, persist the buffer in M6-07.
- `evidenceKey` for `manifest-stale` must stay stable across manifest hot-reloads (M6-03) or dedupe breaks; it uses the check id, not the manifest version.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
