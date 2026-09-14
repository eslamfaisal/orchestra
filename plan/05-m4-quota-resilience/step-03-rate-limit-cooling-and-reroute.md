# Step M4-03 — Rate-limit cooling & reroute

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-02, M2-04 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk` (FakeProvider scenarios), `apps/daemon` (application/quota, application/routing, infrastructure/quota, interface/http, interface/ws) |
| Risk | High |
| Owner | |

## 1. Goal
After this step a `RateLimitSignal` from any provider puts that provider into a **cooling** state until the vendor-reported `resetAt` (or, when the vendor gave no reset time, for a bounded, explicitly *estimated* backoff). While a provider is cooling the assignment engine refuses to place new work on it, the task that hit the limit is **rerouted at most once per task per window** to the next capable provider with a new persisted `RoutingDecision` whose reason is `rerouted: rate-limited`, and an Attention item explains what happened. When no fallback exists the task is parked in `blocked` with `reason: quota` and waits for the reset instead of retrying. Cooling state, the retry ledger and the parked queue survive a daemon restart. By construction there are no retry storms: retries are gated by a persisted ledger keyed on `(taskId, providerId, windowKind, windowStartedAt)`, not by an in-memory counter.

## 2. Why
- **C5 is the hard rule of this step**: "rate limits respected — cooling until `resetAt` + backoff; max one retry per task per window (M4-03)". It is a compliance control, not a UX nicety; the tests exist to prove it to a reviewer.
- **G4 (never blocked)**: a 429 on one provider must move the work, not stop the fleet. `01-vision-scope.md` user story: "When a provider hits 429 / window exhaustion, work reroutes and I am told."
- **D3**: the reroute decision is made by the deterministic engine (M2-04) with a constraint strategy, never by an LLM and never by a hard-coded fallback list.
- **D4 / C7**: cooling is triggered only by structured signals from `RateLimitParser` (M4-01) — vendor payloads, exit codes, app-server errors — never by matching text in PTY bytes.
- **C6**: cooling composes with `manifest.limits.maxConcurrentSessions`; both are constraints on the same admission path in `SessionSupervisor`.
- **UX principle 5 (zero-surprise control)**: the user sees *why* a task moved (Attention item + routing reasons), and `01-vision-scope.md` KPI "reroute success rate" starts being measurable here (rendered in M4-07).

## 3. Scope
### In scope
- Core: `ProviderAvailability` value object + `CoolingRule` (pure: signal → cooling window, backoff ladder, expiry, rollover) and `RetryLedgerRule` (pure: may this task retry on this provider in this window?).
- Core: `CoolingConstraint` — a constraint strategy registered into the M2-04 engine's constraint map (0/1 gate), plus `RerouteReason` reason codes.
- Daemon: `ApplyRateLimitSignal` (M4-01) extended to open a cooling period; use cases `RerouteTask`, `ReleaseCooling`, `GetProviderAvailability`, `ListTaskRetries`.
- Persistence: `provider_cooling` and `task_retries` tables; both consulted on boot.
- Admission guard in `SessionSupervisor` (M1-02): refuse to launch a session on a cooling provider even if something asks for it directly.
- Attention items `quota.rerouted` and `quota.blocked`; events `routing.rerouted`, `quota.cooling_started`, `quota.cooling_ended`, `task.blocked`.
- `POST /providers/:id/cooling/clear` (manual override, audited, only valid when the cooling was an *estimate*).
- FakeProvider scenarios: `rate-limit-429.yaml` (with `resetAt`), `rate-limit-no-reset.yaml` (`retryAfterMs` only / neither), `rate-limit-storm.yaml` (repeated 429 on every turn).
### Out of scope (deferred to …)
- Pre-emptive rerouting at forecast thresholds before any 429 — deferred to M4-04 (reserves make the engine avoid a provider *before* it is limited).
- Reserves and per-mission budgets — deferred to M4-04.
- Lead session exhaustion and mission handoff — deferred to M4-05 (a cooling Lead provider parks the mission here; M4-05 hands it over).
- Whole-mission simulation of reroutes — deferred to M4-06.
- Cooling badges, countdowns, reroute KPI tile — deferred to M4-07.
- Turning a repeated unparseable rate-limit payload into a `RepairCase` — deferred to M6-02.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/quota/cooling/{provider-availability.ts, cooling-rule.ts, retry-ledger-rule.ts, cooling-constraint.ts}`.

Rules (100 % branch coverage in `cooling-rule.spec.ts` / `retry-ledger-rule.spec.ts`):
- **R-C1 Vendor time wins.** If `RateLimitSignal.resetAt` is present, `coolingUntil = resetAt` and `coolingConfidence = 'official'`. Else if `retryAfterMs` is present, `coolingUntil = observedAt + retryAfterMs`, `confidence = 'official'`. Else the backoff ladder applies with `confidence = 'estimate'`.
- **R-C2 Bounded backoff ladder.** With no vendor time: `1 min, 2, 5, 15, 30, 60 min`, indexed by the number of signals already seen for `(provider, windowKind)` inside the current window, capped at 60 min. Never exponential without a cap, never below 60 s.
- **R-C3 Extend, never shorten.** A new signal while cooling may only move `coolingUntil` later (`max(current, next)`), and an `official` time always replaces an `estimate` even if earlier. Cooling is never shortened by a new signal.
- **R-C4 One retry per task per window.** `RetryLedgerRule.mayRetry(entries, taskId, providerId, windowKind, windowStartedAt)` is `true` only when no entry exists for that exact 4-tuple. Reroute to a *different* provider is not a retry on the original provider and consumes only the original provider's ledger entry (the destination gets its own entry only if it also rate-limits).
- **R-C5 Never reroute to a cooling provider.** The candidate set handed to the engine excludes every provider whose `coolingUntil > now`, and the `CoolingConstraint` returns `0` for them, so even a stale candidate list cannot produce a bad decision.
- **R-C6 No fallback ⇒ park, do not retry.** If the engine returns no candidate, the task moves to `blocked` with `reason: 'quota'` and `unblockAt = min(coolingUntil of capable providers)`. Parked tasks are re-admitted by `ReleaseCooling`, not by a timer that retries blindly.
- **R-C7 Cooling ends by time, not by hope.** `ReleaseCooling` fires at `coolingUntil` (scheduled from the persisted value, re-armed on boot) and emits `quota.cooling_ended`. A provider is not probed to "check if it is back"; the next real task is the probe.
- **R-C8 Window rollover clears the ledger.** Ledger entries are scoped to `windowStartedAt`; when the window rolls over (M4-01 R-W3) old entries stop matching, so a task may be retried once in the *next* window. Entries are purged after 30 days.
- **R-C9 Idempotent signals.** Two signals with the same `(source, externalId)` produce exactly one cooling period and at most one reroute (the M4-01 idempotency key is reused).

### 4.2 Interfaces / contracts
```ts
// packages/core/src/quota/cooling/provider-availability.ts
export type AvailabilityState = 'available' | 'cooling' | 'disabled';

export interface ProviderCooling {
  providerId: ProviderId;
  windowKind?: WindowKind;          // absent when the vendor did not say which window
  startedAt: string;                // ISO-8601 UTC
  coolingUntil: string;
  confidence: Confidence;           // 'official' when from resetAt/retryAfterMs, else 'estimate'
  backoffStep: number;              // 0 when vendor time was used, 1..6 on the ladder
  reason: 'rate_limited' | 'window_exhausted';
  signalId: string;                 // the RateLimitSignal that opened/extended it
}

export interface ProviderAvailability {
  providerId: ProviderId;
  state: AvailabilityState;
  cooling?: ProviderCooling;
  worstForecastLevel: ForecastLevel;   // from M4-02, for explainability only
}

// packages/core/src/quota/cooling/cooling-rule.ts
export interface CoolingParams { ladderMinutes: readonly number[]; maxMinutes: number; }   // [1,2,5,15,30,60], 60
export function applyRateLimit(
  current: ProviderCooling | null, signal: RateLimitSignal, params: CoolingParams, now: IsoTimestamp,
): ProviderCooling;                                        // R-C1…R-C3, total, never throws
export function isCooling(c: ProviderCooling | null, now: IsoTimestamp): boolean;

// packages/core/src/quota/cooling/retry-ledger-rule.ts
export interface RetryLedgerEntry {
  taskId: string; providerId: ProviderId; windowKind: WindowKind | 'unknown';
  windowStartedAt: string; attemptAt: string; outcome: 'rerouted' | 'retried' | 'blocked';
}
export function mayRetry(entries: readonly RetryLedgerEntry[], key: Omit<RetryLedgerEntry, 'attemptAt' | 'outcome'>): boolean;   // R-C4

// packages/core/src/quota/cooling/cooling-constraint.ts
/** Registered in the M2-04 constraint map under id 'cooling'. Pure 0/1 gate (06 §3). */
export const coolingConstraint: AssignmentConstraint;      // (candidate, ctx) => { pass: boolean; reason?: string }

// packages/core/src/routing/reasons.ts (addition)
export type RerouteReason = 'rerouted: rate-limited' | 'rerouted: cooling' | 'blocked: quota';
```
```ts
// apps/daemon/src/application/quota/ports.ts (additions)
export interface ProviderCoolingRepository {
  upsert(c: ProviderCooling): Promise<Result<void, StorageError>>;
  get(providerId: ProviderId): Promise<Result<ProviderCooling | null, StorageError>>;
  listActive(now: string): Promise<Result<ProviderCooling[], StorageError>>;
  clear(providerId: ProviderId): Promise<Result<void, StorageError>>;
}
export interface TaskRetryRepository {
  append(e: RetryLedgerEntry): Promise<Result<'inserted' | 'duplicate', StorageError>>;
  listForTask(taskId: string): Promise<Result<RetryLedgerEntry[], StorageError>>;
}
export type RerouteError =
  | { code: 'RETRY_BUDGET_EXHAUSTED'; taskId: string; providerId: ProviderId; windowKind: string }
  | { code: 'NO_CANDIDATE'; taskId: string; unblockAt?: string }
  | { code: 'TASK_NOT_REROUTABLE'; taskId: string; state: TaskState };
```
Use cases (`apps/daemon/src/application/quota/`, one class each): `ApplyRateLimitSignal` (extended from M4-01), `RerouteTask`, `ReleaseCooling`, `GetProviderAvailability`, `ListTaskRetries`, `ClearCooling`.

### 4.3 Data / schema changes
Migration `<next>-m4-03-cooling-and-retries.ts` (additive):
- `provider_cooling`: `provider_row_id` (PK), `window_kind`, `started_at`, `cooling_until`, `confidence`, `backoff_step`, `reason`, `signal_id`, `updated_at`.
- `task_retries`: `id` (ULID), `task_id`, `provider_id`, `window_kind`, `window_started_at`, `attempt_at`, `outcome`, `routing_decision_id`; **unique `(task_id, provider_id, window_kind, window_started_at)`** — the database, not application code, is the final guarantee behind C5.
- `tasks` + `blocked_reason` already exists (M3-02); add `unblock_at TEXT NULL`.
- `routing_decisions` (schema v1) + `supersedes_id TEXT NULL` so a reroute decision links to the decision it replaces; `reasons_json` carries the `RerouteReason`.
- Events: `quota.cooling_started`, `quota.cooling_ended` (new in the `quota.*` namespace), `routing.rerouted` (already in the catalog), `task.blocked` (new in `task.*`). Note the additions in `04-domain-model.md` §3 when the step closes.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Admission guard**: `SessionSupervisor` (M1-02, D13) gains a pre-launch check `ProviderAdmission.check(providerId)` returning `Err(PROVIDER_COOLING)`. Every launch path (Quick Delegate, mission scheduler, reroute, manual *Start session* in Fleet) goes through it, so nothing can bypass cooling. Manual start from the UI shows the cooling reason and a *Start anyway* affordance only when the cooling is an `estimate` (audited, R-C1).
- **Session teardown**: the session that produced the signal is stopped gracefully (`PaneController` stop → tmux window kept until the recorder flushes, per M5-01 conventions) before the reroute launches elsewhere, so two panes never work the same worktree. The worktree and branch are reused by the rerouted task; the new session starts with a short continuation prompt composed from the last `TaskResult` draft if one exists (M3-03), otherwise from the original `TaskSpec`.
- **Cooling timer**: `apps/daemon/src/infrastructure/quota/cooling.scheduler.ts` — one timer per active cooling, armed from `provider_cooling.cooling_until`, re-armed on boot from `listActive`, fires `ReleaseCooling`, tolerates a missed deadline (a timer in the past fires immediately). Uses the injected `Clock`; fake timers in tests.
- **Parked queue**: blocked tasks are re-admitted in `unblock_at` order on `quota.cooling_ended`, throttled to `missions.maxParallelTasks` by the existing `MissionScheduler` (M3-02).
- **FakeProvider**: scenario steps `emit-rate-limit {windowKind, resetAt? , retryAfterMs?}` (from M4-01) plus `repeat: n` so `rate-limit-storm.yaml` can emit a 429 on every turn; the fake never sleeps on its own — the daemon's cooling is what stops it.
- No new network egress (`no-vendor-endpoints` unchanged); no provider is probed to test recovery (R-C7).

### 4.5 API / UI surface
- `GET /providers/:id/availability` → `ProviderAvailability`.
- `GET /fleet/availability` → `ProviderAvailability[]`.
- `POST /providers/:id/cooling/clear` (`Idempotency-Key`, audited) → `200` when the cooling `confidence` is `estimate`; `409 CoolingOfficial` when it came from a vendor `resetAt`/`retryAfterMs` (we do not let the user override a vendor's own reset time — C5).
- `GET /tasks/:id/retries` → `RetryLedgerEntry[]`; `GET /tasks/:id/routing` (M2-09) now lists the superseding chain.
- WS `/ws` topic `quota`: `quota.cooling_started`, `quota.cooling_ended`; topic `routing`: `routing.rerouted`.
- Attention (M1-11 platform items):
  - `quota.rerouted` — "codex rate-limited — task *Add pagination* rerouted to claude (rerouted: rate-limited). Resets 14:20." Actions: *Open task*, *Open Fleet*. Auto-resolves when the task reaches a terminal state.
  - `quota.blocked` — "Task *Add pagination* blocked: every capable provider is cooling until 14:20." Actions: *Open task*, *Change policy*.
- Fleet/Board render `state: cooling` from `GET /fleet/availability` as plain text in this step; the badge, countdown and shading are M4-07.

### 4.6 Flow / sequence
```
pane/app-server ─429─▶ RateLimitParser (M4-01) ─▶ RateLimitSignal
  └─▶ ApplyRateLimitSignal
        ├─ idempotency (source, externalId) — duplicate ⇒ stop                      (R-C9)
        ├─ WindowLedger.apply(signal)  ─▶ quota.window_updated                      (M4-01)
        ├─ applyRateLimit(current, signal, params, now) ─▶ ProviderCooling          (R-C1…R-C3)
        ├─ upsert provider_cooling ─▶ quota.cooling_started ─▶ /ws quota
        ├─ arm cooling timer at coolingUntil                                        (R-C7)
        └─ signal.sessionId → task? ─▶ RerouteTask(taskId, fromProvider)
RerouteTask
  ├─ mayRetry(ledger, {taskId, fromProvider, windowKind, windowStartedAt})?         (R-C4)
  │    no ─▶ Err(RETRY_BUDGET_EXHAUSTED) ─▶ task → blocked(reason: quota)           (C5)
  ├─ append task_retries (unique index = second guarantee)                          (R-C4)
  ├─ stop the rate-limited session (graceful, recorder flushed)
  ├─ AssignmentEngine.decide(taskSpec, {excludeProviders: coolingProviders})        (R-C5)
  │    no candidate ─▶ task → blocked(reason: quota, unblockAt) ─▶ Attention quota.blocked  (R-C6)
  ├─ persist RoutingDecision {reasons: ['rerouted: rate-limited'], supersedesId}
  ├─ StartSession on the chosen provider, same worktree/branch, continuation prompt
  └─ emit routing.rerouted ─▶ Attention quota.rerouted
coolingUntil reached ─▶ ReleaseCooling ─▶ clear provider_cooling ─▶ quota.cooling_ended
  └─▶ re-admit blocked tasks whose unblockAt ≤ now, in order, via MissionScheduler  (R-C6)
```

## 5. Tasks
- [ ] `packages/core/src/quota/cooling/`: `ProviderCooling`, `ProviderAvailability`, `applyRateLimit`, `isCooling`, `mayRetry` implementing R-C1…R-C9; 100 % branch tests.
- [ ] `coolingConstraint` registered in the M2-04 constraint map; extend the engine's `DecideOptions` with `excludeProviders`; update engine golden tests (cooling provider never chosen, reason recorded).
- [ ] Migration `m4_03_cooling_and_retries` (incl. the unique index on `task_retries`) + Kysely repositories + in-memory doubles.
- [ ] Extend `ApplyRateLimitSignal` (M4-01) to open/extend cooling, emit `quota.cooling_started`, arm the timer, and trigger `RerouteTask` when the signal carries a `sessionId` bound to a task.
- [ ] `RerouteTask` use case: ledger check → append → stop session → engine decide → persist `RoutingDecision` (`supersedesId`) → `StartSession` → events.
- [ ] `ReleaseCooling` use case + `CoolingScheduler` (boot re-arm, past-deadline tolerance, per-provider single timer).
- [ ] Blocked-task handling: `tasks.blocked_reason = 'quota'`, `unblock_at`, re-admission on `quota.cooling_ended` through the existing `MissionScheduler`.
- [ ] `ProviderAdmission` guard in `SessionSupervisor`; every launch path routed through it; `Start anyway` allowed only for `estimate` coolings, audited.
- [ ] Attention items `quota.rerouted`, `quota.blocked` (raise + auto-resolve).
- [ ] HTTP: availability endpoints, `POST /providers/:id/cooling/clear`, `GET /tasks/:id/retries`; DTOs + OpenAPI; WS topics.
- [ ] Continuation-prompt composer for a rerouted task (reuses the `TaskSpec` renderer from M3-03; includes "a previous attempt on `<provider>` stopped because of a rate limit").
- [ ] FakeProvider scenarios `rate-limit-429.yaml`, `rate-limit-no-reset.yaml`, `rate-limit-storm.yaml`.
- [ ] Config keys `quota.cooling.ladderMinutes`, `quota.cooling.maxMinutes`, `quota.reroute.enabled`, behind `features.quota`.
- [ ] Retry-ledger purge job (30 d) folded into the M4-01 purge.
- [ ] Docs: `apps/daemon/README` "Rate limits & rerouting" section stating the C5 guarantee and where it is enforced; add the new events to `04-domain-model.md` §3; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-03-01 | unit | `applyRateLimit` with `resetAt` / with `retryAfterMs` / with neither (steps 1…7) | official cooling to `resetAt` / to `observedAt+retryAfterMs` / ladder 1,2,5,15,30,60,60 min with `confidence: 'estimate'` |
| UT-M4-03-02 | unit | new signal while cooling: earlier `resetAt`, later `resetAt`, estimate over official | never shortened; later wins; official replaces estimate (R-C3) |
| UT-M4-03-03 | unit | `mayRetry` across window rollover and across providers | one retry per `(task, provider, kind, windowStartedAt)`; new `windowStartedAt` allows one more; a different provider is independent |
| UT-M4-03-04 | unit | `coolingConstraint` for cooling / just-expired / available provider | `0 / 1 / 1` with a reason string on the `0` |
| UT-M4-03-05 | unit (property, fast-check) | random signal sequences and clocks | `coolingUntil` non-decreasing within a window; never more than `maxMinutes` beyond `now` for estimates; never throws |
| AT-M4-03-01 | application | **100 simulated 429s across 20 tasks on one provider** | ≤ 1 `task_retries` row per `(task, provider, window)`; exactly one cooling period; ≤ 20 `routing.rerouted` events; **zero** new sessions on the cooling provider |
| AT-M4-03-02 | application | 429 with no capable fallback | task `blocked` with `reason: quota` and `unblockAt = coolingUntil`; `quota.blocked` item; no session started; no retry consumed on any other provider |
| AT-M4-03-03 | application | duplicate signal `(source, externalId)` | one cooling, one reroute, one Attention item (R-C9) |
| AT-M4-03-04 | application | `ReleaseCooling` at `coolingUntil` with two parked tasks | `quota.cooling_ended`; both tasks re-admitted in `unblockAt` order within one scheduler tick |
| AT-M4-03-05 | application | `POST /cooling/clear` on an official cooling / on an estimate cooling | `409 CoolingOfficial` / cleared + audit row + `quota.cooling_ended` |
| IT-M4-03-01 | integration | unique-index enforcement: two concurrent `RerouteTask` for the same task | one succeeds, one returns `RETRY_BUDGET_EXHAUSTED`; exactly one new session (DB is the final guard) |
| IT-M4-03-02 | integration | `kill -9` mid-cooling, restart | cooling restored with the same `coolingUntil`; timer re-armed; no duplicate `routing.rerouted` for already-rerouted tasks |
| E2E-M4-03-01 | e2e (Playwright + FakeProvider) | `rate-limit-429.yaml` on `fake-a` with `fake-b` available | Attention shows the reroute item; Board shows the task on `fake-b`; `GET /tasks/:id/routing` returns two decisions, the second with reason `rerouted: rate-limited` and `supersedesId` set |
| E2E-M4-03-02 | e2e (Playwright + FakeProvider) | `rate-limit-storm.yaml` on both fakes | both cool; task parked `blocked`; after the shorter cooling ends the task resumes exactly once |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-03-01 | FakeProvider 429 with `resetAt` → reroute | 1. Quick Delegate a task to `fake-a` with scenario `rate-limit-429.yaml` (`resetAt` = now + 30 min). 2. Watch Attention, Board and `GET /fleet/availability`. | Within 5 s: `fake-a` `state: "cooling"`, `coolingUntil` = the scenario's `resetAt`, `confidence: "official"`; the task is running on `fake-b`; Attention item names both providers and the reason `rerouted: rate-limited`; `GET /tasks/:id/retries` has exactly one row. | ⬜ |
| TC-M4-03-02 | No retry storm under load (C5) | 1. Start 20 tasks on `fake-a`, all with `rate-limit-storm.yaml`. 2. Let them all hit the limit. 3. `GET /tasks/:id/retries` for five of them; count `sessions` rows for `fake-a` after the first signal. | Each task has ≤ 1 retry row for `(fake-a, 5h, <windowStartedAt>)`; zero new `fake-a` sessions after cooling started; one `quota.cooling_started` event, not 20. | ⬜ |
| TC-M4-03-03 | No `resetAt` ⇒ bounded, labelled backoff | 1. Run `rate-limit-no-reset.yaml` on `fake-a` three times in a row (let each cooling expire). 2. Read `GET /providers/fake-a/availability` after each. | Cooling durations 1 min, 2 min, 5 min; each `confidence: "estimate"`, `backoffStep` 1/2/3; never above `maxMinutes` (60); the UI/API never presents the estimate as a vendor reset time. | ⬜ |
| TC-M4-03-04 | Negative: no fallback ⇒ park, not retry | 1. Disable every provider except `fake-a` in `workspace.yaml`. 2. Trigger `rate-limit-429.yaml`. | Task state `blocked`, `blocked_reason: "quota"`, `unblock_at` = `coolingUntil`; Attention `quota.blocked`; no new session anywhere; when cooling ends the task starts again exactly once. | ⬜ |
| TC-M4-03-05 | Negative: manual override refused on an official cooling | 1. While `fake-a` cools from a vendor `resetAt`, `POST /providers/fake-a/cooling/clear`. 2. Then repeat during an `estimate` cooling (TC-03 state). | First: `409 CoolingOfficial`, cooling unchanged, audit row for the attempt. Second: `200`, cooling cleared, `quota.cooling_ended` emitted, audit row with actor = user. | ⬜ |
| TC-M4-03-06 | Admission guard on a manual start | 1. While `fake-a` is cooling (official), open Fleet and try *Start session* on `fake-a`. | Refused with the cooling reason and reset time; no tmux window created; *Start anyway* is not offered for an official cooling. | ⬜ |
| TC-M4-03-07 | Restart during cooling | 1. With `fake-a` cooling and one task parked, `kill -9` the daemon. 2. Restart. 3. Wait for `coolingUntil`. | After restart `GET /fleet/availability` shows the same `coolingUntil`; no reroute is re-issued for the already-rerouted task; at `coolingUntil` the parked task starts exactly once. | ⬜ |
| TC-M4-03-08 | Real rate limit, observed safely | 1. **Do not provoke a limit** (C5). Work normally until one occurs on Claude Code or Codex; alternatively replay a recorded fixture: `pnpm --filter @orchestra/daemon fixtures:replay codex rpc/429.json --session <running-session-id>` (dev-only, `features.devTools`, localhost). 2. Observe Attention, availability and the task. | The real/replayed signal produces the same behaviour as the fake: cooling with the vendor's `resetAt` (`confidence: official`), one reroute, one Attention item, one ledger row. Nothing retries against the vendor while cooling. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] **C5 proven**: AT-M4-03-01 (100 simulated 429s) and TC-M4-03-02 show ≤ 1 retry per task per provider per window and zero launches on a cooling provider; the `task_retries` unique index makes this true even under concurrency (IT-M4-03-01).
- [ ] Cooling always ends by elapsed time, never by probing a vendor; no new egress and no new child process is introduced by this step.
- [ ] Vendor-provided `resetAt`/`retryAfterMs` is always preferred and never shortened or overridden; estimated coolings are labelled `estimate` everywhere they surface.
- [ ] A rerouted task has a second persisted `RoutingDecision` with reason `rerouted: rate-limited` and `supersedesId` pointing at the first; `GET /tasks/:id/routing` shows the chain.
- [ ] With no capable fallback the task parks in `blocked` with `unblockAt` and resumes exactly once after `quota.cooling_ended`.
- [ ] Cooling state, retry ledger and parked tasks survive `kill -9` + restart with no duplicate reroutes (TC-M4-03-07).
- [ ] `CoolingRule` and `RetryLedgerRule` at 100 % branch coverage; property test UT-M4-03-05 green at ≥ 1 000 runs.
- [ ] All TC-M4-03-01…08 pass and are recorded with build hash and date.
- [ ] No new ESLint / dependency-cruiser violations; `no-pty-regex` and `no-vendor-endpoints` still green; CI touched no real account (C9).
- [ ] New events documented in `04-domain-model.md` §3; `PROGRESS.md` row updated.

## 8. Risks / open questions
- Whether a vendor 429 carries a machine-readable reset time on every channel (headers vs body vs exit text) differs per provider — verify against Claude Code, Codex and Antigravity docs at step start. Where it does not, the estimate ladder applies and the UI must say so.
- Which window a signal belongs to is sometimes unstated (`windowKind` optional). The ledger then keys on `'unknown'`, which is deliberately coarse: it consumes the retry budget for that task on that provider until the *shortest* declared window rolls over. Conservative on purpose (C5).
- Rerouting mid-task assumes the worktree is in a sane state. If the rate-limited agent left uncommitted work, the continuation prompt tells the new agent to inspect `git status` first; a cleaner contract (checkpoint commits) belongs to M3-03 follow-up, not here.
- Stopping the rate-limited session races the recorder flush (M5-01 is not built yet). Until M5-01, the tmux window is killed after a short grace period; revisit when the recorder lands.
- Cooling is per *provider*, not per account or per model. A limit that applies only to one model (e.g. a premium tier) will over-cool the whole provider. Acceptable for M4; per-model cooling needs `windowKind` + model attribution and is a candidate follow-up for M8-06.
- `Start anyway` on an estimated cooling is a deliberate escape hatch for a wrong estimate. It is audited and never offered for official coolings; if it turns out to be abused it should be removed rather than widened.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
