# Step M4-06 — Dry-run simulation

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-02, M3-08 |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core`, `apps/daemon` (application/routing, interface/http), `apps/web` (Missions screen), `packages/catalog` (taxonomy defaults) |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step a user can click **Simulate** on a planned mission (state `plan_review` or `executing`) and, in under two seconds and without spending a single token, see: which provider and model each task in the DAG would get, the estimated tokens and wall-clock time per task (sourced from the `outcomes` history when there is enough of it, otherwise from the task taxonomy's `defaultBudget`), the cumulative impact on every provider's quota windows, and explicit warnings such as *"codex weekly window will exhaust at task 7 (test-gen)"* or *"claude 5h reserve for reviews will be breached at task 4"*. The simulation runs the real assignment engine (M2-04) with the real constraints (cooling from M4-03, reserves from M4-04) against a **copy** of the current window states, advancing a virtual clock through the DAG in dependency order. Every decision is persisted with `routing_decisions.dry_run = true` so the plan can be compared against what actually happened later.

## 2. Why
- **G4 (never blocked)**: knowing a mission cannot finish inside the current windows *before* starting it is the cheapest possible form of "never blocked". `00-source-plan-v0.2.md` §11 lists "dry-run before missions" alongside forecasting.
- **G2 (right model for the job; window utilisation)**: the simulation is the only place a user sees the whole routing plan at once and can judge the off-top-tier share before committing.
- **D3 (deterministic engine)**: because the engine is a pure scorer, simulating is just running it with a different clock and a scratch window ledger. This step exists *because* D3 was honoured; it adds no parallel routing logic.
- **`06-intelligence-layer.md` §3**: "Dry-run simulates a whole mission's window impact (M4-06)" — the `RoutingDecision.dryRun` flag and the `routing.dry_run` event already exist in the domain model for exactly this.
- **UX principle 5 (zero-surprise control)** and **C10**: a mission is the largest single spend in the product; it gets a preview before it runs.
- **UX principle 4**: every figure here is an estimate of an estimate; each one carries its source and sample size.

## 3. Scope
### In scope
- Core: pure `MissionSimulator` (DAG + window snapshot + policy → `SimulationReport`), `VirtualWindowLedger` (in-memory fold of estimated costs onto copied `WindowState`s with rollover at `resetAt`), and the shared `CostEstimator` introduced in M4-04.
- Warning generation: window exhaustion, reserve breach, mission-budget cap, no-candidate task, provider cooling at simulation start.
- Daemon: `SimulateMission` use case; persistence of `routing_decisions` with `dry_run = true` and a `simulation_id`; `routing.dry_run` event.
- API `POST /missions/:id/simulate` (+ `GET /missions/:id/simulations/:simId`); `POST /missions/simulate` for an unsaved plan payload (used by the New-mission dialog).
- Missions screen: **Simulate** button, results drawer (per-task table, per-provider window impact, warning list), re-simulate on plan edit.
- FakeProvider-backed E2E and a golden report fixture.
### Out of scope (deferred to …)
- Acting on the result automatically (auto-reassigning or re-planning) — the simulation is advisory only; the human decides.
- Simulating review rounds beyond `playbook.reviewRounds` (no branching for "changes requested" loops) — a single-pass DAG walk is what M4 ships; iterative-round modelling is a candidate for M8-06.
- Monte-Carlo / confidence intervals — deferred; M4 reports a single point estimate plus sample size.
- Simulating across hosts — deferred to M7-05.
- Comparing the simulation against the actual run ("plan vs actual") — deferred to M5-04 (Timeline) / M8-06 (scorecards).
- Simulating token cost in money — out of scope for v1 (units are vendor window units, never currency).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/routing/simulation/{mission-simulator.ts, virtual-window-ledger.ts, cost-estimator.ts, warnings.ts}`.

Rules (100 % branch coverage in `mission-simulator.spec.ts`):
- **R-S1 Same engine, no shadow logic.** The simulator calls the injected `AssignmentEngine.decide()` for every task. It never re-implements scoring. Constraints (`cooling`, `reserve`, `mission-budget`, `cross-vendor review`, `sandbox`, `maxConcurrentSessions`) are the same registered strategies.
- **R-S2 Copy, never mutate.** Window states, forecasts, cooling records and budget statuses are deep-copied into a `VirtualWindowLedger`. The simulation cannot change any persisted quota state; asserted by a test that snapshots the DB before and after.
- **R-S3 Virtual clock advances by dependency level.** Tasks are walked in topological order; tasks at the same level that fit inside `missions.maxParallelTasks` share a virtual start time; the level's duration is the **max** of its tasks' estimated durations. `now` starts at the real `now`; window rollovers at `resetAt` are applied as the virtual clock passes them (M4-01 R-W3).
- **R-S4 Estimates carry their provenance.** `CostEstimate` comes from `outcomes` for `(model, taskType)` when `sampleCount ≥ 3`, otherwise from the taxonomy `defaultBudget`; `source` and `sampleCount` appear on every row. Same function as M4-04 R-B4 — one estimator, two callers.
- **R-S5 Unknown limits produce no exhaustion claim.** A provider whose window has no `limit` gets window *impact* (units added) but never an "will exhaust" warning. Nothing is fabricated (R-W4).
- **R-S6 First failure is reported, the walk continues.** When a task gets no candidate (everything constrained out) it is recorded as `unassignable` with the reasons from the engine, and the walk continues with the remaining tasks so the user sees the whole picture, not just the first problem.
- **R-S7 Deterministic.** Given the same inputs (`now`, DAG, windows, policies, outcomes) the report is byte-identical: stable ordering, no `Date.now()`, no randomness. Golden-fixture tested.
- **R-S8 Total function.** Never throws; an empty DAG yields an empty report with `warnings: []`; a cyclic DAG (should be impossible after M3-01 `validateDag`) returns a single `cycle` warning instead of looping.
- **R-S9 Estimates are estimates.** Every numeric field in the report is `confidence: 'estimate'`; the report additionally carries `windowConfidence` per provider so the UI can distinguish "estimate built on an official window" from "estimate built on an estimate".

### 4.2 Interfaces / contracts
```ts
// packages/core/src/routing/simulation/mission-simulator.ts
export interface SimulationTaskRow {
  planTaskId: string; taskId?: string; title: string; taskType: TaskType; role: RoleName;
  dependsOn: string[]; level: number;                   // topological depth
  decision: RoutingDecision | null;                      // null ⇒ unassignable
  unassignableReasons?: string[];                        // constraint reasons from the engine (R-S6)
  estimate: CostEstimate;                                // tokens, wallClockMs, source, sampleCount
  virtualStartAt: string; virtualEndAt: string;
}

export interface SimulationWindowImpact {
  providerId: ProviderId; kind: WindowKind; unit: UsageUnit;
  usedBefore: number; addedByMission: number; usedAfter: number;
  limit?: number; utilisationAfterPct?: number;
  rolloversDuringMission: number;
  windowConfidence: Confidence;                          // confidence of the source WindowState (R-S9)
}

export type SimulationWarning =
  | { code: 'WINDOW_WILL_EXHAUST'; providerId: ProviderId; kind: WindowKind; atPlanTaskId: string; atTaskTitle: string; atVirtualTime: string }
  | { code: 'RESERVE_WILL_BREACH'; policyId: string; providerId: ProviderId; kind: WindowKind; atPlanTaskId: string }
  | { code: 'MISSION_BUDGET_WILL_EXHAUST'; cap: 'tokens' | 'time' | 'window-share'; atPlanTaskId: string }
  | { code: 'TASK_UNASSIGNABLE'; planTaskId: string; reasons: string[] }
  | { code: 'PROVIDER_COOLING_AT_START'; providerId: ProviderId; coolingUntil: string }
  | { code: 'ESTIMATES_WEAK'; taskTypes: TaskType[]; note: 'no outcomes history; taxonomy defaults used' }
  | { code: 'CYCLE'; planTaskIds: string[] };

export interface SimulationReport {
  simulationId: string; missionId?: string; planVersionId?: string;
  tasks: SimulationTaskRow[];
  windowImpact: SimulationWindowImpact[];
  totals: { tokens: number; wallClockMs: number; offTopTierPct: number; providersUsed: ProviderId[] };
  warnings: SimulationWarning[];
  confidence: 'estimate';
  simulatedAt: string; virtualEndAt: string;
}

export interface SimulateInput {
  plan: { planTaskId: string; title: string; taskType: TaskType; role: RoleName; dependsOn: string[] }[];
  windows: readonly WindowState[]; forecasts: readonly QuotaForecast[];
  cooling: readonly ProviderCooling[]; budgets: BudgetsPolicy; missionBudget?: MissionBudgetStatus;
  maxParallelTasks: number; now: IsoTimestamp;
}
export interface MissionSimulator { simulate(input: SimulateInput): SimulationReport; }   // pure, total (R-S8)
```
```ts
// apps/daemon/src/application/routing/ports.ts (addition)
export type SimulationError =
  | { code: 'MISSION_NOT_SIMULATABLE'; missionId: string; state: MissionState }
  | { code: 'NO_PLAN'; missionId: string };
```
Use case `SimulateMission` (`apps/daemon/src/application/routing/simulate-mission.use-case.ts`): loads the mission + current `PlanVersion` (or accepts an inline plan), snapshots windows/forecasts/cooling/budgets, calls the simulator, persists one `routing_decisions` row per assigned task with `dry_run = 1` and `simulation_id`, emits `routing.dry_run`, returns the report.

### 4.3 Data / schema changes
Migration `<next>-m4-06-simulations.ts` (additive):
- `routing_decisions` (schema v1 already has `dry_run`) + `simulation_id TEXT NULL`, `plan_task_id TEXT NULL`; index `(simulation_id)`.
- New `mission_simulations`: `id` (ULID), `mission_id` (nullable for ad-hoc plans), `plan_version_id`, `report_json` (Zod-validated `SimulationReport`), `simulated_at`, `actor_json`. Retention: keep the last 20 per mission, purge the rest in the daily job.
- Event `routing.dry_run` (already in the `routing.*` catalog): payload `{ simulationId, missionId?, taskCount, warningCount, totals }` — the full report stays in `mission_simulations`, not in the event payload.
- `packages/catalog/taxonomy/*.yaml`: ensure every shipped `TaskType` has a `defaultBudget { tokens, wallClockMinutes }` (M2-01 defined the field; this step fills any gaps and adds a schema test that none is missing).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Nothing is launched.** No tmux window, no worktree, no child process, no vendor call. This is the step's defining property and is asserted by IT-M4-06-02 (process table and `git worktree list` unchanged).
- Snapshots are read through the existing repositories (`ProviderWindowRepository`, `QuotaForecastRepository`, `ProviderCoolingRepository`, `MissionUsageRepository`) and deep-copied before the simulator sees them (R-S2).
- The `outcomes` lookup uses the existing `OutcomeRepository` (M2-02) with a per-request memo so a 30-task DAG does one query per `(model, taskType)` pair, not one per task.
- Performance budget: a 50-task DAG × 5 providers × 4 windows must complete in < 500 ms in the use case and < 2 s end-to-end including HTTP and render. Benchmarked in `UT-M4-06-07`.
- `features.dryRun` flag; `POST /missions/simulate` (ad-hoc) is rate-limited to 10/min per client to keep the ad-hoc path from becoming a CPU tarpit.

### 4.5 API / UI surface
- `POST /missions/:id/simulate` `{ planVersion?: number }` → `200 SimulationReport`. `409 MISSION_NOT_SIMULATABLE` for terminal states; `422 NO_PLAN` when no plan version exists. Audited (read-only action, but it is the preview half of C10). *(Route shown at the daemon's HTTP root, consistent with `POST /missions/:id/plan` in M3-02; if the daemon adopts an `/api` prefix in M0-06 this becomes `POST /api/missions/:id/simulate`.)*
- `POST /missions/simulate` `{ plan: PlannedTask[], repoPath?, budget? }` → `200 SimulationReport` for a plan that is not saved yet (New-mission dialog).
- `GET /missions/:id/simulations` → summaries; `GET /missions/:id/simulations/:simId` → the stored report.
- WS topic `mission.<id>`: `routing.dry_run`.
- UI (`apps/web/src/screens/missions/`):
  - **Simulate** button in the Missions screen header (M3-08) and in the mission detail toolbar; also offered on the plan card in Attention next to *Approve*.
  - `SimulationDrawer` with three sections: **Tasks** (table: task, type, provider · model, est. tokens, est. time, source chip `outcomes(n)` / `taxonomy-default`, start→end virtual time), **Window impact** (per provider/window: before → added → after, utilisation %, confidence chip), **Warnings** (icon + text, each deep-linked to the offending task row).
  - States: `idle` (button), `running` (skeleton + "simulating…"), `ready` (drawer), `stale` (plan edited since — banner "Plan changed; re-simulate"), `error` (message + retry).
  - Every number carries an *estimate* chip; the report header reads "Estimates — no quota is spent by simulating." Status by icon **and** text (UX principle 2); table is keyboard-navigable and RTL-safe (`packages/ui` tokens, logical properties).

### 4.6 Flow / sequence
```
UI Simulate ─▶ POST /missions/:id/simulate
  └─ SimulateMission
      ├─ MissionRepository.get + PlanVersionRepository (current approved/pending plan) ─▶ PlannedTask[]
      ├─ snapshot: windows (M4-01) · forecasts (M4-02) · cooling (M4-03) · budgets+usage (M4-04)   (deep copy, R-S2)
      ├─ MissionSimulator.simulate({plan, …, maxParallelTasks, now})
      │    for each topological level:
      │      for each task in level:
      │        ├─ estimate = CostEstimator.estimate(taskType, candidateModel)                      (R-S4)
      │        ├─ decision = AssignmentEngine.decide(taskSpec, {virtualLedger, virtualNow})        (R-S1)
      │        │     no candidate ⇒ row.unassignable + warning TASK_UNASSIGNABLE, continue         (R-S6)
      │        └─ VirtualWindowLedger.add(provider, kind, estimate.tokens, virtualNow)
      │             crossing limit      ⇒ warning WINDOW_WILL_EXHAUST (task, virtual time)         (R-S5)
      │             crossing reserve    ⇒ warning RESERVE_WILL_BREACH
      │             crossing mission cap⇒ warning MISSION_BUDGET_WILL_EXHAUST
      │      virtualNow += max(level durations)   (rollovers applied as the clock passes resetAt)  (R-S3)
      ├─ persist mission_simulations + routing_decisions(dry_run = 1, simulation_id)
      └─ emit routing.dry_run ─▶ /ws mission.<id> ─▶ drawer renders
```

## 5. Tasks
- [ ] `packages/core/src/routing/simulation/`: `MissionSimulator`, `VirtualWindowLedger`, warning builders implementing R-S1…R-S9; 100 % branch tests.
- [ ] Reuse/extract `CostEstimator` from M4-04 into the shared location; add the `sampleCount ≥ 3` gate test and the `ESTIMATES_WEAK` warning.
- [ ] Taxonomy audit: every shipped `TaskType` has a `defaultBudget`; schema test fails the build if one is missing.
- [ ] Topological walk with levels + `maxParallelTasks` batching + virtual clock and window rollover.
- [ ] Deep-copy snapshot helpers + a test asserting the persisted quota state is byte-identical before and after a simulation.
- [ ] Migration `m4_06_simulations` (`mission_simulations`, `routing_decisions.simulation_id/plan_task_id`) + repository + in-memory double.
- [ ] `SimulateMission` use case (mission-bound and ad-hoc plan variants) + `routing.dry_run` event + `dry_run` decision persistence.
- [ ] HTTP controllers + DTOs + OpenAPI + rate limit on the ad-hoc route; audit entries.
- [ ] Web: **Simulate** button (Missions header, mission detail, plan card), `SimulationDrawer` with the three sections and all five states.
- [ ] Web: stale detection (plan version changed since `simulatedAt`) and re-simulate action.
- [ ] Golden report fixture + snapshot test (`fixtures/simulation/new-feature-fullstack.report.json`).
- [ ] Performance benchmark test (50 tasks × 5 providers × 4 windows < 500 ms in the use case).
- [ ] a11y pass on the drawer (axe: contrast, focus order, table semantics) + RTL check.
- [ ] Config `features.dryRun`, `simulation.maxRetainedPerMission` (20), purge job entry.
- [ ] Docs: Missions section of the user docs; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-06-01 | unit | linear 5-task DAG, one provider with `limit` reached at task 4 | `WINDOW_WILL_EXHAUST` names task 4 and its virtual time; tasks 5 still simulated (R-S6) |
| UT-M4-06-02 | unit | diamond DAG with `maxParallelTasks = 2` | levels batched correctly; level duration = max of its tasks; `virtualStartAt/EndAt` consistent (R-S3) |
| UT-M4-06-03 | unit | window whose `resetAt` falls inside the mission's virtual span | `rolloversDuringMission = 1`; `usedAfter` counted against the fresh window; no exhaustion warning (R-S3) |
| UT-M4-06-04 | unit | provider with unknown `limit` | window impact reported, **no** `WINDOW_WILL_EXHAUST` warning (R-S5) |
| UT-M4-06-05 | unit | task with every provider constrained out (cooling + reserve) | row `decision: null`, `unassignableReasons` lists both constraint reasons, `TASK_UNASSIGNABLE` warning |
| UT-M4-06-06 | unit | empty DAG / cyclic DAG / single task with no outcomes | empty report / one `CYCLE` warning, no loop / `ESTIMATES_WEAK` with `taxonomy-default` source (R-S8) |
| UT-M4-06-07 | unit (bench) | 50 tasks × 5 providers × 4 windows | < 500 ms; deterministic across two runs (R-S7) |
| AT-M4-06-01 | application | simulate then inspect the quota tables | `provider_windows`, `quota_forecasts`, `provider_cooling`, `mission_budget_usage` byte-identical before and after (R-S2) |
| AT-M4-06-02 | application | simulate a mission twice | two `mission_simulations` rows; `routing_decisions` rows all `dry_run = 1`; no `dry_run = 0` row created |
| AT-M4-06-03 | application | simulate a mission in state `done` / with no plan | `409 MISSION_NOT_SIMULATABLE` / `422 NO_PLAN`; nothing persisted |
| IT-M4-06-01 | integration | golden fixture: `new-feature-fullstack` plan + fixed window snapshot + fixed `now` | report matches `fixtures/simulation/new-feature-fullstack.report.json` byte-for-byte |
| IT-M4-06-02 | integration | simulate while the process table and `git worktree list` are watched | zero new processes, zero tmux windows, zero worktrees, zero egress (`no-vendor-endpoints` monitor) |
| E2E-M4-06-01 | e2e (Playwright + FakeProvider) | plan a 10-task mission, click **Simulate** | drawer renders in < 2 s with per-task provider/model, window impact and ≥ 1 warning when `fake-a` is near its limit; every number shows an *estimate* chip |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-06-01 | Simulate a real planned mission | 1. Plan a `new-feature-fullstack` mission on `~/orchestra-scratch/` with Claude Code + Codex enabled. 2. Do **not** approve/start it. 3. Click **Simulate**. | Drawer appears in < 2 s listing every task with provider · model, estimated tokens and time, each with a source chip (`taxonomy-default` on a fresh install); per-provider window impact before → added → after; header says no quota is spent. | ⬜ |
| TC-M4-06-02 | Nothing is spent or started | 1. Before TC-01, note `GET /providers/*/windows` and run `tmux list-windows -t orchestra` and `git worktree list`. 2. Simulate. 3. Repeat the three checks. | All three outputs are identical; no new session rows; the real windows did not move by a single token. | ⬜ |
| TC-M4-06-03 | "Will exhaust" warning is truthful | 1. Run FakeProvider `burn-to-85.yaml` on `fake-a` so its 5h window is near the limit. 2. Simulate a 10-task mission that prefers `fake-a`. | A warning names the exact task at which `fake-a` would cross its limit and the virtual time; the task table shows later tasks routed elsewhere (or marked unassignable); removing the burn and re-simulating makes the warning disappear. | ⬜ |
| TC-M4-06-04 | Reserve and budget warnings | 1. Set a 20 % review reserve on `fake-b` and a small `maxTokens` mission budget. 2. Simulate. | `RESERVE_WILL_BREACH` names the policy id and the task; `MISSION_BUDGET_WILL_EXHAUST` names the cap and the task; both warnings deep-link to their rows. | ⬜ |
| TC-M4-06-05 | Negative: unassignable task | 1. Put every capable provider for `security-audit` into cooling (FakeProvider storm scenario). 2. Simulate a mission containing a `security-audit` task. | That row shows no provider with `unassignableReasons` listing `cooling` (and any other constraint); the rest of the DAG is still simulated; a `PROVIDER_COOLING_AT_START` warning is also present. | ⬜ |
| TC-M4-06-06 | Negative: no plan / terminal mission | 1. Create a mission but do not plan it; click **Simulate**. 2. Simulate a mission already in `done`. | `422 NO_PLAN` rendered as "Plan this mission first"; `409` rendered as "This mission is finished"; no stored simulation rows in either case. | ⬜ |
| TC-M4-06-07 | Stale report after a plan edit | 1. Simulate. 2. Use *Edit & resend* on the plan card to create a new `PlanVersion`. 3. Return to the drawer. | Banner "Plan changed; re-simulate"; the old report is still readable and labelled with its plan version; re-simulating produces a new `simulationId`. | ⬜ |
| TC-M4-06-08 | Restart + history | 1. Simulate, then `kill -9` the daemon and restart. 2. Open `GET /missions/:id/simulations` and the drawer. | The stored report is unchanged and still rendered; `routing_decisions` for the simulation are all `dry_run = 1` and are not mistaken for real decisions on the mission's "why this model" panel. | ⬜ |
| TC-M4-06-09 | Estimates improve with history | 1. After running at least 3 real tasks of one `taskType`, re-simulate a mission containing that type. | Those rows switch their source chip from `taxonomy-default` to `outcomes(n)` with `n ≥ 3`; the `ESTIMATES_WEAK` warning no longer lists that task type. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `POST /missions/:id/simulate` returns a full report for a 10-task mission in < 2 s end-to-end and < 500 ms inside the use case for 50 tasks.
- [ ] Simulating changes **nothing**: no process, no tmux window, no worktree, no egress, and every quota table is byte-identical before and after (AT-M4-06-01, TC-M4-06-02).
- [ ] Every task row carries a provider/model decision or an explicit `unassignableReasons` list; every estimate carries `source` and `sampleCount`; every number is labelled *estimate*.
- [ ] Window-impact figures respect rollovers at `resetAt` and never claim exhaustion for a window with no known `limit`.
- [ ] Warnings for window exhaustion, reserve breach, mission budget, unassignable task, cooling-at-start and weak estimates all fire in their TC and each names the task it happens at.
- [ ] The simulator uses the real `AssignmentEngine` and the real constraint strategies — no parallel routing implementation exists (reviewed in the PR, enforced by the golden fixture matching engine behaviour).
- [ ] Reports are deterministic (golden fixture IT-M4-06-01) and persisted with `routing_decisions.dry_run = 1`, never confused with real decisions.
- [ ] Drawer passes axe with no serious/critical issues, is keyboard-navigable and renders correctly in RTL.
- [ ] All TC-M4-06-01…09 pass and are recorded with build hash and date.
- [ ] No new ESLint / dependency-cruiser violations; `PROGRESS.md` row updated; `mission_simulations` documented in `04-domain-model.md` §4.

## 8. Risks / open questions
- **Estimate quality is the whole product here.** On a fresh install everything is a taxonomy default and the report can be off by a large factor. Mitigation: the `ESTIMATES_WEAK` warning is prominent, source chips are per row, and M8-06 replaces defaults with outcomes as history accumulates. Do not let the UI imply precision the data does not have.
- Single-pass DAG walking ignores review rounds that send work back (`changes_requested` → `running`). Real missions will therefore cost more than simulated. Consider adding `playbook.reviewRounds × reworkProbability` in a follow-up once M8-06 has rework statistics; state the limitation in the drawer footer.
- Wall-clock estimates assume agents run at historical speed and that `maxParallelTasks` is the only concurrency limit; `manifest.limits.maxConcurrentSessions` (C6) also applies and must be included in the level batching — verify against each manifest at step start.
- The virtual clock does not model human latency (plan approval, review sign-off, answering prompts), which usually dominates wall-clock time. The report should label its time column "agent time" rather than "elapsed".
- Advisory-only is a deliberate constraint: the temptation to auto-re-route the whole mission from a simulation is strong, but the estimates are too weak in M4 to justify it. Revisit only after plan-vs-actual data exists (M5-04 / M8-06).
- If a window's `resetAt` is a rolling rather than fixed period (verify against the vendor docs at step start, as in M4-01/M4-02), rollover modelling in R-S3 is optimistic in one direction and pessimistic in the other; the `rolloversDuringMission` count is surfaced so the user can judge.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
