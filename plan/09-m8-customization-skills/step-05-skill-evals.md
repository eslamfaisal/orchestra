# Step M8-05 — Skill evals

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M8-04 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `packages/sdk`, `packages/catalog`, `apps/daemon`, `apps/cli`, `apps/web`, `packages/ui` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step a skill can prove itself. Each skill declares `evals[]` — fixture tasks with a goal, a fixture repo snapshot and assertions — and `orch skill eval <skill> [--providers claude,codex]` runs them through the existing Quick Delegate execution path (M2-06 → M1-12) in disposable scratch worktrees, one run per `(eval, provider)`. Each run is scored on **quality** (fixture tests pass, assertions hold, blocker/major findings from a cross-vendor review round — M3-04), **cost** and **latency**, written to the `outcomes` table with `skill_id` and `eval_run_id` set, and rolled up into a per-provider health badge on the Skills screen. Nothing starts without a quota preview and an explicit confirmation; CI runs the same evals with `FakeProvider` only.

## 2. Why
- **D7 / G7** — "which skill works with which model" is exactly the kind of fact that must be measured locally and updated without a release. A skill without evidence is a folklore artifact.
- **G2** — milestone exit criterion 2: eval outcomes are real `outcomes` rows, so the next routing decision for that task type can cite *local evidence* (M8-06 consumes them; M4-04's `CostEstimator` already reads the same table).
- **G3** — quality is scored by a **different vendor's** reviewer, reusing M3-04's rule rather than asking the author model to grade itself.
- **C5** — evals are the easiest way to burn a window. Cooling is respected, a max cost tier is enforced, runs are serialised per provider, and a cooling provider is skipped with a reason rather than retried.
- **C9** — CI never touches a real account: the eval runner is provider-agnostic and the CI job pins `--providers fake`.
- **C10** — a multi-provider eval is a multi-task spend action. It gets the same preview-and-confirm treatment as Quick Delegate, with an estimated token and wall-clock cost per run before anything launches.

## 3. Scope
### In scope
- `SkillEvalSpec` schema (already parsed in M8-04) made executable: `id`, `taskType`, `goal`, `fixture` (a directory inside the skill), `inputs`, `assert` block, `timeoutMs`, `maxCostTier`.
- Fixture repos: a skill ships `fixtures/<name>/` as a plain directory; the runner materialises it into a throwaway git repo under `~/.orchestra/evals/<runId>/<evalId>-<provider>/` and initialises a single commit — never a user repo, never the scratch repo's working tree.
- `EvalScorer` (pure): assertions + review findings + tests → `EvalScore {quality, cost, latency, verdict}`.
- `RunSkillEval` use case: plan → preview → confirm → per-`(eval, provider)` execution through the Quick Delegate path → review round (M3-04) → score → `outcomes` rows → aggregate.
- `outcomes` extension (`skill_id`, `eval_run_id`, `provider_id`, `source`, `created_at`) and a new `skill_eval_runs` table.
- `orch skill eval <id> [--providers a,b] [--evals x,y] [--dry-run] [--yes] [--json]`, exit codes by verdict.
- Skills screen: eval list on the skill detail, Run evals action with the preview dialog, results table, per-provider health badge (`green | amber | red | unknown`) with sample size and staleness.
- CI job `skill-evals` running every shipped pack against `FakeProvider` scenarios on every catalog change.
### Out of scope (deferred to …)
- Turning eval outcomes into model-profile weight adjustments and scorecards → deferred to M8-06 (this step only writes `outcomes`).
- Comparing skill-on vs skill-off (an A/B that would double the cost) → deferred to M10; the `source` column leaves room for it.
- Publishing eval results to a community registry → deferred to M10-02/M10-03; the anonymised export bundle is M8-06's.
- Scheduling evals (nightly, on catalog update) → deferred to M9-07 automations; M8 runs them on demand and in CI only.
- Evals for playbooks → M8-07 ships a FakeProvider test-run instead, which is a different (cheaper) thing.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`EvalScorer` and the verdict rules are pure (`packages/core/src/skills/eval/`). Execution, git and sessions stay in the daemon.

Rules:
- One run unit = `(evalId, provider, model)`. Model is chosen by the assignment engine for the eval's `taskType` **unless** `--model` pins it; the chosen ref is recorded so a comparison is honest.
- Assertions are declarative and checked against the worktree after the task result is collected (M3-03): `testsPass` (runs the fixture's `test` command from the workspace `test` settings, M1-12/M3-07), `mustContain[]` (paths that must exist), `mustNotContain[]`, `maxBlockerFindings`, `maxMajorFindings`, `maxDiffLines`.
- Quality score (deterministic, documented, in one function):
  `quality = 0.5 × testsPassed + 0.3 × assertionsPassedRatio + 0.2 × clamp01(1 − (blockers×1.0 + majors×0.3) / 5)`.
  A failed `testsPass` when the eval declares `testsPass: true` caps `quality` at 0.5 regardless of the rest.
- Verdict: `pass` (quality ≥ 0.8, no blocker), `weak` (0.5 ≤ quality < 0.8), `fail` (< 0.5 or a `mustNotContain` hit), `error` (timeout, launch failure, adapter error), `skipped` (provider cooling/exhausted/not installed/skill not attachable).
- `skipped` is **never** scored and never written to `outcomes` — a skipped provider must not look like a bad provider.
- Health badge per `(skill, provider)`: `green` = last run `pass` and ≥ 2 samples; `amber` = `weak`, or a single sample, or older than `skills.evals.staleAfterDays` (default 30); `red` = last run `fail`; `unknown` = never run. Badges always show sample size and date — truth labelling (UX principle 4).
- Cost tier gate: a candidate model whose `costTier > eval.maxCostTier ?? settings.skills.evals.maxCostTier` (default 3) is excluded from the eval with a reason; evals must not be the thing that drains the Opus window.
- Determinism boundary: the *runner* is deterministic (ordering, fixture materialisation, scoring); the *agent* is not. Scores are per-run evidence, never asserted as exact values in tests — automated tests assert scoring arithmetic on synthetic inputs and assert runner behaviour with `FakeProvider`.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/skill.ts — the eval block, validated in M8-04, executed here
export interface SkillEvalSpec {
  id: string; taskType: TaskTypeId; goal: string;
  fixture: string;                                  // path inside the skill dir, e.g. 'fixtures/todo-repo'
  inputs?: Readonly<Record<string, string>>;        // fills the skill's declared inputs
  platform?: string; language?: string;
  timeoutMs?: number;                               // default 900_000
  maxCostTier?: 1 | 2 | 3 | 4 | 5;                  // default from settings.skills.evals.maxCostTier
  assert: {
    testsPass?: boolean;
    mustContain?: readonly string[];
    mustNotContain?: readonly string[];
    maxBlockerFindings?: number;                    // default 0
    maxMajorFindings?: number;
    maxDiffLines?: number;
  };
}

// packages/core/src/skills/eval/types.ts
export type EvalVerdict = 'pass' | 'weak' | 'fail' | 'error' | 'skipped';
export interface EvalObservation {
  testsRequired: boolean; testsPassed: boolean | null;
  assertionsTotal: number; assertionsPassed: number;
  failedAssertions: readonly { kind: string; detail: string }[];
  blockerFindings: number; majorFindings: number; minorFindings: number;
  diffLines: number; latencyMs: number; costTokens: number | null; costTier: number;
  terminal: null | { kind: 'timeout' | 'launch-failed' | 'adapter-error'; message: string };
}
export interface EvalScore { quality: number; latencyMs: number; costTokens: number | null; verdict: EvalVerdict; reasons: readonly string[] }
export class EvalScorer { score(spec: SkillEvalSpec, o: EvalObservation): EvalScore }   // pure, total

// apps/daemon/src/application/skills/run-skill-eval.use-case.ts
export interface EvalPlanItem { evalId: string; provider: ProviderId; model: ModelRef;
  estTokens: number; estWallClockMs: number; estSource: 'outcomes' | 'taxonomy-default';
  skip?: { reason: 'provider-cooling' | 'provider-exhausted' | 'not-installed' | 'skill-not-attachable' | 'cost-tier' } }
export class PlanSkillEval {                          // dry-run; spends nothing (C10)
  execute(cmd: { skillId: string; providers?: readonly ProviderId[]; evalIds?: readonly string[] }):
    Promise<Result<{ items: readonly EvalPlanItem[]; windowImpact: WindowImpact[] }, SkillEvalError>>;
}
export class RunSkillEval {
  execute(cmd: { skillId: string; providers?: readonly ProviderId[]; evalIds?: readonly string[];
                 confirmedPlanHash: string; actor: Actor; idempotencyKey: string }):
    Promise<Result<{ runId: string }, SkillEvalError>>;   // returns immediately; progress over WS
}
export type SkillEvalError =
  | { code: 'E_NO_EVALS'; skillId: string }
  | { code: 'E_SKILL_UNTRUSTED'; skillId: string; trust: TrustLevel }
  | { code: 'E_FIXTURE_MISSING'; evalId: string; path: string }
  | { code: 'E_PLAN_STALE'; expected: string; actual: string }
  | { code: 'E_ALL_SKIPPED'; reasons: readonly string[] };
```

### 4.3 Data / schema changes
- Migration `m8_05_outcomes_ext` on `outcomes` (`04-domain-model.md §4`: `id, model_id, task_type, task_id, review_findings, tests_pass_rate, rework_rounds, latency_ms, cost_est`) adds: `provider_id TEXT NOT NULL`, `skill_id TEXT NULL`, `skill_version TEXT NULL`, `eval_run_id TEXT NULL`, `source TEXT NOT NULL DEFAULT 'mission'` (`'mission' | 'quick' | 'eval'`), `quality REAL NULL`, `created_at TEXT NOT NULL`. Indexes `(model_id, task_type, created_at)` and `(skill_id, provider_id, created_at)`.
- New table `skill_eval_runs`: `id, skill_id, skill_version, started_at, ended_at, actor_json, plan_json, settings_version, status ('running'|'done'|'cancelled'|'failed'), summary_json`.
- New table `skill_eval_results`: `id, run_id, eval_id, provider_id, model_id, task_id NULL, verdict, quality, latency_ms, cost_tokens, observation_json, worktree_path, log_ref, created_at`.
- New events: `skill.eval_started {runId, skillId, items}`, `skill.eval_item_finished {runId, evalId, provider, verdict, quality}`, `skill.eval_finished {runId, summary}`, `skill.eval_cancelled {runId}`. `audit_log` row for the run start (it spends).
- No change to `tasks`; eval tasks are ordinary tasks with `origin: 'cli'|'ui'` and a `context_json.evalRunId` marker so they are filterable out of the Board by default.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `EvalWorkspaceBuilder` (`apps/daemon/src/infrastructure/skills/eval/`): copies `fixture/` into `~/.orchestra/evals/<runId>/<evalId>-<provider>/`, `git init`, `git add -A`, one commit (`eval fixture <skill>@<version>`), then hands the path to `WorktreeManager` (M1-03) so the rest of the pipeline is byte-identical to a normal task. Fixture copy applies the same file allowlist as M8-04 (no symlinks, no executables outside a declared `test` command).
- Isolation: each run directory gets `$ORCH_PORT` / `$ORCH_DB_SUFFIX` from M3-07's allocator so parallel evals cannot collide on ports or databases.
- Concurrency: **one in-flight eval task per provider** (a semaphore keyed by provider, below `manifest.limits.maxConcurrentSessions` — C6). Across providers they run in parallel. Cancelling the run stops sessions through `SessionSupervisor` and marks remaining items `skipped`.
- Cooling: before each item, the `WindowStatePort` is re-read; a provider that entered cooling mid-run has its remaining items marked `skipped` with the reason, never retried (C5).
- Cleanup: run directories are deleted on success, kept on `fail`/`error` for inspection (path shown in the UI), and purged by TTL (`skills.evals.keepFailedDays`, default 7) by the existing retention job.
- Review round reuses M3-04 unchanged: the eval task enters `review_pending` and a cross-vendor reviewer is assigned by the existing rule; findings land in `review_findings` and are read back by the scorer.
- CI: `.github/workflows/ci.yml` gains a `skill-evals` job running `orch skill eval --all --providers fake` against `FakeProvider` scenarios (`packages/sdk/fixtures/scenarios/`), asserting runner behaviour and non-flaky verdicts. No vendor credentials exist in CI (C9).
- No network.

### 4.5 API / UI surface
- `POST /api/skills/:id/evals/plan` — body `{ providers?, evalIds? }` → `{ planHash, items[], windowImpact[] }` (spends nothing).
- `POST /api/skills/:id/evals/run` — body `{ planHash, providers?, evalIds? }`, `Idempotency-Key` → `202 { runId }`; `409 E_PLAN_STALE` if the fleet changed since the plan.
- `GET /api/skills/:id/evals/runs?limit=` and `GET /api/evals/runs/:runId` → run with per-item results.
- `POST /api/evals/runs/:runId/cancel`.
- `GET /api/skills/:id/health` → per-provider badge, sample size, last run date, staleness.
- WS topic `evals`: `skill.eval_*` events for live progress.
- CLI: `orch skill eval <id> [--providers claude,codex] [--evals todo-feature] [--dry-run] [--yes] [--json]`. `--dry-run` prints the plan table (eval · provider · model · est tokens · est time · skip reason) and exits 0. Without `--yes` it prints the plan and asks for confirmation. Exit codes: `0` all `pass`, `4` any `weak`, `5` any `fail`, `6` any `error`, `7` all `skipped`.
- UI (extends the M8-04 Skills screen):
  - `SkillEvalsTab` on the skill detail — declared evals with fixture size and assertions, per-provider health badges (icon + word + `n=<samples>` + date).
  - `EvalRunDialog` — provider multiselect (uninstalled/cooling providers shown disabled with the reason), eval multiselect, then the **plan preview**: rows with estimated tokens/time and their source chip (`outcomes(n)` / `taxonomy-default`, per M4-04 R-B4), window impact per provider, total. Confirm is the only thing that spends.
  - `EvalRunProgress` — live per-item state (queued · running · reviewing · scored · skipped), links to the live terminal (M1-09) and to the task drawer.
  - `EvalResultsTable` — eval × provider matrix: verdict, quality, tests, findings (blocker/major), diff lines, latency, cost; row click opens the observation detail with failed assertions listed verbatim and a link to the kept worktree for failures.
  - States: `no-evals` (skill declares none — with a pointer to the docs), `untrusted` (Run disabled with the reason), `planning`, `awaiting-confirm`, `running`, `partially-skipped`, `done`, `cancelled`, `failed`.
- Accessibility: verdicts and badges are icon + word; the matrix is a real table with row/column headers; long-running progress announces via `aria-live="polite"`.

### 4.6 Flow / sequence
```
orch skill eval clean-arch-flutter-feature --providers claude,codex
  └─▶ PlanSkillEval
        ├─ skill trust ≥ floor?           (untrusted ⇒ E_SKILL_UNTRUSTED, nothing runs)
        ├─ per (eval, provider): AssignmentEngine.decide(taskType) with costTier ≤ maxCostTier
        ├─ CostEstimator (M4-04, outcomes ≥ 3 else taxonomy default) ─▶ est tokens/time per item
        └─ windowImpact (M4-06 estimator) ─▶ plan table + planHash        [nothing spent]
  └─▶ confirm (UI dialog / --yes) ─▶ RunSkillEval(planHash)
        └─ per provider (serialised) → per eval:
             EvalWorkspaceBuilder: copy fixture ─▶ git init+commit ─▶ WorktreeManager.create
             ResolveSkills + InstallSkills (M8-04) ─▶ skill present natively in the worktree
             Quick Delegate path (M2-06 → M1-12): session ─▶ TaskResult (M3-03: branch, diffstat, tests, summary)
             ReviewRule (M3-04): cross-vendor reviewer ─▶ review_findings
             assertions checked against the worktree ─▶ EvalObservation
             EvalScorer.score ─▶ EvalScore ─▶ skill_eval_results row
             ─▶ outcomes row {model_id, provider_id, task_type, skill_id, eval_run_id, source:'eval',
                              review_findings, tests_pass_rate, rework_rounds, latency_ms, cost_est, quality}
             ─▶ skill.eval_item_finished ─▶ WS 'evals'
        └─ aggregate ─▶ skill_eval_runs.summary_json ─▶ skill.eval_finished ─▶ health badges update

cooling detected mid-run ─▶ remaining items for that provider ─▶ verdict 'skipped' (no outcomes rows, no retry)
```

### 4.7 Review reconciliation contract (2026-09-15)
Resolve evaluation fixtures through the separate trusted EvaluationEnvironment contract in M8-04. Require explicit trust, pinned revision/hash, scratch worktree, scoped credentials and execution/network limits before setup or tests. Skill install alone does not authorize arbitrary eval commands. Keep eval source separate from observational task outcomes and report sample size and variance.

## 5. Tasks
- [ ] Make `SkillEvalSpec` executable: fixture path resolution, `inputs` binding to the skill's declared inputs, defaults for `timeoutMs` / `maxCostTier`; validation errors surfaced in M8-04's skill detail.
- [ ] `EvalScorer` (pure) — quality formula, verdict thresholds, `skipped` short-circuit, reason strings; 100 % branch coverage.
- [ ] `AssertionChecker` — `testsPass` (via the workspace `test` command), `mustContain` / `mustNotContain`, finding caps, `maxDiffLines`; returns failed assertions with detail.
- [ ] `EvalWorkspaceBuilder` — fixture copy with the M8-04 file allowlist, `git init` + single commit, `$ORCH_PORT` / `$ORCH_DB_SUFFIX` injection (M3-07), cleanup and keep-on-failure policy.
- [ ] `PlanSkillEval` — per-item model choice via the assignment engine, cost-tier gate, `CostEstimator` (M4-04) reuse, window impact, `planHash`.
- [ ] `RunSkillEval` — per-provider semaphore, cooling re-check per item, cancellation, idempotency key, audit row.
- [ ] Wire the existing Quick Delegate execution path and the M3-04 review round; assert no new execution code path is introduced.
- [ ] Migrations `m8_05_outcomes_ext`, `m8_05_skill_eval_runs`, `m8_05_skill_eval_results` + repositories.
- [ ] `WriteOutcome` writer for eval results (shared shape with M8-06's `RecordOutcome`; if M8-06 lands first, use its use case).
- [ ] Event schemas `skill.eval_*`; WS topic `evals`; Board filter excluding `evalRunId` tasks by default.
- [ ] Controllers: plan, run, get run, cancel, health + OpenAPI + `Idempotency-Key`.
- [ ] CLI `orch skill eval` with plan table, confirmation, `--dry-run`, `--json`, documented exit codes.
- [ ] UI: `SkillEvalsTab`, `EvalRunDialog` (with the plan preview), `EvalRunProgress`, `EvalResultsTable`, health badges with sample size and date.
- [ ] Eval fixtures for the seven starter packs (small, ≤ 200 files each) + `FakeProvider` scenarios that produce a `pass`, a `weak` and a `fail`.
- [ ] CI job `skill-evals` (`--providers fake`), wired into the M0-08 gates; docs section "Writing skill evals".

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-05-01 | unit | scorer with tests passing, all assertions passing, zero findings | `quality = 1.0`, verdict `pass`; arithmetic asserted exactly on synthetic input |
| UT-M8-05-02 | unit | `testsPass: true` declared but tests failed, everything else perfect | quality capped at 0.5, verdict `weak` at most, reason names the test failure |
| UT-M8-05-03 | unit | one blocker finding / a `mustNotContain` hit / a timeout | verdict `fail` / `fail` / `error`; `error` and `skipped` produce no outcome row |
| UT-M8-05-04 | unit | health badge from 0, 1, 2 and stale (> 30 d) samples | `unknown` / `amber` / `green` / `amber` with the staleness reason; sample size always reported |
| UT-M8-05-05 | unit | cost-tier gate with `maxCostTier: 3` and only tier-4 candidates | item planned as `skip: cost-tier`; run proceeds with the remaining providers |
| AT-M8-05-01 | application | `RunSkillEval` on an untrusted skill | `E_SKILL_UNTRUSTED`; no worktree created, no session started, no audit spend row |
| AT-M8-05-02 | application | `RunSkillEval` with a stale `planHash` after a provider went cooling | `E_PLAN_STALE`; nothing runs; re-planning shows the provider as `skip: provider-cooling` |
| AT-M8-05-03 | application | replay `RunSkillEval` with the same `Idempotency-Key` | one run id, one set of results, no duplicate outcomes |
| IT-M8-05-01 | integration | full eval with `FakeProvider` (`pass` scenario) | fixture repo materialised and committed; skill installed into the worktree; task + review + outcome rows written with `source='eval'` and `skill_id` set |
| IT-M8-05-02 | integration | provider enters cooling mid-run | remaining items `skipped` with the reason; no retry; `outcomes` unaffected; run still completes with a partial summary |
| IT-M8-05-03 | integration | cancel a running eval | sessions stopped, remaining items `skipped`, worktrees cleaned, `skill.eval_cancelled` emitted |
| IT-M8-05-04 | integration | two providers in parallel | at most one in-flight task per provider; port/db suffixes distinct (M3-07); no cross-run file collisions |
| E2E-M8-05-01 | e2e | Run evals dialog | uninstalled/cooling providers shown disabled with reasons; plan preview lists estimates with source chips; Confirm is the only spend; progress updates live |
| E2E-M8-05-02 | e2e | results matrix and health badges | verdicts render as icon + word; failure rows link to the kept worktree path; badges show `n=` and date; axe-clean dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-05-01 | Dry-run plan | 1. `orch skill eval clean-arch-flutter-feature --providers claude,codex --dry-run` | Table of `(eval, provider, model, est tokens, est time, source chip)` plus window impact; exit 0; no worktree, no session, no `outcomes` row created | ⬜ |
| TC-M8-05-02 | Real two-provider eval (exit criterion 2) | 1. Same command without `--dry-run` 2. Confirm at the prompt 3. Wait for completion 4. `sqlite3` count `outcomes` rows with `skill_id` set | Two scratch worktrees run; results table shows verdict, quality, tests, findings, latency, cost per provider; ≥ 2 × (number of evals) `outcomes` rows with `skill_id` and `eval_run_id`; health badges update | ⬜ |
| TC-M8-05-03 | Cross-vendor review applied | 1. Open one eval result 2. Follow the link to the review | The reviewer's provider differs from the implementer's (G3); findings counted in the score are the ones listed; the review round is a normal M3-04 round | ⬜ |
| TC-M8-05-04 | Routing cites local evidence | 1. After TC-M8-05-02, preview a `feature-impl` task on the Flutter scratch repo 2. Open "why this model" | The reasons include a local-evidence entry sourced from the eval outcomes (via M8-06 when present, otherwise the `CostEstimator` source chip reads `outcomes(n)`) | ⬜ |
| TC-M8-05-05 | Negative: untrusted skill | 1. `orch skill trust <id> --level untrusted` 2. `orch skill eval <id>` | Exits non-zero with `E_SKILL_UNTRUSTED`; the UI Run button is disabled with the reason; no fixture directory is created | ⬜ |
| TC-M8-05-06 | Negative: broken eval spec | 1. Point an eval's `fixture` at a non-existent directory and break one assertion key 2. Reload the library 3. Try to run | Skill detail shows `E_FIXTURE_MISSING` and the schema error with the field name; Run is disabled for that eval; other evals of the same skill remain runnable | ⬜ |
| TC-M8-05-07 | Negative: quota guard | 1. Force a provider into cooling (replay a 429 fixture) 2. Plan and run an eval including it | The plan marks it `skip: provider-cooling`; the run never launches a session for it; no retry storm; the summary reports it as skipped, not failed (C5) | ⬜ |
| TC-M8-05-08 | Cancel / resilience | 1. Start a two-provider eval 2. Cancel from the UI mid-run 3. `kill -9` the daemon during a second run, then restart | Cancel stops sessions and cleans worktrees within a few seconds; after the restart the interrupted run is marked `failed` with its partial results intact, no orphan tmux panes, no phantom `skill_installs` rows | ⬜ |
| TC-M8-05-09 | CI parity | 1. Run the `skill-evals` CI job locally with `--providers fake` | All shipped packs produce deterministic verdicts; job is green; no vendor binary is launched and no credential is read (C9) | ⬜ |

### 6.3 Review regression scenarios
- [ ] Untrusted eval environment cannot execute.
- [ ] Pinned environment runs in scratch checkout and leaves user repo unchanged.
- [ ] Eval and production outcomes remain separately attributable.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] `orch skill eval` plans, previews estimated cost per item, and spends nothing before an explicit confirmation (C10, TC-M8-05-01).
- [ ] A real multi-provider run writes ≥ 2 × (number of evals) `outcomes` rows with `skill_id`, `eval_run_id`, `provider_id` and `source='eval'` (milestone exit criterion 2, TC-M8-05-02).
- [ ] Quality is scored with a cross-vendor review round, not by the author model (TC-M8-05-03).
- [ ] Cooling, exhaustion, concurrency and the cost-tier cap are respected; skipped items are reported as skipped and never scored or retried (IT-M8-05-02, TC-M8-05-07).
- [ ] Untrusted skills and broken eval specs cannot start a run (AT-M8-05-01, TC-M8-05-05/06).
- [ ] Fixtures run in disposable directories under `~/.orchestra/evals/`, never in a user repo; failures keep their worktree and the path is shown; successes are cleaned up.
- [ ] Per-provider health badges show verdict, sample size and date, with an explicit `unknown` for never-run (UT-M8-05-04).
- [ ] Cancellation and daemon restart leave no orphan sessions, worktrees or install rows (TC-M8-05-08).
- [ ] The CI `skill-evals` job is green using `FakeProvider` only (C9, TC-M8-05-09).
- [ ] All TC-M8-05-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Agent non-determinism vs a numeric score.** The same skill and model can score 1.0 and 0.6 on consecutive runs. Mitigation: badges require ≥ 2 samples for `green`, always display `n=`, and M8-06 enforces `minSamples` before any weight moves. Never present a single eval as proof.
- **Evals burn real quota** — the loudest risk in the milestone README. Controls: plan preview with estimates, `maxCostTier` default 3, per-provider serialisation, cooling re-check per item, CI on `FakeProvider` only. Watch TC-M8-05-02 for actual token spend and tune the default cost tier down if a single run is expensive.
- **Fixture repos inside skill artifacts grow the library.** A 1 MiB skill cap (M8-04) includes fixtures; a realistic Flutter fixture may not fit. Open question to resolve at implementation: either raise the cap for `fixtures/` specifically or allow a fixture to be a `git` bundle file. Decide before authoring the seven packs' fixtures, and record it in the step log.
- **Assertion expressiveness.** `mustContain` on paths is crude; a skill whose value is code *quality* is scored mostly through review findings, which vary by reviewer model. Mitigation: the observation detail lists findings verbatim so a human can judge; do not add a scripting hook for assertions (it would make a skill executable, which M8-04 explicitly forbids).
- **Review rounds double the cost** of every eval. That is the price of G3-consistent scoring. If it proves prohibitive, an `assert.skipReview: true` escape hatch is the first thing to consider — with the consequence that `quality` then omits its findings term, which the UI must say.
- **Outcome pollution.** Eval outcomes and mission outcomes now share a table; a model that only ever ran evals could dominate the evidence. Mitigation: `source` is recorded and M8-06 must weight or segment by it — flagged here so M8-06 designs it deliberately.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
