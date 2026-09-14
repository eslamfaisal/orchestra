# Step M6-04 — Remediation ladder 1–2

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M6-02 (RepairCase, DriftClassifier), M6-03 (registry client, `ManifestOverrideApplier`), M4-03 (reroute), M1-02 (SessionSupervisor) |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `apps/daemon`, `apps/cli`, `packages/sdk` |
| Risk | High |
| Owner | |

## 1. Goal
After this step a classified `RepairCase` is repaired by the platform itself. A pure `RemediationLadder` turns `(DriftKind, case context, available strategies)` into an ordered plan of attempts; the daemon executes them one at a time behind a per-case mutex, verifies after each, and closes the case as `fixed` — or stops at `needs_human` with everything it tried recorded. Ladder **step 1** is six safe auto-fixes that need no approval and are budgeted to complete in under 10 s: reload manifest, re-register hooks/MCP, restart pane and resume, switch transport, reroute task, roll back plugin/manifest. Ladder **step 2** is `RegistryFix`: fetch and apply a newer signed manifest that matches the installed CLI version. Every attempt is timed, audited and emitted as `doctor.remediation_applied` or `doctor.remediation_failed`, and the user can retry a ladder run by hand.

## 2. Why
- D6 and G6 — "safe remediation < 10 s" is the milestone's headline SLO; this step is where it is met and measured (`00-source-plan-v0.2.md` §10.3, ladder rungs 1 and 2).
- D5/D13 — strategies are DI-registered and act only through existing owners (`SessionSupervisor` for tmux, `ManifestOverrideApplier` for manifests, M4-03's reroute use case for routing). No strategy talks to tmux, git or the network directly.
- **C12** — the ladder may never modify auth, ToS rules, the binary allowlist or ESLint/arch rules. Enforced at runtime by `ForbiddenPathGuard` *and* by the fact that no ladder-1/2 strategy writes source code at all (ADR-006 / M6-03 gives us manifests as data; code patches are M10-01 and require a human).
- C1/C8 — a remediated session is relaunched through the same allowlisted binary and the same manifest-documented argv builder; "switch transport" picks another **documented** transport (ADR-009: codex `app-server` → `exec --json`), never an undocumented one.
- C10 — nothing that spends quota or sends keystrokes happens without a preview *unless* it is on the safe-auto list and provably quota-free; `RerouteTask` and `RestartPaneAndResume` are the two that touch a live agent, and both are bounded by rules R-L5/R-L6 below.
- R1/R3/R5 — this is the mitigation named in the risk register for adapter breakage, app-server drift and prompt round-trip failure.

## 3. Scope
### In scope
- Pure `RemediationLadder` + `RemediationStrategyDescriptor` (id, applicable kinds, safety class, preconditions, order, budget) in `packages/core` — 100 % branch coverage.
- `RemediationStrategy` port + DI registry; six ladder-1 strategies and `RegistryFix` (ladder 2).
- `RunRemediationLadder`, `RunSingleAttempt`, `RetryRemediation` use cases; per-case mutex, loop guard, backoff, maintenance lock.
- Post-attempt **verification** (targeted Doctor checks + evidence re-check) that decides `fixed` vs `still-failing`.
- `repair_attempts` table, `doctor.remediation_applied|failed` events, `audit_log` rows, `ttrMs` written into `repair_cases.evidence_json.metrics`.
- `ForbiddenPathGuard` (runtime write guard, C12) applied to every strategy that touches the filesystem.
- HTTP + CLI surface for manual retry and attempt history.
### Out of scope (deferred to …)
- Ladder step 3 (sandboxed Repair Agent proposing adapter/manifest patches) — deferred to M10-01; this step only sets `state: 'assisted'` / `needs_human` and records `recommendedLadderStep: 3`.
- Ladder step 4 (community drift loop) — deferred to M10-02.
- Canary gating of a remediation after a CLI version bump — deferred to M6-05 (it acquires the `MaintenanceLock` defined here).
- Health screen rendering of attempts and SLO tiles — deferred to M6-07 (API + CLI only here).
- Model-deprecation remediation (policy migration) — deferred to M6-06; `model-missing` here only reroutes the *task*.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/maintenance/remediation/{ladder.ts, strategy-descriptor.ts, safety.ts}` — pure; the executor lives in the daemon.

| Order | Strategy id | Applies to `DriftKind` | Safety class | Precondition | Budget |
|---|---|---|---|---|---|
| 1 | `ReloadManifest` | manifest-stale, parser-drift, hooks-unregistered | `safe-auto` | a cached manifest version ≠ active satisfies the installed CLI version | 2 s |
| 2 | `ReRegisterHooksAndMcp` | hooks-unregistered, parser-drift | `safe-auto` | ≥ 1 running session with feature `hooks`/`mcp`; `paths.hooksConfig`/`mcpConfig` present in the manifest | 2 s |
| 3 | `SwitchTransport` | transport-broken | `safe-auto` | manifest declares ≥ 2 transports for the failing command and the alternative is documented (ADR-009) | 2 s |
| 4 | `RestartPaneAndResume` | transport-broken, hooks-unregistered | `safe-auto` | `manifest.limits.resume === true`; session state ∈ {running, waiting_for_input, crashed}; no unresolved prompt of any age; verified quiescent replay-safe checkpoint; old execution fenced | 6 s |
| 5 | `RerouteTask` | model-missing, auth-drift, transport-broken | `safe-auto` | the case has a `taskId`; ≥ 1 alternative candidate from M2-04 with a healthy quota window | 4 s |
| 6 | `RollbackPluginOrManifest` | manifest-stale, parser-drift | `safe-auto` | `lastKnownGood` non-empty and the active manifest arrived from the registry | 3 s |
| 7 | `RegistryFix` | manifest-stale, parser-drift, model-missing | `registry` | `maintenance.registry.enabled` and a satisfying candidate newer than active | 30 s |

Rules (each a branch in `plan()`, all unit-tested):
- **R-L1 Ordered, filtered, deduped.** `plan(case, descriptors, ctx)` returns the descriptors whose `applies` includes `case.kind` **and** whose preconditions hold, in table order, minus any strategy already attempted for this case in the current run.
- **R-L2 Confidence gate.** `case.confidence < ladderThreshold` (0.6) ⇒ empty plan and `needs_human`. `kind === 'unknown'` ⇒ empty plan.
- **R-L3 Step separation.** All `safe-auto` descriptors run first (ladder step 1). Only if every one of them failed or was inapplicable does the plan advance to `registry` (ladder step 2). `assisted` is never planned here — the ladder returns `handoff: 3`.
- **R-L4 Auth is never auto-fixed.** `auth-drift` may only plan `RerouteTask` (move work to another provider). Logging a user in, refreshing a token, touching a credential store or opening a login flow is **not a strategy and never will be** (C3, C12).
- **R-L5 No keystrokes without a documented transport.** `RestartPaneAndResume` and `SwitchTransport` act through `SessionSupervisor`/`PaneController` only; if the resume path is not declared in the manifest (`limits.resume`), the strategy is inapplicable, not "best effort".
- **R-L6 Never destroy work.** `RestartPaneAndResume`, `SwitchTransport` and `RerouteTask` refuse when there is any unresolved prompt, in-flight call, stale/missing telemetry, uncertain external effect or unfenced old execution; the worktree is never cleaned, the branch never reset, the recording never truncated.
- **R-L7 Loop guard.** `maxLadderRunsPerCase` (3). Run *n* is separated from *n−1* by `backoffMs[n] = [30_000, 120_000, 600_000]`. After 3 runs ⇒ `needs_human`, no further automatic attempts for that fingerprint until it is closed.
- **R-L8 One at a time.** A per-case mutex plus a host-wide `MaintenanceLock` (held by a ladder run, by a canary run in M6-05, and by a manifest apply in M6-03) — a strategy never runs while another maintenance action is in flight.
- **R-L9 Verify, then close.** An attempt is `applied` only when verification passes; otherwise it is `failed` and the plan advances. The case closes as `fixed` (reason `remediated`) with `ttrMs = fixedAt − classifiedAt`.
- **R-L10 Budget = truth.** Exceeding a strategy's budget aborts that attempt (`outcome: 'timeout'`) and is recorded; the whole safe-auto run is additionally capped at `ladderTimeoutMs` (10 000 ms) so the SLO cannot be met by "eventually".

Verification per kind (`VerificationSpec`, resolved by the executor): `manifest-stale` → re-run Doctor checks `binary.version_in_range`, `probe.help_commands`, `manifest.signature`; `parser-drift` → re-parse the stored failing payloads from `case.evidence.signals[].detail.raw` through the *new* `TelemetryParser` (offline, no session needed) and require zero `ParseError`; `hooks-unregistered` → Doctor `hooks.registered`/`mcp.registered`; `transport-broken` → a documented side-effect-free health check with a correlated response within `ackTimeoutMs`, or a healthy session start for `RerouteTask`; `model-missing` → the routing decision names a model present in the active manifest; `auth-drift` → Doctor `auth.status`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/maintenance/remediation/strategy-descriptor.ts
export type StrategyId = 'ReloadManifest' | 'ReRegisterHooksAndMcp' | 'SwitchTransport'
  | 'RestartPaneAndResume' | 'RerouteTask' | 'RollbackPluginOrManifest' | 'RegistryFix';
export type SafetyClass = 'safe-auto' | 'registry' | 'assisted' | 'manual';
export interface RemediationStrategyDescriptor {
  id: StrategyId; order: number; ladderStep: 1 | 2; safety: SafetyClass;
  applies: readonly DriftKind[]; budgetMs: number;
  preconditions: readonly PreconditionId[];        // evaluated by the executor into LadderContext flags
  writesFiles: boolean;                            // true ⇒ ForbiddenPathGuard applies
}
// packages/core/src/maintenance/remediation/ladder.ts   (pure; 100 % branch)
export interface LadderContext {
  now: string; confidence: number; ladderThreshold: number;
  runIndex: 0 | 1 | 2; attemptedInRun: readonly StrategyId[];
  flags: Readonly<Record<PreconditionId, boolean>>;    // cachedManifestAvailable, registryEnabled, hasTaskId, resumeSupported, …
}
export interface LadderPlan {
  attempts: readonly RemediationStrategyDescriptor[];
  handoff: 0 | 3;                                      // 3 ⇒ assisted (M10-01) / needs_human
  skipped: readonly { id: StrategyId; reason: SkipReason }[];
}
export declare function plan(c: Pick<RepairCase,'kind'|'confidence'|'ladderStep'>, d: readonly RemediationStrategyDescriptor[], ctx: LadderContext): LadderPlan;
export declare function nextBackoffMs(runIndex: 0|1|2): number;

// apps/daemon/src/application/ports/remediation.ports.ts
export interface RemediationStrategy {                 // DI map keyed by StrategyId — no switch anywhere
  readonly descriptor: RemediationStrategyDescriptor;
  evaluate(c: RepairCase, ctx: StrategyContext): Promise<Result<PreconditionReport, DomainError>>;
  apply(c: RepairCase, ctx: StrategyContext): Promise<Result<StrategyOutcome, StrategyError>>;   // never throws
}
export interface StrategyOutcome { changed: boolean; detail: Record<string, unknown>; verification: VerificationSpec; }
export type StrategyError = { code: 'PreconditionFailed'; which: PreconditionId } | { code: 'Timeout'; budgetMs: number }
  | { code: 'GuardViolation'; path: string } | { code: 'Downstream'; cause: string };
export interface RepairAttempt {
  id: string; caseId: string; runIndex: number; ladderStep: 1 | 2; strategyId: StrategyId; safety: SafetyClass;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  outcome: 'applied' | 'failed' | 'skipped' | 'timeout' | 'guard_violation';
  verified: boolean | null; evidence: Record<string, unknown>; error?: StrategyError;
}
export interface RepairAttemptRepository { append(a: RepairAttempt): Promise<Result<void, StorageError>>;
  listByCase(caseId: string): Promise<Result<RepairAttempt[], StorageError>>;
  metrics(window: { fromTs: string }): Promise<Result<{ ttrMs: number[]; ttdMs: number[] }, StorageError>>; }
export interface MaintenanceLock { acquire(holder: string, ttlMs: number): Promise<Result<Release, LockBusy>>; }
export interface VerificationRunner { run(spec: VerificationSpec, c: RepairCase): Promise<Result<{ passed: boolean; detail: Record<string, unknown> }, DomainError>>; }
export interface ForbiddenPathGuard { assertWritable(paths: readonly string[]): Result<void, { code: 'GuardViolation'; path: string; rule: string }>; }
```
Use cases (`apps/daemon/src/application/maintenance/`): `RunRemediationLadder` (reacts to `doctor.drift_detected`), `RunSingleAttempt`, `RetryRemediation` (manual, audited), `ListRepairAttempts`, `GetRemediationMetrics`.

### 4.3 Data / schema changes
- Migration `NNN-m6-04-repair-attempts`: `repair_attempts (id TEXT PK, case_id TEXT NOT NULL, run_index INTEGER NOT NULL, ladder_step INTEGER NOT NULL, strategy_id TEXT NOT NULL, safety TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, outcome TEXT NOT NULL, verified INTEGER, evidence_json TEXT NOT NULL, error_json TEXT, actor_json TEXT NOT NULL)`; index `(case_id, started_at)`, index `(strategy_id, outcome)`. Postgres-compatible types only (D8).
- `repair_cases`: `ladder_step` (exists) is updated per run; `evidence_json.metrics.ttrMs` written on close; `close_reason: 'remediated'`.
- Events: `doctor.remediation_applied` `{caseId, attemptId, strategyId, ladderStep, durationMs, verified: true, detail}`; `doctor.remediation_failed` `{caseId, attemptId, strategyId, ladderStep, durationMs, outcome, error}`; both actor `{kind:'system', id:'remediation-ladder'}` (or `{kind:'user'}` for a manual retry). `audit_log` row for every attempt with `before/after` = the changed thing (manifest version, transport name, session id, routing decision id) — never file contents.
- Config `maintenance.remediation`: `{ enabled: true, autoApply: true, ladderThreshold: 0.6, ladderTimeoutMs: 10000, attemptDefaultBudgetMs: 4000, registryAttemptBudgetMs: 30000, maxLadderRunsPerCase: 3, backoffMs: [30000,120000,600000], lockTtlMs: 60000, allowStrategies: StrategyId[] /* default all */ }`. `autoApply: false` ⇒ plans are computed and shown but every attempt waits for `RetryRemediation` (a "dry ladder" mode for cautious users).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
`apps/daemon/src/infrastructure/maintenance/strategies/*.strategy.ts`, all registered into the DI map by `RemediationModule`:
- **`ReloadManifestStrategy`** → `ManifestOverrideApplier.apply()` with the best cached version (M6-03). Filesystem writes limited to `~/.orchestra/manifests-cache/state.json`; guard-checked.
- **`ReRegisterHooksAndMcpStrategy`** → for each affected running session, re-render `launcher.preLaunchFiles(spec)` and rewrite only the files the manifest declares under `paths.hooksConfig` / `paths.mcpConfig` inside the session's worktree or the daemon-owned config dir. Writes go through `ForbiddenPathGuard` and a diff check (skip if byte-identical). It never edits a user's global CLI config outside the manifest-declared paths.
- **`SwitchTransportStrategy`** → asks the adapter for alternative transports declared in the manifest (`commands[].transport`, `features` incl. `appServer`) and sets the session's transport through `SessionSupervisor`; codex `app-server` → `exec --json` is the shipped case (ADR-009). The choice is recorded on the session so M6-07 can show "running on fallback transport".
- **`RestartPaneAndResumeStrategy`** → one `SessionSupervisor` message: stop pane, relaunch with `LaunchPlan` from the *current* manifest and the provider's documented resume flag, re-attach recording, re-derive open prompts (M5-05 path). Pane restart is the only tmux interaction in this step (D13).
- **`RerouteTaskStrategy`** → delegates to M4-03's reroute use case with `reason: 'drift'`; emits `routing.rerouted`. Never creates a new task, never re-runs a completed one.
- **`RollbackPluginOrManifestStrategy`** → `ManifestOverrideApplier.rollback()` (M6-03). "Plugin" rollback in M6 means manifest-only; rolling back npm plugin code is M10-03 and the strategy reports `skipped: PluginRollbackNotAvailable`.
- **`RegistryFixStrategy`** → `RefreshRegistry` for the one provider (M6-03) with `registryAttemptBudgetMs`; network only through the `EgressPolicy`-guarded client. Verification re-runs the same spec as `ReloadManifest`.
- **`ForbiddenPathGuardImpl`** — deny globs (C12): `**/auth*`, `**/*credential*`, any path under the vendor config dirs not declared in the active manifest, `apps/daemon/src/infrastructure/binaries/**`, `tools/eslint-rules/**`, `.eslintrc*`, `eslint.config.*`, `.dependency-cruiser.cjs`, `SECURITY.md`, `CODEOWNERS`, `~/.orchestra/config.yaml`, `~/.orchestra/token`. Allow: `~/.orchestra/manifests-cache/**`, manifest-declared `paths.hooksConfig`/`paths.mcpConfig` within a session worktree or `~/.orchestra/plugins/<provider>/`. Deny wins; anything not explicitly allowed is a violation → attempt `guard_violation` + `audit` row + case → `needs_human`.
- **`LadderExecutor`** — subscribes to `doctor.drift_detected`, acquires `MaintenanceLock` (TTL 60 s, released on process exit via the shutdown hook), walks the plan with `Promise.race(strategy.apply, timeout(budgetMs))`, calls `VerificationRunner`, appends `RepairAttempt`, emits events, writes `ttrMs`. Wall-clock timing uses the injected `Clock`.

### 4.5 API / UI surface
- `POST /api/repair-cases/:id/remediate` `{strategyId?, force?: boolean}` (`Idempotency-Key`, audited, RBAC-ready) → 202 + `runIndex`; `force` resets the loop guard once and is recorded as a user decision.
- `GET /api/repair-cases/:id/attempts` → `RepairAttempt[]` (newest first). `GET /api/health/remediation/metrics?window=30d` → `{ ttdMs: {p50,p95,n}, ttrMs: {p50,p95,n}, byStrategy: [{strategyId, applied, failed, avgMs}] }` (consumed by M6-07).
- WS topic `health.cases` gains `{event:'attempt_started'|'attempt_finished', caseId, attemptId, strategyId, outcome, durationMs}`.
- CLI: `orch repair retry <caseId> [--strategy ReloadManifest] [--force]`, `orch repair attempts <caseId> [--json]`, `orch repair metrics [--window 30d] [--json]`, `orch repair plan <caseId>` (prints the plan without executing — works with `autoApply: false`).
- No new screen. Attention gets one item when a case reaches `needs_human` (kind `repair_needs_human`, deep-linked to Health, rendered in M6-07).

### 4.6 Flow / sequence
```
doctor.drift_detected(caseId)
 → LadderExecutor: config.enabled && confidence ≥ 0.6 ? continue : case → needs_human
 → MaintenanceLock.acquire('ladder:<caseId>') (busy ⇒ retry after backoff, max 3)
 → evaluate preconditions for every descriptor → LadderContext.flags
 → plan(case, descriptors, ctx)   [R-L1..R-L3]
 → case.state = auto_fixing, ladder_step = 1
    for each attempt (ordered, budgeted):
        guard (writesFiles) → apply → VerificationRunner.run(spec)
        append RepairAttempt; emit doctor.remediation_applied|failed; ws attempt_finished
        verified ⇒ break
 → none verified and registry enabled ⇒ case.state = registry_fix, ladder_step = 2, run RegistryFix (30 s budget)
 → verified ⇒ case.state = fixed, closeReason 'remediated', metrics.ttrMs = now − classifiedAt
   else       ⇒ runIndex++ ; runIndex < 3 ? schedule retry after backoffMs : case.state = needs_human
                (handoff 3 recorded for M10-01) + Attention item
 → release lock (always, incl. crash path via shutdown hook)
```

### 4.7 Review reconciliation contract (2026-09-15)
Mutating recovery strategies require a persisted checkpoint, fresh authoritative quiescence, no unresolved delivery and a replay-safe action contract. Acquire exclusive session ownership; revoke/fence the previous generation before a new process or provider is admitted. If provider-side fencing or reconciliation cannot establish that the old execution stopped, escalate to human. A transport change to exec or another provider is a new execution with an explicit handoff package; hidden state and approvals do not transfer. Metadata-only repair may continue while execution recovery is blocked. The 10-second SLO covers eligible known repairs only; report escalation/timeout rates separately.

## 5. Tasks
- [ ] `packages/core/src/maintenance/remediation/`: `StrategyId`, `SafetyClass`, `RemediationStrategyDescriptor`, `LadderContext`, `LadderPlan`, `PreconditionId`, `SkipReason`.
- [ ] Pure `plan()` + `nextBackoffMs()` implementing R-L1…R-L3, R-L7; golden table per `DriftKind`; drive to 100 % branch coverage.
- [ ] `RemediationStrategy` port + `RemediationStrategyRegistry` (DI map, duplicate-id assertion at boot).
- [ ] `ForbiddenPathGuardImpl` with the C12 deny/allow lists + unit tests per rule (including symlink and `..` traversal attempts).
- [ ] Migration `repair_attempts`; repository (SQLite + in-memory) incl. `metrics()` percentile query.
- [ ] `MaintenanceLock` (in-process + DB-backed TTL row so a crashed run cannot wedge the host) and shutdown-hook release.
- [ ] `VerificationRunner` with the six `VerificationSpec` kinds, reusing M6-01 checks and the offline re-parse path.
- [ ] `ReloadManifestStrategy` + `RollbackPluginOrManifestStrategy` over `ManifestOverrideApplier` (M6-03).
- [ ] `ReRegisterHooksAndMcpStrategy` (render `preLaunchFiles`, diff, guarded write, skip if identical).
- [ ] `SwitchTransportStrategy` (manifest-declared alternatives only; codex app-server → `exec --json`).
- [ ] `RestartPaneAndResumeStrategy` via `SessionSupervisor` with the R-L6 refusals.
- [ ] `RerouteTaskStrategy` delegating to M4-03 with `reason: 'drift'`.
- [ ] `RegistryFixStrategy` (ladder 2) with its own budget and offline skip.
- [ ] `LadderExecutor` (event subscription, lock, budgets, backoff, loop guard, `ttrMs`) + `RunRemediationLadder`, `RunSingleAttempt`, `RetryRemediation`, `ListRepairAttempts`, `GetRemediationMetrics` use cases.
- [ ] Event registration + audit interceptor coverage for every attempt; Attention item on `needs_human`.
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS `health.cases` attempt frames.
- [ ] `apps/cli/src/commands/repair.ts`: `retry`, `attempts`, `metrics`, `plan`.
- [ ] FakeProvider scenarios per strategy (`remediate-manifest-stale.yaml`, `remediate-transport.yaml`, `remediate-model-missing.yaml`, `remediate-unfixable.yaml`) + a loop scenario that re-drifts after each fix.
- [ ] `apps/daemon` maintenance README: how to add a strategy, what the guard forbids, why auth is not on the list.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-04-01 | unit | `plan()` per `DriftKind` × precondition flag combinations (golden table) | exact ordered `StrategyId[]`, `skipped` reasons, `handoff` value; 100 % branch |
| UT-M6-04-02 | unit | R-L4: `auth-drift` with every flag true | plan contains only `RerouteTask`; no manifest/pane/credential strategy is ever planned |
| UT-M6-04-03 | unit | R-L2 / R-L7: confidence 0.55; and `runIndex: 2` after 3 failed runs | empty plan + `handoff: 3`; backoffs `30s/120s/600s` |
| UT-M6-04-04 | unit | `ForbiddenPathGuard` over `~/.orchestra/token`, `**/auth-probe.ts`, `.eslintrc.cjs`, a `..` escape, a symlink into `$HOME/.claude` | every one is a `GuardViolation` naming the rule; allowed paths pass |
| UT-M6-04-05 | unit (fast-check) | `plan()` over random contexts | never throws; never returns a `safe-auto` attempt after a `registry` one; no duplicate ids |
| AT-M6-04-01 | application | ladder run where attempt 1 fails verification and attempt 2 verifies | two `repair_attempts` rows (`failed`, `applied`); case `fixed`; one `doctor.remediation_applied` |
| AT-M6-04-02 | application | strategy that hangs past its budget | attempt `timeout` at `budgetMs`±100 ms; plan continues; no orphan promise (open-handle assertion) |
| AT-M6-04-03 | application | strategy attempting to write `~/.orchestra/token` | `guard_violation`; case → `needs_human`; `audit_log` row; nothing written (file mtime unchanged) |
| AT-M6-04-04 | application | `MaintenanceLock` held by a simulated canary | ladder defers, retries after backoff, never runs concurrently; lock released on holder crash after TTL |
| IT-M6-04-01 | integration | FakeProvider `remediate-manifest-stale.yaml` + fixture registry: no cached fix available | ladder-1 exhausts, ladder 2 `RegistryFix` fetches `fake@1.1.0`, verification passes, case `fixed`, `ladder_step: 2` |
| IT-M6-04-02 | integration | `RestartPaneAndResume` on a live FakeProvider pane | pane restarts, session resumes, recording continues in the same file, no prompt lost (M5-05 assertions reused) |
| IT-M6-04-03 | integration | `metrics()` over 30 seeded attempts | p50/p95 match a reference computation; `byStrategy` counts correct |
| E2E-M6-04-01 | e2e | inject parser drift → watch to `fixed` via WS | `attempt_started`/`attempt_finished`/case `fixed` frames in order; `ttrMs` present and < 10 000 ms |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-04-01 | Ladder-1 happy path (manifest reload) | 1. Cache `fake@1.1.0` (which knows the new event). 2. `orch doctor simulate unknown-event --provider fake`. 3. Watch `orch repair attempts <caseId> --json`. | Case opens `parser-drift`, `ReloadManifest` applied and verified, case `fixed`, one applied attempt, zero failed | ⬜ |
| TC-M6-04-02 | **Safe-remediation SLO < 10 s** | 1. Repeat TC-01 ten times with fresh fingerprints. 2. Read `evidence.metrics.ttrMs` per case and `orch repair metrics --window 1d`. | All 10 `ttrMs` < 10 000 ms; p95 recorded in the log; per-attempt `duration_ms` within each strategy's budget | ⬜ |
| TC-M6-04-03 | Ladder-2 registry fix | 1. Clear the manifest cache. 2. Publish `fake@1.1.0` to the fixture registry. 3. Inject the same drift. | Ladder-1 strategies skip/fail, `RegistryFix` fetches + applies, case `fixed` with `ladder_step: 2`; total time recorded separately (registry budget 30 s, not the 10 s SLO) | ⬜ |
| TC-M6-04-04 | Transport switch (codex path, dry) | 1. Force `transport-broken` for codex using the recorded app-server error fixture (FakeProvider replay — no real account). 2. Observe attempts. | `SwitchTransport` selects `exec --json` (documented fallback, ADR-009), verification sends a no-op command and gets an ack, case `fixed`; session shows "fallback transport" | ⬜ |
| TC-M6-04-05 | **Negative: auth drift is never auto-fixed** | 1. `orch doctor simulate auth-lost --provider fake`. 2. `orch repair plan <caseId>`; then let the ladder run. | Plan contains only `RerouteTask` (or is empty when no task); no login flow opens; no write under any credential path; case ends `needs_human` with a clear reason | ⬜ |
| TC-M6-04-06 | **Negative: guard blocks a forbidden write** | 1. Enable the test-only `EvilStrategy` (dev build) that writes `~/.orchestra/token`. 2. Trigger a case. 3. `ls -l ~/.orchestra/token`; `orch repair attempts <caseId>`. | Attempt `guard_violation`; token mtime unchanged; case → `needs_human`; `audit_log` row names the rule; daemon keeps running | ⬜ |
| TC-M6-04-07 | Audit completeness | 1. After TC-01…TC-06, run `sqlite3 orchestra.db "select action,target from audit_log where action like 'remediation%'"` and `select type,count(*) from events where type like 'doctor.remediation%' group by type`. | One audit row and one event per attempt; counts match `repair_attempts`; every row carries actor, strategy and duration | ⬜ |
| TC-M6-04-08 | **Resilience: remediation loop is capped** | 1. Run `remediate-loop.yaml` (fix succeeds, drift returns 20 s later, forever). 2. Wait 20 min. | Exactly 3 ladder runs with 30 s/2 min/10 min spacing, then `needs_human` + one Attention item; no further automatic attempts; no runaway CPU | ⬜ |
| TC-M6-04-09 | **Resilience: crash mid-attempt** | 1. Start a ladder run with a slow strategy. 2. `kill -9` the daemon during the attempt. 3. Restart. | Attempt row exists with `outcome: failed` (reconciled on boot, not left `running`); the `MaintenanceLock` row expires and the next run proceeds; no partial manifest applied | ⬜ |
| TC-M6-04-10 | Manual retry & dry ladder | 1. Set `autoApply: false`. 2. Trigger a case; run `orch repair plan <caseId>`. 3. `orch repair retry <caseId> --strategy ReloadManifest`. | With `autoApply: false` nothing runs automatically; `plan` prints the ordered attempts with preconditions; the manual retry executes exactly one strategy, audited with `actor.kind: user` | ⬜ |
| TC-M6-04-11 | No work destroyed (R-L6) | 1. Open a prompt in a FakeProvider session (leave it unanswered). 2. Force `transport-broken`. | `RestartPaneAndResume` is skipped with reason `UnansweredPromptTooRecent`; after 30 s + answer it may run; the worktree diff and the recording file are byte-identical before/after the restart | ⬜ |

### 6.3 Review regression scenarios
- [ ] Old unanswered prompt (>30 seconds) still blocks restart.
- [ ] Missing telemetry with potentially completed external action blocks restart/reroute.
- [ ] Old process resumes after ownership transfer: generation rejected; uncertain provider activity escalated.
- [ ] Known quiescent checkpoint can recover once; no duplicate external effects.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] All TC-M6-04-01 … 11 pass and are recorded with build hash and date.
- [ ] `RemediationLadder.plan()`, `nextBackoffMs()` and `ForbiddenPathGuard` have **100 % branch coverage** (CI gate).
- [ ] p95 `ttrMs` for ladder-1 strategies over ≥ 10 injected cases is **< 10 000 ms**; every attempt stays inside its declared budget (TC-02).
- [ ] Ladder 2 (`RegistryFix`) closes a case that ladder 1 cannot, using a signed manifest from M6-03 (TC-03).
- [ ] Every attempt produces exactly one `repair_attempts` row, one `doctor.remediation_applied|failed` event and one `audit_log` row (TC-07).
- [ ] No strategy can write to any C12-forbidden path; the guard is proven by an adversarial test (TC-06, UT-04) and auth is structurally excluded (TC-05).
- [ ] Loop guard, backoff and `MaintenanceLock` hold under the loop and crash scenarios (TC-08, TC-09).
- [ ] `RestartPaneAndResume` never loses a prompt, a recording byte or worktree state (TC-11, reusing M5-05 assertions).
- [ ] No new lint/dependency-cruiser violations; no `switch (strategyId)` anywhere; tmux touched only via `SessionSupervisor` (D13).
- [ ] `apps/daemon` maintenance README documents adding a strategy and the guard rules; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Remediation that makes things worse** is the central risk: every strategy is reversible (manifest rollback, transport switch back, reroute to the original candidate) and verification gates the close. Anything irreversible is by definition not `safe-auto`.
- The 10 s SLO assumes an apply-from-cache path of < 2 s (M6-03 TC-10) and a pane restart of < 6 s; if a real CLI's cold start exceeds that, `RestartPaneAndResume` moves out of the SLO set and the SLO is reported per strategy rather than the budget being padded. **Verify real cold-start times for claude/codex at step start.**
- Whether `codex` supports switching an already-running session's transport, or whether the pane must restart, is unresolved — **verify against Codex docs at step start**; if a restart is required, `SwitchTransport` declares `RestartPaneAndResume` as a prerequisite and the pair shares one budget.
- Resume semantics differ per vendor (`--resume`, `--continue`, session id) — the strategy uses `manifest.limits.resume` plus the documented flag from the manifest only; **verify against Claude Code / Codex / Antigravity docs at step start**. agy stays behind the ToS acknowledgement (C11).
- Re-registering hooks/MCP touches files a user may also edit by hand; the strategy writes only manifest-declared paths, skips byte-identical content, and records a diff in the attempt evidence. A user-edited hooks file that differs is reported, not overwritten, when `maintenance.remediation.preserveUserEdits` (default true) is set.
- `repair_attempts` grows with every noisy provider; retention folds into the M5-06 purge job (keep 90 days) — coordinate in that step's log.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
