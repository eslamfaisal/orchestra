# Step M4-04 — Budgets & reserves

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-02 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `packages/catalog` (schemas), `apps/daemon` (application/policy, application/quota, interface/http), `apps/web` (Attention + mission banner) |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step the user can write budgets into their `PolicySet` and have the assignment engine obey them. Three kinds ship: a **Lead reserve** (keep a slice of one provider's window free so the mission Lead can always think), a **review reserve** (keep e.g. 20 % of a provider's window for `code-review` tasks so reviews never starve — `06-intelligence-layer.md` §3 "protect-review budgets"), and a **per-mission budget** (a cap on tokens, wall-clock time and share of a provider's window that one mission may consume). Reserves become a 0/1 constraint in the engine: a non-review task is simply not offered a provider whose remaining window lies inside its review reserve, and the `RoutingDecision` says why. Crossing a reserve or a mission cap emits `quota.reserve_breached`, raises an Attention item, and — for a mission cap — pauses the mission's scheduler instead of silently overspending. Every reserve figure is derived from M4-02 forecasts and therefore labelled *estimate*.

## 2. Why
- **G2 (right model for the job; ≥ 80 % of each paid window used productively)**: utilisation only counts as *productive* if the expensive part of the window is still there when review and planning need it. Reserves are how "use it fully" and "do not burn it on boilerplate" coexist.
- **G3 (cross-vendor review on 100 % of mission tasks)**: cross-vendor review is worthless if the reviewer's provider is exhausted by the authors. The review reserve is the mechanism that keeps M3-04 able to run.
- **G4 (never blocked)**: the Lead reserve keeps the mission's brain alive; when it is breached anyway, M4-05 hands the Lead over.
- **D3**: budgets are deterministic policy data evaluated by the engine, not an LLM's judgement. **D7**: they live in layered YAML (`workspace.yaml`, later the M8-01 settings engine), not in code.
- **C5 / C10**: reserves reduce the chance of hitting a vendor limit at all, and every spend-affecting policy change is previewed and audited.
- **UX principle 4**: a reserve bar drawn over an *estimate* must say so; principle 5: pausing a mission on a cap is a preview-and-confirm moment, not a surprise.

## 3. Scope
### In scope
- `PolicySet.budgets` schema (`packages/catalog/schemas/budgets.schema.ts`, Zod) + loader/merge into the existing policy layering from M2-09.
- Core: `Reserve`, `MissionBudget`, `BudgetLedger` (pure: window + forecast + policy → remaining, reserved, breach), and `ReserveConstraint` / `MissionBudgetConstraint` registered in the M2-04 constraint map.
- Daemon: `EvaluateBudgets` (on `quota.window_updated` / `quota.forecast_updated` / `task.result_submitted`), `GetBudgetStatus`, `PauseMissionOnBudget`, `ResumeMission` use cases; `mission_budget_usage` table; `quota.reserve_breached` event.
- Attention items `quota.reserve_breached` and `mission.budget_exhausted`; mission banner in the Missions list (v0 from M3-02).
- `GET /fleet/budgets`, `GET /missions/:id/budget`, `POST /missions/:id/budget/resume`.
- FakeProvider scenario `burn-into-reserve.yaml`.
### Out of scope (deferred to …)
- Lead handoff when the Lead reserve is gone — deferred to M4-05 (this step emits the breach and pauses; M4-05 acts).
- Dry-run of a mission against budgets before it starts — deferred to M4-06.
- Reserve shading on the Fleet bars, reserve KPI tiles — deferred to M4-07.
- Form editors for budgets (YAML only here) — deferred to M8-02; full layered settings precedence — M8-01.
- Monetary budgets (currency, invoices) — not planned for v1; budgets are expressed in vendor window units (`tokens`, `percent`, `requests`, `credits`), never in money.
- 4-eyes approval on budget changes — deferred to M9-04.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/policy/budgets/{reserve.ts, mission-budget.ts, budget-ledger.ts, reserve-constraint.ts}`.

Rules (100 % branch coverage in `budget-ledger.spec.ts`):
- **R-B1 Reserves are floors on the remaining window, not caps on spend.** `reservedUnits = ceil(limit × reservePct / 100)` (or the literal `reserveUnits` if given). A candidate is admissible for a task only if `remaining − reservedUnits ≥ estimatedCost(task)`, where `remaining = limit − used`.
- **R-B2 Exemptions.** A reserve does not apply to the work it protects: the review reserve is ignored for tasks whose `taskType` is in `reserve.forTaskTypes` (default `['code-review']`); the Lead reserve is ignored for tasks with `role: 'lead'`. Exemption is by task attribute, never by provider identity.
- **R-B3 Unknown limit ⇒ reserve inert.** If the window has no `limit` (R-W4 / R-F7), the reserve cannot be computed and the constraint passes with reason `reserve: not-evaluable`. Reserves never fabricate a limit and never block on a guess.
- **R-B4 Estimated cost.** `estimatedCost(task)` comes from `outcomes` for `(model, taskType)` when `sampleCount ≥ 3`, else from the taxonomy's `defaultBudget` (`06-intelligence-layer.md` §1), and carries `source: 'outcomes' | 'taxonomy-default'`. Same estimator as M4-06 — one implementation, two callers.
- **R-B5 Breach is a state, not an event storm.** `breached = remaining < reservedUnits`. `quota.reserve_breached` is emitted on the transition into `breached` only; re-entry requires leaving the state (with the same `hysteresisPp` as M4-02).
- **R-B6 Mission caps are cumulative and hard.** A mission's `usedTokens` and `elapsedMs` accumulate from `task_results.usage_json` and session durations. At `≥ 100 %` of any cap the mission scheduler stops starting new tasks (`mission.state` stays `executing`, `budget_paused = true`); running tasks are **not** killed.
- **R-B7 Warn before stop.** At `warnAtPct` (default 80) of a mission cap the ledger reports `level: 'warn'` and the UI banner appears; at 100 % `level: 'exhausted'` and the pause takes effect.
- **R-B8 Precedence.** Budgets merge task > mission > workspace > org > defaults (the M2-09 layering); the **most restrictive reserve wins** when two layers define one for the same `(provider, window)`. Merge is pure and unit-tested.
- **R-B9 Total function.** The ledger never throws, never returns negative `remaining` or `reservedUnits`, and handles `limit = 0`, `reservePct = 0`, `reservePct = 100` (⇒ provider usable only by the exempt task types).

### 4.2 Interfaces / contracts
```ts
// packages/catalog/schemas/budgets.schema.ts  → PolicySet.budgets
export interface ReservePolicy {
  id: string;                      // stable id for explainability, e.g. 'review-codex-5h'
  kind: 'lead' | 'review';
  providerId: ProviderId;
  window: WindowKind;
  reservePct?: number;             // 0…100, exclusive with reserveUnits
  reserveUnits?: number;
  forTaskTypes?: TaskType[];       // default: ['code-review'] for kind 'review'
  forRoles?: RoleName[];           // default: ['lead'] for kind 'lead'
  warnAtPct?: number;              // default 80 — warn before the reserve is touched
}
export interface MissionBudgetPolicy {
  maxTokens?: number;
  maxWallClockMinutes?: number;
  maxWindowSharePct?: Partial<Record<ProviderId, number>>;   // e.g. { codex: 40 } = ≤ 40 % of any codex window
  warnAtPct?: number;              // default 80
  onExhausted: 'pause' | 'warn';   // default 'pause'
}
export interface BudgetsPolicy { reserves: ReservePolicy[]; mission?: MissionBudgetPolicy; }
```
```ts
// packages/core/src/policy/budgets/budget-ledger.ts
export type BudgetLevel = 'ok' | 'warn' | 'breached' | 'exhausted' | 'not-evaluable';

export interface ReserveStatus {
  policyId: string; kind: 'lead' | 'review'; providerId: ProviderId; window: WindowKind;
  limit?: number; used: number; remaining?: number; reservedUnits?: number;
  level: BudgetLevel; confidence: 'estimate';        // derived from a forecast ⇒ never official
  exemptTaskTypes: TaskType[]; exemptRoles: RoleName[];
  evaluatedAt: string;
}
export interface MissionBudgetStatus {
  missionId: string;
  usedTokens: number; maxTokens?: number;
  elapsedMs: number; maxWallClockMs?: number;
  windowSharePct: Partial<Record<ProviderId, number>>; maxWindowSharePct?: Partial<Record<ProviderId, number>>;
  level: BudgetLevel; budgetPaused: boolean; costSource: 'outcomes' | 'taxonomy-default' | 'measured';
  evaluatedAt: string;
}
export interface CostEstimate { tokens: number; wallClockMs: number; source: 'outcomes' | 'taxonomy-default'; sampleCount: number; }

export function evaluateReserve(p: ReservePolicy, w: WindowState | null, now: IsoTimestamp): ReserveStatus;      // R-B1…R-B3, R-B5, R-B9
export function evaluateMissionBudget(p: MissionBudgetPolicy | undefined, usage: MissionUsage, now: IsoTimestamp): MissionBudgetStatus;  // R-B6, R-B7
export function mergeBudgets(layers: readonly BudgetsPolicy[]): BudgetsPolicy;                                    // R-B8, most restrictive wins

// packages/core/src/policy/budgets/reserve-constraint.ts
/** Registered in the M2-04 constraint map as 'reserve' and 'mission-budget' (0/1 gates, 06 §3). */
export const reserveConstraint: AssignmentConstraint;         // reason: `reserve: review` | `reserve: lead` | `reserve: not-evaluable`
export const missionBudgetConstraint: AssignmentConstraint;   // reason: `budget: mission-window-share`
```
```ts
// apps/daemon/src/application/quota/ports.ts (additions)
export interface MissionUsageRepository {
  get(missionId: string): Promise<Result<MissionUsage, StorageError>>;
  addTaskUsage(missionId: string, taskId: string, u: TaskUsage): Promise<Result<void, StorageError>>;
}
export interface CostEstimator { estimate(taskType: TaskType, modelId: ModelId): CostEstimate; }   // shared with M4-06
export type BudgetError =
  | { code: 'MISSION_BUDGET_EXHAUSTED'; missionId: string; cap: 'tokens' | 'time' | 'window-share' }
  | { code: 'POLICY_INVALID'; path: string; message: string };
```

### 4.3 Data / schema changes
Migration `<next>-m4-04-budgets.ts` (additive):
- `mission_budget_usage`: `mission_id` (PK), `used_tokens`, `elapsed_ms`, `window_share_json`, `level`, `budget_paused` (0/1), `paused_at`, `resumed_at`, `updated_at`.
- `missions` + `budget_json` already exists (schema v1) — it now stores a Zod-validated `MissionBudgetPolicy` snapshot taken at mission creation, so editing workspace policy mid-mission does not retroactively move the goalposts.
- `reserve_breaches`: `id`, `policy_id`, `provider_row_id`, `window_kind`, `opened_at`, `closed_at`, `reserved_units`, `remaining_at_breach` — one row per breach episode, so M4-07 can report "reserve breached 3× this week".
- Event `quota.reserve_breached` (already in the `quota.*` catalog): payload = `ReserveStatus` + `{ episodeId }`. New events `mission.budget_warned`, `mission.budget_paused`, `mission.budget_resumed` — note the additions in `04-domain-model.md` §3 when the step closes.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No processes, no network. Budgets are read from `<repo>/.orchestra/workspace.yaml` (workspace layer) and `~/.orchestra/config.yaml` (user layer) by the existing policy loader (M2-09) with hot reload; invalid YAML fails the reload and keeps the last good policy (fail-safe, logged, Attention item `policy.invalid`).
- `apps/daemon/src/infrastructure/policy/budgets.loader.ts` validates with the catalog Zod schema; `apps/daemon/src/application/policy/EvaluateBudgets` subscribes to `quota.window_updated`, `quota.forecast_updated`, `task.result_submitted` and `session.stopped`, debounced 2 s per provider/mission.
- Mission usage accumulates from `task_results.usage_json` (M3-03) plus session wall-clock from `sessions.started_at/ended_at`; a task with no usage figure contributes its `CostEstimate` instead, flagged `costSource: 'taxonomy-default'` so the banner can say the number is partly estimated.
- Pausing a mission means `MissionScheduler` (M3-02) skips it when picking ready tasks; nothing is killed and no tmux pane is touched (R-B6).

### 4.5 API / UI surface
- `GET /fleet/budgets` → `{ reserves: ReserveStatus[], evaluatedAt }`.
- `GET /missions/:id/budget` → `MissionBudgetStatus`.
- `POST /missions/:id/budget/resume` `{ raiseTo?: MissionBudgetPolicy }` (`Idempotency-Key`, audited) → clears `budget_paused`; when `raiseTo` is given it is previewed in the response before being applied (C10) and written to `missions.budget_json`.
- `GET /policies/budgets` → merged effective budgets with the layer each value came from (explainability, mirrors M2-09's "why this model" panel).
- WS `/ws` topic `quota`: `quota.reserve_breached`; topic `mission.<id>`: `mission.budget_*`.
- UI (minimal here, full treatment in M4-07):
  - Attention item `quota.reserve_breached` — "codex weekly: only 6 % left, below the 20 % review reserve. Non-review tasks will not be routed to codex until it resets." Actions: *Open Fleet*, *Edit budgets*.
  - Attention item `mission.budget_exhausted` — "Mission *Add pagination* paused: token cap reached (312 k / 300 k). 3 tasks queued." Actions: *Resume*, *Raise cap & resume*, *Open mission*.
  - Mission banner in `MissionsListV0` / mission detail: `warn` (yellow + text "80 % of token budget used") and `exhausted` (text "paused — budget"), status by shape **and** text (UX principle 2), with a *Resume* button that shows the preview dialog.
  - `RoutingDecision` reasons rendered in the existing Quick Delegate preview: "codex excluded — reserve: review".

### 4.6 Flow / sequence
```
workspace.yaml / config.yaml ─▶ budgets.loader (Zod) ─▶ PolicySet.budgets (layered, mergeBudgets R-B8)

quota.window_updated | quota.forecast_updated ─▶ EvaluateBudgets(provider) [debounce 2 s]
   ├─ for each ReservePolicy: evaluateReserve(policy, window, now) ─▶ ReserveStatus
   ├─ transition ok→breached? ─▶ reserve_breaches row + quota.reserve_breached ─▶ /ws + Attention   (R-B5)
   └─ cache statuses ─▶ reserveConstraint reads them during AssignmentEngine.decide

AssignmentEngine.decide(task) (M2-04)
   ├─ candidates × constraints{cooling (M4-03), reserve, mission-budget, sandbox, cross-vendor, …}
   ├─ reserveConstraint: exempt task type/role?  yes ⇒ pass                                          (R-B2)
   │                      limit unknown?          yes ⇒ pass, reason 'reserve: not-evaluable'        (R-B3)
   │                      remaining − reserved ≥ estimatedCost(task)? no ⇒ 0, reason 'reserve: review'
   └─ RoutingDecision.reasons records every constraint that scored 0

task.result_submitted | session.stopped ─▶ MissionUsageRepository.addTaskUsage
   ─▶ evaluateMissionBudget ─▶ warn (80 %) ─▶ mission.budget_warned ─▶ banner
                            ─▶ exhausted (100 %) ─▶ budget_paused = true ─▶ mission.budget_paused
                                ─▶ MissionScheduler skips the mission; running tasks continue        (R-B6)
POST /missions/:id/budget/resume ─▶ preview ─▶ apply ─▶ mission.budget_resumed ─▶ scheduler resumes
```

## 5. Tasks
- [ ] `packages/catalog/schemas/budgets.schema.ts` (`ReservePolicy`, `MissionBudgetPolicy`, `BudgetsPolicy`) + example in `examples/policies/budgets.yaml`.
- [ ] `packages/core/src/policy/budgets/`: `evaluateReserve`, `evaluateMissionBudget`, `mergeBudgets` implementing R-B1…R-B9; 100 % branch tests.
- [ ] `CostEstimator` in core (`outcomes` ≥ 3 samples else taxonomy `defaultBudget`), shared with M4-06; unit tests for both sources and the sample gate.
- [ ] `reserveConstraint` + `missionBudgetConstraint` registered in the M2-04 constraint map; engine golden tests extended (non-review task excluded, `code-review` task still admitted, Lead role exempt).
- [ ] Migration `m4_04_budgets` (`mission_budget_usage`, `reserve_breaches`) + repositories + in-memory doubles.
- [ ] Budgets loader with hot reload, fail-safe on invalid YAML, `policy.invalid` Attention item.
- [ ] `EvaluateBudgets` use case + event subscriptions + 2 s debounce; breach-episode open/close with hysteresis.
- [ ] Mission usage accumulation from `task_results.usage_json` + session wall-clock; `costSource` propagation.
- [ ] `PauseMissionOnBudget` / `ResumeMission` use cases; `MissionScheduler` respects `budget_paused`.
- [ ] Attention items `quota.reserve_breached`, `mission.budget_exhausted` (raise + auto-resolve on reset/resume).
- [ ] HTTP: `GET /fleet/budgets`, `GET /missions/:id/budget`, `POST /missions/:id/budget/resume` (with preview), `GET /policies/budgets`; DTOs + OpenAPI; audit on resume/raise.
- [ ] Web: mission budget banner (warn/exhausted, shape + text), resume dialog with preview, reserve reason chip in the Quick Delegate preview.
- [ ] FakeProvider scenario `burn-into-reserve.yaml` (steady burn until `remaining` < reserve).
- [ ] Config keys `policies.budgets.*` defaults; `features.budgets` flag.
- [ ] Docs: `examples/policies/README` budgets section; new events into `04-domain-model.md` §3; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-04-01 | unit | `evaluateReserve` with `reservePct` 20 at `remaining` 25 %, 20 %, 15 % | `ok`, `warn`/boundary, `breached`; `reservedUnits = ceil(limit × 0.2)`; `confidence: 'estimate'` |
| UT-M4-04-02 | unit | reserve with unknown `limit`, `limit: 0`, `reservePct: 0`, `reservePct: 100` | `not-evaluable` / `not-evaluable` / never blocks / blocks everything except exempt task types (R-B3, R-B9) |
| UT-M4-04-03 | unit | `reserveConstraint` for `feature-impl` vs `code-review` vs `role: lead` on a breached provider | `0` / `1` / `1`, each with the matching reason string (R-B2) |
| UT-M4-04-04 | unit | `mergeBudgets` with workspace 20 % and mission 35 % for the same `(provider, window)` | most restrictive (35 %) wins; provenance of each field recorded (R-B8) |
| UT-M4-04-05 | unit | `evaluateMissionBudget` at 79 %, 80 %, 100 %, 140 % of `maxTokens` | `ok`, `warn`, `exhausted` + `budgetPaused`, `exhausted` (no overflow, no negative remaining) (R-B6, R-B7) |
| UT-M4-04-06 | unit | `CostEstimator` with 0, 2, 5 outcome samples | taxonomy default / taxonomy default / outcomes-based, `source` and `sampleCount` reported (R-B4) |
| AT-M4-04-01 | application | window drifts ok → breached → ok → breached | exactly two `quota.reserve_breached` events, two `reserve_breaches` rows with `closed_at` set on recovery; no event storm inside a state (R-B5) |
| AT-M4-04-02 | application | assignment of 10 mixed tasks while codex is inside its review reserve | zero non-review tasks on codex; all `code-review` tasks still assigned to codex; every excluded decision carries `reserve: review` |
| AT-M4-04-03 | application | mission reaches `maxTokens` with 3 queued and 2 running tasks | scheduler starts nothing new; the 2 running tasks finish normally; `mission.budget_paused` emitted once |
| AT-M4-04-04 | application | `resume` without / with `raiseTo` | first resumes at the same cap and re-pauses on the next completed task; second applies the new cap (audited) and keeps running |
| AT-M4-04-05 | application | invalid `budgets` YAML hot-reloaded | reload rejected, previous policy still effective, `policy.invalid` Attention item, no assignment behaviour change |
| IT-M4-04-01 | integration | restart while a mission is budget-paused and a reserve is breached | both states restored from DB; scheduler still skips the mission; no duplicate breach events |
| E2E-M4-04-01 | e2e (Playwright + FakeProvider) | `burn-into-reserve.yaml` on `fake-b` with a 20 % review reserve | Attention breach item appears; Quick Delegate preview for a `feature-impl` task shows `fake-b` excluded with reason `reserve: review`; a `code-review` task still previews `fake-b` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-04-01 | Review reserve protects reviews | 1. In `~/orchestra-scratch/.orchestra/workspace.yaml` add `policies.budgets.reserves: [{ id: rev-fake-b, kind: review, providerId: fake-b, window: 5h, reservePct: 20 }]`. 2. Run `burn-into-reserve.yaml` on `fake-b` until `remaining < 20 %`. 3. Quick Delegate a `feature-impl` task, then a `code-review` task; read both previews. | Breach Attention item names the policy id and the remaining %. `feature-impl` preview excludes `fake-b` with reason `reserve: review`; `code-review` preview still offers `fake-b`. Both numbers labelled *estimate*. | ⬜ |
| TC-M4-04-02 | Lead reserve on a real provider | 1. Add `{ id: lead-claude, kind: lead, providerId: claude, window: 5h, reservePct: 15 }`. 2. Run several `quick` tasks on Claude Code until the 5-h forecast reports remaining < 15 %. 3. Quick Delegate one more non-lead task and inspect the preview. | Claude is excluded for the non-lead task with reason `reserve: lead`; starting a Lead session on Claude is still allowed. No vendor call is made to check any of this (C2). | ⬜ |
| TC-M4-04-03 | Mission cap warns then pauses | 1. Create a mission with `budget: { maxTokens: <≈ 2 tasks worth>, warnAtPct: 80, onExhausted: pause }` on FakeProvider. 2. Let it run. | At ≥ 80 % the banner says "80 % of token budget used"; at 100 % the mission banner reads "paused — budget", no new tasks start, running tasks finish, Attention shows *Resume* / *Raise cap & resume*. | ⬜ |
| TC-M4-04-04 | Resume with a raised cap (preview first) | 1. From TC-03, click *Raise cap & resume*, set `maxTokens` ×2. 2. Confirm the preview. | The dialog previews old vs new cap and the queued tasks that would start; on confirm the mission resumes, `missions.budget_json` is updated, an audit row records who raised it and from/to values (C10). | ⬜ |
| TC-M4-04-05 | Negative: unknown limit ⇒ reserve inert | 1. Add a review reserve on a provider whose window has no `limit` (Claude, unless a vendor figure arrived). 2. Quick Delegate a `feature-impl` task. | The provider is **not** excluded; the decision reason reads `reserve: not-evaluable`. No limit is invented to make the reserve computable (R-B3 / R-W4). | ⬜ |
| TC-M4-04-06 | Negative: invalid budgets YAML | 1. Set `reservePct: 150` and save `workspace.yaml`. | Hot reload is rejected; the previous budgets stay effective; Attention shows `policy.invalid` with the failing path; assignment behaviour is unchanged; the daemon does not crash. | ⬜ |
| TC-M4-04-07 | Restart while paused and breached | 1. With a mission budget-paused and a reserve breached, `kill -9` the daemon. 2. Restart. 3. Read `GET /fleet/budgets` and `GET /missions/:id/budget`. | Same breach episode (same `episodeId`, no new event), same `budgetPaused: true`, scheduler still skips the mission; resuming works normally afterwards. | ⬜ |
| TC-M4-04-08 | Real provider, observed safely | 1. Do not provoke a rate limit (C5). 2. During normal work on Codex, set a small review reserve and watch `GET /fleet/budgets` as the real window fills. | The reserve status tracks the real `used`/`limit` (or reports `not-evaluable` when the vendor gives no limit), the breach fires only once at the transition, and every number in the payload and UI carries `confidence: "estimate"`. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `evaluateReserve`, `evaluateMissionBudget` and `mergeBudgets` reach **100 % branch coverage**; no output is negative, `NaN` or `Infinity`.
- [ ] A breached review reserve excludes non-review tasks from that provider and never excludes the task types it protects (AT-M4-04-02, TC-M4-04-01); a breached Lead reserve never blocks a `role: lead` session.
- [ ] A window with no known `limit` makes the reserve `not-evaluable` and changes no routing decision — nothing is fabricated (TC-M4-04-05).
- [ ] `quota.reserve_breached` fires once per episode with a `reserve_breaches` row opened and closed; no event storm while the state is unchanged.
- [ ] A mission at 100 % of any cap starts no new tasks, kills nothing, and can only be resumed through an audited, previewed action.
- [ ] Budgets hot-reload; invalid policy never takes effect and never crashes the daemon.
- [ ] Every budget figure surfaced by API or UI carries `confidence: 'estimate'` and its `costSource`.
- [ ] All TC-M4-04-01…08 pass and are recorded with build hash and date.
- [ ] No new ESLint / dependency-cruiser violations; `packages/core` still imports nothing; the M2-04 golden suite passes with the two new constraints registered.
- [ ] New events documented in `04-domain-model.md` §3; `examples/policies/budgets.yaml` shipped; `PROGRESS.md` row updated.

## 8. Risks / open questions
- Reserves are only as good as `limit`. For providers that never report a limit (likely Claude — verify against Claude Code docs at step start) reserves are inert and G2/G3 protection relies on M4-03 cooling alone. Document this plainly in the Fleet copy (M4-07) rather than guessing a limit.
- `estimatedCost(task)` before a task runs is weak early on (taxonomy defaults). An under-estimate lets a task slip past a reserve it should have respected. Mitigation: `warnAtPct` fires before the reserve is actually touched, and M8-06 improves the estimator from outcomes.
- Mixing units: a reserve on a `credits` window (agy — verify against Antigravity docs at step start) and one on a `tokens` window cannot be compared; the ledger keeps them separate and the merge rule only compares reserves for the same `(provider, window)`.
- "Most restrictive wins" (R-B8) can surprise a user who raises a mission budget while the workspace layer is tighter; `GET /policies/budgets` shows the winning layer per field to make this diagnosable. Full precedence UX lands with M8-01.
- Pausing on a cap can strand a mission mid-DAG with a half-merged integration branch. Running tasks are allowed to finish precisely to avoid that; a mission that is paused for a long time is a human decision surfaced in Attention, not an automatic cancel.
- Interaction with M4-03: a provider can be simultaneously cooling and inside its reserve. Both constraints return 0 independently and both reasons are recorded; no ordering dependency is introduced between them.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
