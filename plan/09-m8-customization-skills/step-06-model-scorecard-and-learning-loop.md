# Step M8-06 — Model Scorecard & learning loop

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M3-04, M4-01 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | High |
| Owner | |

## 1. Goal
After this step Orchestra learns from its own work. Every finished task — mission task (M3-03/M3-04), Quick Delegate, or skill eval (M8-05) — writes an `Outcome` row; a pure `OutcomeAggregator` rolls those into per-`(model, taskType)` evidence (review findings per 100 LOC, test pass rate, rework rounds, latency p50/p90, estimated cost, sample size, recency); a pure `LocalProfileAdjuster` turns that evidence into **shadow-only proposals for bounded, decaying adjustments of local model-profile dimension weights — hard-capped at ±0.2, never below `minSamples`, never touching constraints, ToS or auth rules**. The Models › Scorecard screen shows local evidence side by side with the community baseline, lists every adjustment with the evidence that produced it, and offers a reset. `orch outcomes export --anonymised` produces an opt-in bundle with no repo names, goals, paths or identifiers.

## 2. Why
- **D7 / `06-intelligence-layer.md §3`** — the learning loop is written into the intelligence layer's definition: outcomes adjust *local* profile weights and surface as a Model Scorecard. Until now the `outcomes` table has had writers planned but no consumer.
- **G2** — "right model, every time" cannot improve without evidence. The default matrix is a starting point; the scorecard is how it stops being a guess for *this* user's repos.
- **G5** — every adjustment is traceable to the rows that caused it; "why did routing change" is answerable from the UI.
- **C10 / truth labelling (UX principle 4)** — an adjusted profile changes what spends. Sample size, confidence and the evidence behind every number are displayed; nothing is presented as fact at `n=1`.
- **Data handling (07 §Data handling)** — nothing leaves the host unless the user opts in. The export bundle is the opt-in path and is anonymised by construction, not by promise.
- **C3 / C4** — the loop adjusts capability *dimensions* only. It can never alter allowlists, ToS gates, auth behaviour or the seven/eight constraint strategies; a test asserts the adjuster's output type cannot reach them.

## 3. Scope
### In scope
- `RecordOutcome` use case and its three callers (M3-03 result collection, M3-04 review completion, M8-05 eval scoring), with idempotency per `(task_id, source)`.
- Pure `OutcomeAggregator`: windowed, recency-decayed aggregation per `(model, taskType)` and per `(model, taskType, skill)`.
- Pure `LocalProfileAdjuster`: evidence → dimension deltas, hard-capped at ±0.2 per dimension, gated by `minSamples` (default 5), decayed by a half-life (default 30 d), monotone and deterministic.
- `model_profiles` local rows (`source: 'local'`) carrying `adjustments_json`, `base_profile_id`, `computed_at`, consumed by the existing `ModelCatalogPort` so the assignment engine needs no change.
- A new reason code `local-evidence` on routing decisions only after an explicitly approved policy version applies a proposal.
- `learning` settings section (M8-01): `enabled`, `minSamples`, `maxDelta`, `halfLifeDays`, `sources` (which of mission/quick/eval count), `perSkill`.
- Models › Scorecard screen: `(model, taskType)` grid, cell detail with evidence vs community baseline, adjustment history, reset (per model / per cell / all).
- `orch outcomes list|show|export`, `orch models scorecard`, `orch models reset-adjustments`.
- Export bundle format (JSONL + manifest + schema version), opt-in, previewable before writing.
### Out of scope (deferred to …)
- Uploading the bundle anywhere → deferred to M10-02 (community drift/outcome loop). This step only *writes a file* and shows what is in it.
- Learning quota-forecast parameters (half-lives) from outcomes → flagged in M4-02 §8; still deferred, out of scope here.
- Choosing a Lead handoff target from learned outcomes → deferred (M4-05 §out-of-scope notes it).
- Adjusting `costTier`, `contextWindow`, `bestFor`/`avoidFor` lists, or any constraint → never; only `dimensions` move.
- Cross-user / cross-host aggregation → deferred to M9-05 (team mode); M8 aggregates one host's rows.
- Skill-on vs skill-off A/B → deferred to M10 (noted in M8-05).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
Both engines are pure domain services in `packages/core/src/intelligence/learning/`, with a `Clock` injected. No I/O, no repository access.

`OutcomeAggregator` rules:
- Aggregation window: rows newer than `halfLifeDays × 4` (default 120 d) with weight `w = 0.5 ^ (ageDays / halfLifeDays)`. Older rows are ignored entirely, so a model's reputation cannot be frozen by ancient evidence.
- `sampleSize` is the **unweighted** row count; every displayed metric is the weighted mean. Reporting a weighted count as `n` would overstate confidence.
- Metrics per `(model, taskType)`: `findingsPer100Loc` (blockers ×1.0 + majors ×0.3 + minors ×0.1, per 100 changed LOC from `task_results.diff_stat_json`), `testPassRate`, `reworkRounds` (review rounds until approval), `latencyP50Ms`, `latencyP90Ms`, `costEstTokens`, `sampleSize`, `lastAt`, `sources` breakdown.
- Rows with `source` excluded by `learning.sources` are aggregated for *display* but flagged and excluded from adjustment input, so a user can see eval evidence without letting it move weights.
- A task that was cancelled, blocked or never produced a `TaskResult` writes no outcome. A failed task writes one with `testsPassRate = 0` — failure is evidence.

`LocalProfileAdjuster` rules:
- Runs only when `sampleSize ≥ minSamples` for that `(model, taskType)` **and** `learning.enabled`.
- Maps evidence to the dimensions the task type's weights actually use (`06 §1`): `findingsPer100Loc` and `testPassRate` → `reasoning` and `instructionFollowing`; `reworkRounds` → `instructionFollowing`; `latency` → `speed`; `toolUse` moves only on tool-related finding categories (`correctness` with a tool context) — never on aggregate quality.
- Delta per dimension: `delta = clamp(k × (metricZ), −maxDelta, +maxDelta)` where `metricZ` is the model's weighted metric against the **cohort median for that task type across all models with ≥ minSamples**, and `k` is a fixed gain (0.1). Comparing against the cohort, not an absolute threshold, means a hard task type does not penalise everyone.
- The adjustment itself decays: a stored adjustment is recomputed on every aggregation run from current evidence, so removing the evidence removes the adjustment. There is no accumulating counter to run away.
- `|delta| ≤ 0.2` is enforced **in core**, in one place, and asserted by a property test over random evidence: no input sequence produces a larger magnitude.
- Adjusted dimension = `clamp01(base + delta)`. The base profile is never mutated; a `source: 'local'` row holds the deltas and points at `base_profile_id`.
- Determinism: same rows + same `now` ⇒ byte-identical adjustments. No randomness, no iteration-order dependence.
- Safety: the adjuster's return type is `Record<DimensionKey, number>` and nothing else. It cannot express a change to allowlists, cost tiers, constraints or ToS state — a type-level guarantee backed by UT-M8-06-06.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/learning/types.ts
export type OutcomeSource = 'mission' | 'quick' | 'eval';
export interface Outcome {
  id: string; modelId: ModelId; providerId: ProviderId; taskType: TaskTypeId; taskId?: TaskId;
  skillId?: string; skillVersion?: string; evalRunId?: string; source: OutcomeSource;
  blockerFindings: number; majorFindings: number; minorFindings: number;
  changedLoc: number; testsPassRate: number | null; reworkRounds: number;
  latencyMs: number; costEstTokens: number | null; quality?: number; createdAt: string;
}
export interface Evidence {
  modelId: ModelId; taskType: TaskTypeId;
  findingsPer100Loc: number; testPassRate: number | null; reworkRounds: number;
  latencyP50Ms: number; latencyP90Ms: number; costEstTokens: number | null;
  sampleSize: number; weightedSampleSize: number; lastAt: string;
  sources: Readonly<Record<OutcomeSource, number>>;
  eligibleForAdjustment: boolean; ineligibleReason?: 'below-min-samples' | 'source-excluded' | 'learning-disabled';
}
export class OutcomeAggregator {
  constructor(private readonly clock: Clock, private readonly cfg: LearningSettings) {}
  aggregate(rows: readonly Outcome[]): readonly Evidence[];                       // pure, deterministic
  aggregateBySkill(rows: readonly Outcome[]): readonly (Evidence & { skillId: string })[];
}

export interface ProfileAdjustment {
  modelId: ModelId; taskType: TaskTypeId;
  deltas: Readonly<Partial<Record<DimensionKey, number>>>;                        // |delta| ≤ maxDelta, enforced in core
  evidence: Evidence; computedAt: string; explanation: readonly string[];         // one line per delta
}
export class LocalProfileAdjuster {
  constructor(private readonly cfg: LearningSettings) {}
  adjust(evidence: readonly Evidence[]): readonly ProfileAdjustment[];            // pure, deterministic
}
export interface LearningSettings {
  enabled: boolean; minSamples: number; maxDelta: number; halfLifeDays: number;
  sources: readonly OutcomeSource[]; perSkill: boolean;
}

// apps/daemon/src/application/learning/*.use-case.ts
export class RecordOutcome {
  /** Idempotent by (taskId, source); called by M3-03, M3-04 and M8-05. */
  execute(cmd: { outcome: Omit<Outcome, 'id' | 'createdAt'>; actor: Actor }): Promise<Result<void, DomainError>>;
}
export class RecomputeLocalProfiles {
  execute(cmd: { modelIds?: readonly ModelId[]; reason: 'outcome' | 'settings' | 'manual' }):
    Promise<Result<{ changed: number; adjustments: readonly ProfileAdjustment[] }, DomainError>>;
}
export class ResetLocalAdjustments {
  execute(cmd: { scope: 'all' | { modelId: ModelId } | { modelId: ModelId; taskType: TaskTypeId }; actor: Actor }):
    Promise<Result<{ removed: number }, DomainError>>;
}
export class ExportOutcomes {
  execute(cmd: { anonymised: true; outPath: string; from?: string; to?: string; preview?: boolean }):
    Promise<Result<{ path?: string; rows: number; sample: readonly unknown[] }, DomainError>>;
}
```

```yaml
# settings section registered by this step (any layer)
learning:
  enabled: true
  minSamples: 5
  maxDelta: 0.2          # hard-capped in core; a larger value here is clamped and warned
  halfLifeDays: 30
  sources: [mission, quick]     # 'eval' excluded from adjustment by default, still shown
  perSkill: true
telemetry:
  anonymisedExport: false       # M8-01's key; export refuses to run while false
```

### 4.3 Data / schema changes
- `outcomes` gains the columns M8-05 introduced (`provider_id`, `skill_id`, `skill_version`, `eval_run_id`, `source`, `quality`, `created_at`); if M8-06 lands first, migration `m8_06_outcomes_ext` creates them and M8-05 reuses them. Additionally: `blocker_findings`, `major_findings`, `minor_findings`, `changed_loc INTEGER NOT NULL DEFAULT 0` (`review_findings` is kept as the legacy total for compatibility). Unique index `(task_id, source)` for idempotency.
- `model_profiles` (`04 §4`) already has `source(community/local)` and `evidence_json`. Migration `m8_06_local_profiles` adds `base_profile_id TEXT NULL`, `adjustments_json TEXT NULL`, `computed_at TEXT NULL`; unique index `(model_id, source)`.
- New table `profile_adjustment_history`: `id, model_id, task_type, deltas_json, evidence_json, computed_at, reason, actor_json` — append-only, so the Scorecard can show "this weight moved on 2026-09-02 because of these 7 tasks".
- New events: `learning.outcome_recorded {taskId, modelId, taskType, source}`, `learning.profiles_recomputed {changed, reason}`, `learning.adjustments_reset {scope, removed, actor}`, `learning.export_created {rows, path, schemaVersion}`. `audit_log` rows for reset and export (both are user-visible, consequential actions).
- No change to `routing_decisions` beyond the new `local-evidence` reason code in the existing closed union (a typed change, per M2-04).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `OutcomeRepository` and `LocalProfileRepository` in `apps/daemon/src/infrastructure/learning/`.
- Recompute trigger: debounced (30 s) after any `RecordOutcome`, plus on `learning.*` settings change, plus on demand. Recompute is a single pass over the aggregation window per affected model — indexed by `(model_id, task_type, created_at)`, so it stays a millisecond-scale query even at tens of thousands of rows.
- The recomputed local profile is published through the existing `ModelCatalogPort` hot-reload path (M2-02), so the assignment engine picks it up with no code change and `catalogVersion` on the next decision changes.
- Export: writes `outcomes-<hostHash>-<from>-<to>.jsonl` + `manifest.json` into a user-chosen directory. **Anonymisation is structural**: the exporter builds each row from an explicit allowlist of fields (`modelId`, `providerId`, `taskType`, metrics, bucketed `changedLoc`, `source`, coarse `createdAt` to the day) — there is no "strip the bad fields" pass that a new column could sneak past. `taskId`, `skillId` (unless the skill is a shipped pack id), repo paths, goals, branch names and host id are never present; `hostHash` is a salted, rotating hash stored locally only.
- Export requires `telemetry.anonymisedExport: true` **and** an interactive confirmation showing a sample of the exact rows to be written (C10, data handling).
- No network in this step. The `no-vendor-endpoints` ESLint rule and the M0-08 egress test cover the module; uploading is M10-02's problem.
- No tmux, no git, no child processes.

### 4.5 API / UI surface
- `GET /api/models/scorecard?taskType=&modelId=` → cells with `Evidence`, community baseline, current adjustment and its explanation.
- `GET /api/models/:modelId/adjustments` → history rows.
- `POST /api/models/adjustments/recompute` (manual trigger, audited).
- `POST /api/models/adjustments/reset` — body `{ scope }` → audited reset.
- `GET /api/outcomes?modelId=&taskType=&source=&from=&to=&cursor=` → paged rows (the evidence behind a cell).
- `POST /api/outcomes/export` — body `{ anonymised: true, outPath, from?, to?, preview? }`; `preview: true` returns the sample without writing.
- WS topic `learning`: `learning.profiles_recomputed` so the Scorecard and the routing preview refresh.
- CLI: `orch models scorecard [--task-type] [--json]`, `orch models reset-adjustments [--model] [--task-type]`, `orch outcomes list`, `orch outcomes show <taskId>`, `orch outcomes export --anonymised --out <dir> [--preview]`.
- UI `apps/web/src/features/models/scorecard/` (the Scorecard promised in `12-ux-principles.md` for Models):
  - `ScorecardGrid` — rows = models, columns = task types (or transposed); each cell shows the headline metric, `n=<sampleSize>`, a confidence chip (`n<minSamples` reads *insufficient evidence* in words, not a faded colour), and an adjustment marker when a delta is active.
  - `ScorecardCellDetail` — two-column comparison **local evidence vs community baseline** for every metric, with the community `evidence[]` entries from the profile (benchmark name, date, url) shown verbatim so the user can see what they are disagreeing with; the active deltas with one explanation line each; a link to the underlying outcome rows.
  - `AdjustmentHistory` — timeline of `profile_adjustment_history` with before/after dimension values and the evidence snapshot.
  - `ResetAdjustmentsDialog` — scope picker (this cell / this model / all), consequence text ("routing will return to the community profile for N task types"), confirm.
  - `ExportBundleDialog` — settings gate (`telemetry.anonymisedExport`) with a link to turn it on, row-count and date-range preview, a **sample of actual rows** rendered as JSON, then Write.
  - Integration: the "why this model" panel (M2-09) gains a *local evidence* reason chip that deep-links into the scorecard cell.
  - States: `no-data` (fresh install, with "run some tasks or a skill eval"), `insufficient-evidence`, `learning-disabled`, `computing`, `ok`, `export-blocked`.
- Accessibility: every number is labelled *local* or *community*; confidence is words plus icon; the grid is a real table with header scopes; EN/AR and RTL verified.

### 4.6 Flow / sequence
```
task finishes (M3-03 result / M3-04 review verdict / M8-05 eval score)
   └─▶ RecordOutcome (idempotent by (taskId, source)) ─▶ outcomes row ─▶ learning.outcome_recorded
        └─▶ debounce 30 s ─▶ RecomputeLocalProfiles(reason:'outcome')
              ├─ OutcomeRepository.window(modelIds, now − 4×halfLife)
              ├─ OutcomeAggregator.aggregate  ─▶ Evidence[] (weighted, decayed, sampleSize unweighted)
              ├─ LocalProfileAdjuster.adjust  ─▶ ProfileAdjustment[]  (|delta| ≤ 0.2, minSamples gate)
              ├─ model_profiles(source='local').upsert + profile_adjustment_history append
              └─ ModelCatalogPort hot reload ─▶ learning.profiles_recomputed ─▶ WS 'learning'

next routing decision ─▶ AssignmentEngine reads the adjusted dimensions (no engine change)
   ─▶ if an approved policy version changed the ranking, reasons include `local-evidence`
   ─▶ "why this model" chip ─▶ deep link ─▶ Scorecard cell ─▶ the outcome rows behind it

reset ─▶ ResetLocalAdjustments ─▶ delete local rows in scope ─▶ audit ─▶ recompute ─▶ community profile in effect
export ─▶ telemetry.anonymisedExport gate ─▶ allowlisted field projection ─▶ preview sample ─▶ confirm
        ─▶ outcomes-<hostHash>-<range>.jsonl + manifest.json ─▶ learning.export_created + audit
```

### 4.7 Review reconciliation contract (2026-09-15)
Default learning mode is shadow: compute proposals and scorecards while routing uses the current approved policy. `minSamples` is a display/eligibility threshold, not proof of causal superiority. Segment by task type, difficulty, provider version, evaluation source and missing outcomes; show uncertainty and selection bias. Applying a proposal requires a recorded evaluation report on representative held-out tasks, a human-approved versioned policy change, rollback criteria and subsequent observation. No automatic routing-weight write is allowed in v1; reset/history/export remain available.

## 5. Tasks
- [ ] `Outcome` / `Evidence` / `ProfileAdjustment` VOs + `LearningSettings`; register the `learning` settings section against M8-01.
- [ ] `OutcomeAggregator` — decay weighting, unweighted sample size, per-source breakdown, eligibility flags; 100 % branch coverage.
- [ ] `LocalProfileAdjuster` — cohort-median mapping, fixed gain, hard ±`maxDelta` clamp in one place, `minSamples` gate, per-delta explanation strings; property test for the cap.
- [ ] `RecordOutcome` use case with `(task_id, source)` idempotency; wire the three callers (M3-03, M3-04, M8-05) without changing their public shapes.
- [ ] `RecomputeLocalProfiles` with debounce and settings-change trigger; publish through `ModelCatalogPort` hot reload.
- [ ] `ResetLocalAdjustments` (three scopes) + audit; `profile_adjustment_history` append on every recompute that changes a delta.
- [ ] Migrations `m8_06_outcomes_ext` (coordinate with M8-05's `m8_05_outcomes_ext` — whichever lands first owns the shared columns), `m8_06_local_profiles`, `m8_06_adjustment_history` + repositories and indexes.
- [ ] Add `local-evidence` to the `ReasonCode` union and emit it from the engine when an adjustment changed the chosen candidate; update the reason-label table.
- [ ] `ExportOutcomes` with structural field allowlist, bundle manifest (`schemaVersion`, range, row count, salted `hostHash`), preview mode, settings gate, audit.
- [ ] Event schemas `learning.*`; WS topic `learning`.
- [ ] Controllers: scorecard, adjustments, recompute, reset, outcomes list, export + OpenAPI.
- [ ] `apps/web`: `ScorecardGrid`, `ScorecardCellDetail` (local vs community), `AdjustmentHistory`, `ResetAdjustmentsDialog`, `ExportBundleDialog`; `local-evidence` chip + deep link in the M2-09 "why this model" panel.
- [ ] CLI `orch models scorecard|reset-adjustments`, `orch outcomes list|show|export`.
- [ ] Coverage gate: add `packages/core/src/intelligence/learning/**` to the 100 %-branch list.
- [ ] Docs: "How Orchestra learns" — what moves, what never moves, the ±0.2 cap, decay, reset, export.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-06-01 | unit | aggregate 20 rows spanning 90 days | weighted metrics match a hand-computed fixture; `sampleSize` is the raw count; rows older than 4 × half-life excluded |
| UT-M8-06-02 | unit | `(model, taskType)` with 4 rows, `minSamples: 5` | `eligibleForAdjustment: false`, reason `below-min-samples`; adjuster produces no delta |
| UT-M8-06-03 | unit | property test: 10 000 random evidence sets | every produced delta satisfies `|delta| ≤ maxDelta` and `maxDelta ≤ 0.2`; adjusted dimensions stay in `[0,1]` |
| UT-M8-06-04 | unit | same rows aggregated twice with the same `now` | byte-identical adjustments; no iteration-order or float-accumulation drift |
| UT-M8-06-05 | unit | evidence removed (rows age out) | the adjustment disappears on recompute — adjustments are derived, never accumulated |
| UT-M8-06-06 | unit | adjuster output type / attempt to express a cost-tier or allowlist change | compile-time impossible; runtime test asserts only `dimensions` keys appear and no constraint field is writable (C3/C4) |
| UT-M8-06-07 | unit | `sources: [mission]` with eval rows present | eval rows appear in `Evidence.sources` and in the UI, but `eligibleForAdjustment` is false with `source-excluded` |
| AT-M8-06-01 | application | `RecordOutcome` replayed for the same `(taskId, source)` | one row; no duplicate recompute; no history entry |
| AT-M8-06-02 | application | `ExportOutcomes` with `telemetry.anonymisedExport: false` | refused with a typed error; nothing written |
| AT-M8-06-03 | application | export bundle field audit | every emitted key is on the allowlist; a deliberately added `goal` column on `outcomes` does **not** appear in the bundle |
| IT-M8-06-01 | integration | complete 6 FakeProvider tasks of one task type | outcomes written; recompute runs once (debounced); a local profile row exists; `learning.profiles_recomputed` emitted |
| IT-M8-06-02 | integration | routing before vs after the adjustment | the decision changes and its reasons include `local-evidence`; `catalogVersion` on the decision differs from before |
| IT-M8-06-03 | integration | reset adjustments | local rows removed, audit row written, next decision matches the pre-learning golden result exactly (M2-04 suite still passes) |
| E2E-M8-06-01 | e2e | Scorecard cell detail | local vs community columns both rendered with source labels; `n=` shown; cells below `minSamples` read *insufficient evidence* in words |
| E2E-M8-06-02 | e2e | export dialog | blocked while the setting is off, with a link to enable; after enabling, the preview shows real sample rows; Write produces the JSONL + manifest; axe-clean dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-06-01 | Scorecard from real outcomes (exit criterion 3) | 1. After M3-09 and TC-M8-05-02 have produced real tasks, open Models › Scorecard 2. Pick `feature-impl` | ≥ 3 `(model, taskType)` cells show sample size, findings/100 LOC, test pass rate, rework rounds, latency and cost; every number is labelled *local* or *community* | ⬜ |
| TC-M8-06-02 | Bounded, decaying adjustment | 1. Open a cell with `n ≥ 5` 2. Read the adjustment list 3. `orch models scorecard --json` | Every delta is within ±0.2 with a one-line explanation; the JSON shows the same values; the half-life in effect matches `learning.halfLifeDays` | ⬜ |
| TC-M8-06-03 | Evidence vs community baseline | 1. Open the cell detail | Local metrics sit beside the community `evidence[]` entries (benchmark name, date, url) from the profile; disagreements are visible rather than silently overridden | ⬜ |
| TC-M8-06-04 | Routing cites local evidence | 1. Preview a task of the adjusted type 2. Open "why this model" 3. Click the local-evidence chip | The reasons include `local-evidence`; the chip deep-links to the scorecard cell; the outcome rows behind the cell are listed | ⬜ |
| TC-M8-06-05 | Reset | 1. Reset adjustments for one model 2. Preview the same task again | Reset is confirmed with consequence text and audited; the decision returns to the community-profile result; the adjustment history still shows what was removed | ⬜ |
| TC-M8-06-06 | Negative: insufficient evidence | 1. Find a `(model, taskType)` cell with `n < minSamples` 2. Read the cell and the profile | Cell reads *insufficient evidence* in words with `n=`; no delta exists; routing for that pair is unchanged from the community profile | ⬜ |
| TC-M8-06-07 | Negative: export blocked and anonymity | 1. With `telemetry.anonymisedExport: false`, run `orch outcomes export --anonymised --out /tmp/x` 2. Enable the setting, run with `--preview` 3. Run for real and `grep` the bundle for a repo path, a branch name, a task goal and the host id | Step 1 refuses with the setting named; step 2 prints sample rows without writing; step 3 writes the bundle and every grep returns nothing (data handling) | ⬜ |
| TC-M8-06-08 | Negative: learning disabled / conflicting layers | 1. Set `learning.enabled: false` in `user.yaml` while `org.yaml` sets `true` 2. Recompute 3. Set `maxDelta: 0.5` in `user.yaml` | User layer wins (M8-01 precedence) and no adjustments apply, with the reason shown; `maxDelta: 0.5` is clamped to 0.2 with a visible warning naming the file and line | ⬜ |
| TC-M8-06-09 | Reload / resilience | 1. Kill the daemon mid-recompute (`kill -9`) 2. Restart 3. Open the Scorecard and preview a task | No partially written local profile: either the previous adjustment or a freshly recomputed one, never a mixture; history has no torn entry; the preview works throughout | ⬜ |

### 6.3 Review regression scenarios
- [ ] Five favorable observational samples create a proposal but do not change routing.
- [ ] Held-out evaluation and approval bind the exact proposal/policy version.
- [ ] Mixed eval/production cohorts are visible and do not imply causal superiority.
- [ ] Rollback restores the prior policy without deleting outcome history.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] Every finished mission task, Quick Delegate and skill eval writes exactly one idempotent `Outcome` row (AT-M8-06-01, IT-M8-06-01).
- [ ] Adjustments are bounded to ±0.2, gated by `minSamples`, recency-decayed and *derived* — removing evidence removes the adjustment (UT-M8-06-03/05, TC-M8-06-02).
- [ ] The loop can only move profile dimensions; constraints, allowlists, cost tiers, ToS and auth are unreachable by construction (UT-M8-06-06).
- [ ] Models › Scorecard shows ≥ 3 populated `(model, taskType)` cells with all six metrics, sample size and local-vs-community comparison (milestone exit criterion 3, TC-M8-06-01/03).
- [ ] A routing decision influenced by an adjustment says so with `local-evidence` and deep-links to the evidence (IT-M8-06-02, TC-M8-06-04).
- [ ] Reset returns routing to the community profile and keeps the M2-04 golden suite passing (IT-M8-06-03, TC-M8-06-05).
- [ ] Export is opt-in, previewed, structurally anonymised, audited, and contains no repo paths, goals, branch names, task ids or host id (AT-M8-06-02/03, TC-M8-06-07).
- [ ] `packages/core/src/intelligence/learning/**` at 100 % branch coverage; recompute is deterministic.
- [ ] Scorecard is keyboard-operable, axe-clean in dark/light and RTL; confidence and provenance are words, never colour alone.
- [ ] All TC-M8-06-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Overfitting on small samples is the headline risk** (milestone README). `minSamples: 5` is a guess; five tasks of one type on one repo is thin evidence for a dimension shift. Mitigation: the cap is ±0.2 (it can reorder near-ties, not promote a bad model), cohort-relative comparison, decay, a visible reset, and `learning.enabled` defaulting to **true only after the first 20 outcomes exist on the host** — decide that bootstrap rule during implementation and record it in the log.
- **Metric attribution is imperfect.** Review findings depend on the reviewer model as much as the author; `changedLoc` from a diffstat mixes generated and hand-written code; latency includes the user's own answer time on prompts. Mitigation: findings are cohort-relative (a harsh reviewer penalises everyone equally), latency excludes time in `waiting_for_input` (assert this in the aggregator), and the cell detail always links to the raw rows.
- **Eval outcomes vs mission outcomes** share a table (flagged in M8-05 §8). Default `sources: [mission, quick]` keeps evals out of adjustments while showing them; if that proves too conservative once eval volume exists, change the default with evidence, not by intuition.
- **Cohort median needs a cohort.** With two models installed, the median is one of them and z-scores are noisy. Mitigation: require ≥ 3 models with `≥ minSamples` in the task type before any adjustment; otherwise report evidence with `ineligibleReason` and move nothing. Verify this is in place before TC-M8-06-02.
- **A learned profile makes routing non-reproducible across hosts.** Two users with the same settings can now get different assignments. That is the point, but it makes support harder. Mitigation: `catalogVersion` on every decision changes when profiles change, and the decision panel already says "policy/catalog changed since this decision" (M2-09).
- **The export bundle's schema is a public contract** the moment M10-02 consumes it. Version it (`schemaVersion`) from the first byte and treat a field removal as a breaking change.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
