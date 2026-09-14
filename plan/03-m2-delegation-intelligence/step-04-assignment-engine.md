# Step M2-04 — Assignment engine

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-02, M2-03 |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/cli` |
| Risk | High |
| Owner | |

## 1. Goal
After this step a typed task plus the set of installed provider/model candidates produces a deterministic, explainable `RoutingDecision` — chosen model, score, ordered reasons, top-3 alternatives, and the full list of excluded candidates with exclusion reasons — through one pure domain service `AssignmentEngine.decide(task, candidates, policy)`. The daemon can preview a decision without spending anything (`POST /api/routing/preview`, `orch routing preview`), persists every non-dry-run decision in `routing_decisions`, and emits `routing.decided` / `routing.dry_run`. The golden test suite reproduces every row of the default assignment matrix (`06-intelligence-layer.md §4`) including the "provider unhealthy ⇒ fallback" variants, at 100 % branch coverage.

## 2. Why
- D3: the assignment half of the two-tier orchestration must be deterministic and testable rules, not LLM guesses. This step *is* that half.
- D7: the engine holds no matrix of its own — taxonomy (M2-01), profiles (M2-02), manifests (M2-03) and policy data are its only inputs, so routing changes without a release.
- G2 ("right model for the job", ≥ 60 % of tasks off the top tier) becomes measurable the moment decisions are scored and persisted; G3 (cross-vendor review) is enforced here as a constraint strategy rather than in M3 review code.
- C10: nothing may spend quota without a preview — `dryRun` decisions are a first-class output consumed by M2-06/M2-07 and by M4-06 mission simulation.
- C5/C6: provider cooling and `manifest.limits.maxConcurrentSessions` are hard gates in the constraint set, so no caller can route past a rate limit or a vendor concurrency allowance.

## 3. Scope
### In scope
- `RoutingDecision`, `Candidate`, `PolicySet`, `ConstraintOutcome` value objects in `packages/core/src/intelligence/`.
- Pure `AssignmentEngine` (scoring §4.2, two-pass cost efficiency, deterministic tie-break) with no I/O and no clock/random access except injected ports.
- Seven shipped constraint strategies, DI-registered by id (no `switch`): cross-vendor review, risk gate, sandbox requirement, org allowlist, protect-Lead reserve, max concurrent sessions, deprecated model.
- `packages/catalog/routing/default-matrix.yaml` (the table in `06 §4` as data) + Zod schema + loader; `DefaultMatrixPolicy` implements `PolicyPort`.
- Daemon `CandidateBuilder` (manifests × model catalog × provider health/window state) and `DecideAssignment` / `PreviewAssignment` use cases.
- `RoutingDecisionRepository` + migration; idempotent re-decide for the same task and inputs.
- `POST /api/routing/preview`, `GET /api/routing/decisions/:id`, `orch routing preview`.
- Golden suite reproducing `06 §4` and a coverage gate at 100 % branches.
### Out of scope (deferred to …)
- Workspace/user routing overrides file and the decision-log UI → M2-09 (this step ships `PolicyPort` + the default matrix only).
- Quota *forecasting* (burn rate, time-to-limit) → M4-02; here `quotaAvailability` reads the coarse `WindowStatePort` (`healthy | cooling | exhausted | unknown`).
- Automatic reroute on 429 → M4-03 (it calls `decide()` again with the failed candidate excluded).
- Reviewer assignment as part of a review round → M3-04 (it calls `decide()` with `role: 'reviewer'` and the author's provider in context).
- Learning-loop weight adjustment from outcomes → M8-06.
- Mission-wide dry-run simulation across a DAG → M4-06.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`AssignmentEngine` is a **domain service** in `packages/core/src/intelligence/assignment/assignment-engine.ts` — pure, synchronous, dependency-free. Inputs are already-resolved data; the daemon does all I/O.

Rules:
- A candidate is *eligible* iff every constraint strategy returns `allowed`. The first rejecting strategy (in registration order) supplies the exclusion reason; evaluation still continues so the decision records *all* violated constraints for explainability.
- `capabilityFit = 0` when any `taskType.requiredCapabilities` flag is absent from the candidate's `manifest.features` — modelled as the `missing-capability` exclusion rather than a 0 score, so the reason is explicit.
- Policy beats score: if the policy layer names a `primary` list for the task type, eligible candidates from that list win in list order, and the score is reported for transparency. `fallback` is consulted only when no primary candidate is eligible. Score ordering decides within a tier and when the policy names nothing.
- Deterministic tie-break, applied in order: policy rank asc → score desc → `costTier` asc → `contextWindow` desc → `ModelRef` string asc. No `Math.random`, no `Date.now()` (a `Clock` value is passed in for deprecation checks).
- `alternatives` = next 3 eligible candidates after the chosen one, same ordering; fewer if fewer exist.
- Zero eligible candidates ⇒ `Err(NoEligibleCandidate)` carrying every candidate with its exclusion reasons (the UI renders this verbatim; it is the most common support question).
- `RoutingDecision.inputsHash` = stable hash over `{taskTypeId, variants, riskOverride, candidateRefs+health, policyVersion, catalogVersion, engineVersion}` — the idempotency key.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/assignment/types.ts
export interface TaskSpec {                       // the engine's view of a task (full TaskSpec contract: M3-03)
  id?: TaskId; taskTypeId: TaskTypeId; goal: string;
  variants?: Readonly<Record<string, string>>;    // { layer: 'domain' } | { platform: 'react' } | { level: 'unit' }
  language?: string;                              // repo/primary language → codeQuality lookup
  role: 'implementer' | 'reviewer' | 'lead';
  riskOverride?: RiskLevel;
  contextEstimateTokens?: number;
  authorRef?: ModelRef;                           // set for role='reviewer' (cross-vendor rule)
  requiredSandbox?: SandboxProfileId;
  budget?: Budget;
}
export interface Candidate {
  ref: ModelRef;                                  // '<provider>/<modelId>'
  profile: ModelProfile;                          // M2-02
  features: readonly CapabilityFlag[];            // manifest.features (M2-03)
  sandboxProfiles: readonly SandboxProfileId[];
  maxConcurrentSessions: number;
  activeSessions: number;
  window: WindowHealth;                           // 'healthy' | 'cooling' | 'exhausted' | 'unknown'
  manifestVerified: boolean;
  deprecated: boolean;
}
export interface PolicySet {
  version: string;
  epsilon: number;                                // default 0.03 — cost-efficiency band
  allow?: readonly ModelRefPattern[]; deny?: readonly ModelRefPattern[];
  leadReserve?: { refs: readonly ModelRef[]; minFreeSessions: number };
  taskTypes: Readonly<Record<TaskTypeId, {
    primary?: readonly ModelRef[]; fallback?: readonly ModelRef[]; reviewer?: readonly ModelRef[];
    allow?: readonly ModelRefPattern[]; deny?: readonly ModelRefPattern[];
  }>>;
  source: 'default-matrix' | 'workspace' | 'user' | 'merged';
}
export interface ScoreBreakdown {
  capabilityFit: number; quotaAvailability: number; costEfficiency: number; constraints: 1 | 0;
  perWeight: Readonly<Record<keyof TaskWeights, { weight: number; dimension: number; product: number }>>;
}
export interface ScoredCandidate {
  ref: ModelRef; score: number; breakdown: ScoreBreakdown;
  eligible: boolean; exclusions: readonly ReasonCode[]; policyRank: number | null;
}
export interface RoutingDecision {
  id?: DecisionId; taskId?: TaskId; taskTypeId: TaskTypeId;
  chosen: ModelRef; score: number; breakdown: ScoreBreakdown;
  reasons: readonly Reason[];                     // ordered, most important first
  alternatives: readonly { ref: ModelRef; score: number; reasons: readonly Reason[] }[];  // ≤ 3
  excluded: readonly { ref: ModelRef; reasons: readonly ReasonCode[] }[];
  dryRun: boolean;
  policyVersion: string; catalogVersion: string; engineVersion: string; inputsHash: string;
  decidedAt: string;
}
export interface Reason { code: ReasonCode; detail?: string; weight?: number }

// packages/core/src/intelligence/assignment/assignment-engine.ts
export class AssignmentEngine {
  constructor(private readonly constraints: readonly ConstraintStrategy[]) {}
  decide(task: TaskSpec, candidates: readonly Candidate[], policy: PolicySet, now: Instant):
    Result<RoutingDecision, NoEligibleCandidate | InvalidCandidateSet>;
  score(task: TaskSpec, candidates: readonly Candidate[], policy: PolicySet): readonly ScoredCandidate[];
}

// packages/core/src/intelligence/assignment/constraint.ts
export interface ConstraintContext { task: TaskSpec; policy: PolicySet; now: Instant; taskType: TaskType }
export interface ConstraintStrategy {
  readonly id: ConstraintId;                      // 'cross-vendor-review' | 'risk-gate' | 'sandbox' | 'allowlist' | 'lead-reserve' | 'concurrency' | 'deprecated'
  evaluate(c: Candidate, ctx: ConstraintContext): { allowed: true } | { allowed: false; reason: ReasonCode; detail?: string };
}
```
Reason vocabulary (closed union — the UI maps each to a label; adding one is a typed change):
`policy-primary` · `policy-fallback` · `policy-reviewer` · `best-capability-fit` · `cheaper-within-epsilon` · `profile-synthesized` · `manifest-unverified` · `user-override` ·
`excluded:missing-capability` · `excluded:provider-cooling` · `excluded:provider-exhausted` · `excluded:deprecated` · `excluded:same-vendor-as-author` · `excluded:not-allowlisted` · `excluded:denied-by-policy` · `excluded:lead-reserve` · `excluded:concurrency-limit` · `excluded:sandbox-unsupported` · `excluded:risk-gate` · `excluded:cost-cap`.

Scoring (implements `06-intelligence-layer.md §3`), `packages/core/src/intelligence/assignment/scoring.ts`:
```
capabilityFit(model, task) = Σ_w  task.weights[w] × dim(w)        // w ∈ taskType.weights keys, Σ weights = 1
  dim(reasoning)          = profile.dimensions.reasoning
  dim(speed)              = profile.dimensions.speed
  dim(cost)               = (6 − profile.costTier) / 5
  dim(context)            = 0.5×profile.dimensions.longContext
                          + 0.5×clamp01(profile.contextWindow / max(task.contextEstimateTokens, 1))
  dim(toolReliability)    = 0.6×profile.dimensions.toolUse + 0.4×profile.dimensions.instructionFollowing
  dim(platformExpertise)  = profile.dimensions.codeQuality[task.language ?? variants.platform]
                            ?? profile.dimensions.instructionFollowing          // documented fallback (M2-02 §4.1)
  penalties: −0.10 if profile.source === 'synthesized'; −0.05 if !manifestVerified
  bonuses:   +0.05 if taskTypeId ∈ profile.bestFor;  −0.15 if taskTypeId ∈ profile.avoidFor
  result clamped to [0,1]

quotaAvailability(candidate)  = healthy 1.0 · unknown 0.9 · cooling 0 · exhausted 0   (M4-02 replaces 1.0/0.9 with a forecast curve)
costEfficiency(candidate, set) = 1.0                          when fit < bestFit − ε
                               = 1 + (5 − costTier) × 0.02    when fit ≥ bestFit − ε   // cheap models win near-ties
constraints(candidate)         = 0 if any strategy rejects, else 1
score = clamp01(capabilityFit × quotaAvailability × costEfficiency × constraints)
```
The cost pass is a **second pass over the whole candidate set** (needs `bestFit`), which makes the function order-independent and set-dependent — documented in the module header and asserted by UT-M2-04-06.

### 4.3 Data / schema changes
Migration `m2_04_routing_decisions`: create/extend `routing_decisions` per `04-domain-model.md §4` (`id, task_id, chosen_provider, chosen_model, score, reasons_json, alternatives_json, dry_run, created_at`) plus `task_type TEXT NOT NULL`, `breakdown_json TEXT NOT NULL`, `excluded_json TEXT NOT NULL`, `policy_version TEXT`, `catalog_version TEXT`, `engine_version TEXT`, `inputs_hash TEXT NOT NULL`, `actor_json TEXT`. Unique index `(task_id, inputs_hash)` where `dry_run = 0` ⇒ re-deciding the same task with unchanged inputs returns the stored row instead of writing a second one (idempotency standard). Dry runs are retained 7 days (purged by the M5-06 retention job; until then a simple `deleteOlderThan` on boot).
New events (namespace `routing.*` from `04 §3`): `routing.decided {decisionId, taskId?, chosen, score, reasonCodes[], dryRun:false}`, `routing.dry_run {decisionId, chosen, score, reasonCodes[]}`. Zod schema per type registered in the event catalog.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/routing/candidate-builder.ts` assembles `Candidate[]` from `ManifestPort` (M2-03), `ModelCatalogPort` (M2-02), `SessionSupervisor` counts (M1-02) and `WindowStatePort`. In M2 the window state comes from the last `RateLimitSignal` observed by the adapters (M1-05..07): `cooling` until `resetAt`, else `healthy`; providers with no signal ever ⇒ `unknown`.
- `DefaultMatrixPolicyLoader` reads `packages/catalog/routing/default-matrix.yaml` through the same `FileSource` + watcher pattern as M2-01/02; invalid file ⇒ keep last-known-good + `catalog.invalid {kind:'routing'}`.
- No network, no process spawn, no tmux in this step. `packages/core` gains no dependency (dependency-cruiser keeps it at zero).

### 4.5 API / UI surface
- `POST /api/routing/preview` — body `{ taskTypeId, goal, variants?, language?, role?, contextEstimateTokens?, authorRef?, requiredSandbox?, excludeRefs? }` (Zod at the edge) → `200 RoutingDecisionDto` with `dryRun: true`, or `409 { code: 'NoEligibleCandidate', excluded: [...] }`. Accepts `Idempotency-Key`.
- `GET /api/routing/decisions/:id` → the stored decision incl. breakdown and exclusions.
- `GET /api/routing/candidates` → the current candidate set with health (debug aid used by the preview dialog's "why is X missing?" link).
- CLI: `orch routing preview --task-type <id> [--goal <text>] [--language ts] [--role reviewer --author claude/opus] [--json]` prints a table: chosen, score, reasons, top-3 alternatives, excluded with reasons. Exit 0 on a decision, 5 on `NoEligibleCandidate`.
- No new screen. The preview dialog (M2-06), Board preview (M2-07) and decision log (M2-09) consume these endpoints.

### 4.6 Flow / sequence
```
caller (UI / CLI / MCP delegate / M4-03 reroute)
  └─▶ PreviewAssignment | DecideAssignment (application)
        ├─ TaxonomyPort.get(taskTypeId)            → TaskType (weights, risk, reviewRequired, sandboxDefault)
        ├─ PolicyPort.resolve(taskTypeId)          → PolicySet (M2-04: default matrix; M2-09: + workspace)
        ├─ CandidateBuilder.build()                → Candidate[]  (manifests × profiles × health × concurrency)
        └─ AssignmentEngine.decide(task, cands, policy, clock.now())
              ├─ per candidate: constraints[] → exclusions       (all strategies evaluated, none short-circuits)
              ├─ pass 1 capabilityFit  ─▶ bestFit
              ├─ pass 2 costEfficiency ─▶ score ─▶ order (policyRank, score, costTier, contextWindow, ref)
              └─ Ok(RoutingDecision{chosen, breakdown, reasons, alternatives≤3, excluded[]})
                   ├─ dryRun  ─▶ persist(dry_run=1) ─▶ emit routing.dry_run ─▶ 200
                   └─ real    ─▶ upsert by (taskId, inputsHash) ─▶ emit routing.decided ─▶ task.assigned (M2-06)
```

## 5. Tasks
- [ ] Add `ModelRefPattern`, `ReasonCode`, `Reason`, `ScoreBreakdown`, `ScoredCandidate`, `RoutingDecision`, `PolicySet`, `Candidate` VOs to `packages/core/src/intelligence/assignment/`.
- [ ] Implement `scoring.ts` (per-weight mapping, penalties/bonuses, two-pass cost efficiency) with exhaustive unit tests including every `dim()` fallback branch.
- [ ] Implement the seven `ConstraintStrategy` classes, each in its own file, plus a `ConstraintRegistry` (DI map keyed by `ConstraintId`, order fixed by an exported array — no `switch`).
- [ ] Implement `AssignmentEngine.decide()` / `.score()` with the ordering rules and `NoEligibleCandidate` error carrying all exclusions.
- [ ] Author `packages/catalog/routing/default-matrix.yaml` (every row of `06 §4`, primary/fallback/reviewer as `ModelRef` lists) + `schemas/routing-policy.schema.ts` + loader; cross-check refs against the model catalog (unknown ref ⇒ validation warning).
- [ ] Write the golden suite: one case per matrix row (healthy fleet), one per row with the primary provider `cooling`, plus reviewer cases asserting the author's vendor is excluded.
- [ ] `CandidateBuilder` + `WindowStatePort` (coarse) + `ManifestPort`/`ModelCatalogPort` wiring in `apps/daemon/src/infrastructure/routing/`.
- [ ] `PreviewAssignment` and `DecideAssignment` use cases (one class each, constructor-injected ports, `Result` returns).
- [ ] Kysely migration `m2_04_routing_decisions` + `RoutingDecisionRepository` with the `(task_id, inputs_hash)` idempotent upsert and dry-run retention.
- [ ] Register `routing.decided` / `routing.dry_run` Zod event schemas; publish on the `routing` WS topic.
- [ ] `routing.controller.ts` (`preview`, `decisions/:id`, `candidates`) + OpenAPI + `Idempotency-Key` support.
- [ ] `orch routing preview` command with table and `--json` output.
- [ ] Coverage gate: add `packages/core/src/intelligence/assignment/**` to the 100 %-branch list in the Vitest config and CI thresholds.
- [ ] Docs: `packages/core/README.md` section "Assignment engine: scoring, constraints, reason codes" with the reason-code table.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-04-01 | unit | `decide()` on the golden fleet for every row of `06 §4` | chosen == matrix primary for all rows; reason `policy-primary` |
| UT-M2-04-02 | unit | same rows with the primary provider `window: cooling` | chosen == matrix fallback; reasons contain `policy-fallback` + excluded `excluded:provider-cooling` |
| UT-M2-04-03 | unit | `role: 'reviewer'` with `authorRef: claude/opus` | every `claude/*` candidate excluded `excluded:same-vendor-as-author` (G3); chosen is another vendor |
| UT-M2-04-04 | unit | task type requiring a capability no candidate has | `Err(NoEligibleCandidate)` listing all candidates with `excluded:missing-capability` |
| UT-M2-04-05 | unit | each constraint strategy in isolation (7 × allow/reject) | correct `ReasonCode`; rejecting strategies do not short-circuit the others |
| UT-M2-04-06 | unit | `score()` invariance: shuffle candidate order, rescore | identical scores and identical ordering (determinism + set-dependence of cost pass) |
| UT-M2-04-07 | unit | two candidates with fit within ε, different `costTier` | cheaper one wins; reason `cheaper-within-epsilon`; outside ε the better fit wins |
| UT-M2-04-08 | unit | `lead-reserve` with `minFreeSessions` reached / concurrency at `maxConcurrentSessions` | `excluded:lead-reserve` / `excluded:concurrency-limit` (C6) |
| UT-M2-04-09 | property | fast-check over random profiles/weights/health | never throws; score ∈ [0,1]; alternatives ≤ 3, disjoint from chosen, all eligible |
| AT-M2-04-01 | application | `PreviewAssignment` with in-memory ports | returns `dryRun: true`, persists one row, emits `routing.dry_run`, no session started |
| AT-M2-04-02 | application | `DecideAssignment` called twice with unchanged inputs | one `routing_decisions` row; second call returns the stored decision (idempotent) |
| CT-M2-04-01 | contract | default-matrix YAML vs model catalog + manifests | every ref resolves to a known model or produces a validation warning; schema valid |
| IT-M2-04-01 | integration | daemon + FakeProvider fleet; `POST /api/routing/preview` | 200 with breakdown and 3 alternatives; `GET /api/routing/decisions/:id` returns the same payload |
| IT-M2-04-02 | integration | simulate a 429 signal for one provider, preview again | that provider's models excluded `excluded:provider-cooling` until `resetAt` (C5) |
| E2E-M2-04-01 | e2e | `orch routing preview --task-type changelog --json` against a running daemon | exit 0; JSON parses; `chosen` matches the matrix row for `changelog` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-04-01 | Matrix holds on the real fleet | 1. claude + codex (+ agy) detected and logged in 2. `orch routing preview --task-type feature-impl --language typescript` | Chosen matches the `feature-impl` primary from `06 §4` for the models actually installed; reasons list `policy-primary`; 3 alternatives printed | ⬜ |
| TC-M2-04-02 | Cheap task routes off the top tier | 1. `orch routing preview --task-type changelog` 2. `orch routing preview --task-type architecture` | `changelog` chooses a cost-tier ≤ 2 model with reason `cheaper-within-epsilon` or `policy-primary`; `architecture` chooses a top-tier model (G2 evidence) | ⬜ |
| TC-M2-04-03 | Cross-vendor reviewer | 1. `orch routing preview --task-type code-review --role reviewer --author claude/opus` | No `claude/*` candidate is chosen; every `claude/*` row appears under excluded with `excluded:same-vendor-as-author` | ⬜ |
| TC-M2-04-04 | Negative: nothing eligible | 1. Stop/log out one provider and set the others' models `deny` in the default matrix copy under test 2. Repeat a preview | Exit code 5; message names every candidate with its exclusion reason; no decision row with `dry_run = 0`; daemon healthy | ⬜ |
| TC-M2-04-05 | Cooling after a real 429 | 1. Drive one provider into a rate limit (or inject the recorded 429 fixture via FakeProvider) 2. Preview the same task type | That provider's models are excluded with `excluded:provider-cooling` and the reset time in `detail`; after `resetAt` passes, a new preview includes them again | ⬜ |
| TC-M2-04-06 | Explainability completeness | 1. Preview any task type 2. `GET /api/routing/decisions/:id` | Response contains per-weight breakdown summing to `capabilityFit` (± 0.001), policy/catalog/engine versions, and every candidate either chosen, alternative, or excluded — none missing | ⬜ |
| TC-M2-04-07 | Restart / resilience | 1. Run a real (non-dry-run) decision for a task 2. `kill -9` daemon 3. Restart 4. Re-run the same decision | The stored decision is returned unchanged (same `id`, same `inputs_hash`); no duplicate row; `routing.decided` is not emitted twice | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `packages/core/src/intelligence/assignment/**` at 100 % branch coverage, enforced in CI thresholds.
- [ ] The golden suite reproduces every row of `06-intelligence-layer.md §4` (primary, fallback, reviewer) and each row's unhealthy-primary variant.
- [ ] `decide()` is deterministic: same inputs ⇒ byte-identical `RoutingDecision` minus `decidedAt` (UT-M2-04-06).
- [ ] Every candidate in the input set appears exactly once in `chosen ∪ alternatives ∪ excluded`; every exclusion carries a `ReasonCode`.
- [ ] No candidate is ever chosen while `window ∈ {cooling, exhausted}` or `activeSessions ≥ maxConcurrentSessions` (C5, C6).
- [ ] `packages/core` still imports nothing (dependency-cruiser); no `switch (provider)` anywhere in core/application; all constraints resolved through the DI registry.
- [ ] `POST /api/routing/preview` never starts a session, never writes a `dry_run = 0` row, and answers in < 50 ms p95 for a 20-candidate fleet.
- [ ] All TC-M2-04-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- The default matrix encodes opinion (`06 §4`) on top of profiles that were themselves tuned to satisfy it (M2-02). Until M8-06 supplies outcomes this is circular; the mitigation is that policy and score are reported separately in every decision, so a wrong matrix row is visible rather than hidden inside a score.
- Model ids used in `default-matrix.yaml` must match `manifest.models[].id` — *(verify against claude / codex / agy docs and the M2-03 manifests at step start)*. Unknown refs degrade to a validation warning, never a silent exclusion.
- `quotaAvailability` is binary-ish in M2 (`healthy/unknown/cooling/exhausted`). M4-02 replaces it with a forecast curve; the interface (`WindowStatePort`) is fixed now so M4-02 is a strategy swap, not a rewrite.
- ε (0.03) and the penalty/bonus constants are tunables in `PolicySet`; shipping them as data (not constants) avoids a release for a tuning change, but also makes two installations behave differently — the decision records `policyVersion` so a support question is answerable.
- Cross-vendor review may be impossible with a single healthy provider (R12). This step excludes; the documented degrade path (same vendor, different model, explicit flag + audit) is implemented in M3-04, not here — a `code-review` preview on a one-provider fleet is expected to return `NoEligibleCandidate`.
- `contextEstimateTokens` is caller-supplied and usually absent in M2 (Quick Delegate does not measure the repo). With it absent, `dim(context)` uses `longContext` alone; a real estimator arrives with mission planning (M3-02).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
