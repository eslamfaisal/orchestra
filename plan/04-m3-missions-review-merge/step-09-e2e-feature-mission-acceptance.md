# Step M3-09 — E2E feature mission acceptance

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-01, M3-02, M3-03, M3-04, M3-05, M3-06, M3-07, M3-08 (all M3) |
| Estimated effort | 2.5 days |
| Packages touched | `plan/04-m3-missions-review-merge/evidence/`, `apps/daemon` (fixes only), `apps/web` (fixes only), `packages/catalog` (playbook tuning), `.github/workflows` (E2E job), `docs/` |
| Risk | High |
| Owner | |

## 1. Goal
This is the **gate**, not a feature: one real feature is delivered on a **real repository** (not the scratch repo) by a mission that plans, splits, implements across **≥ 2 different vendors**, runs in parallel worktrees with isolated ports, gets cross-vendor reviewed through at least one `changes_requested` round, merges into the integration branch, and opens a **real pull request** — with every step evidenced in `plan/04-m3-missions-review-merge/evidence/`. Any defect found is fixed here (or explicitly deferred with a new step id), the milestone exit criteria are ticked in the milestone README, and the repository is tagged `mvp+` once everything is green.

## 2. Why
- D11 says nothing after M1 rewrites M0/M1 interfaces; M3 is the first milestone that *stacks* mission, review and merge on top of the substrate — the only way to know it holds is to run the real thing on a real repo (the M1-13 precedent).
- G3 ("cross-vendor review on 100 % of mission tasks") and the 1.0 DoD line "worktrees + Review & Merge end-to-end on ≥ 2 providers · cross-vendor review enforced (e2e)" are both claimed by M3; this step is where the claim is evidenced rather than asserted.
- `10-testing-strategy.md` reserves real-CLI runs for manual protocol and screenshots for `plan/<milestone>/evidence/`; this step is the milestone's instance of that protocol and the first time the plan permits leaving `~/orchestra-scratch/`.
- R10 (scope creep) and R16 (bandwidth): a hard, evidenced gate before M4/M8 start is the mechanism that keeps the roadmap honest.
- C9: none of this runs in CI. CI keeps running the `FakeProvider` mission E2E added here; the real-CLI run is manual, by you, on your machine.

## 3. Scope
### In scope
- Choosing a real target repository and a real feature of the right size (≈ 3–6 tasks, 2 implementation tasks that can run in parallel).
- Executing the full mission end to end on real CLIs (Claude Code + Codex, plus Antigravity if opted in) and recording evidence.
- A `FakeProvider` **mission E2E** added to CI that exercises the same path deterministically (plan → 2 parallel tasks → cross-vendor review round → merge → stubbed PR).
- Defect triage: fix-now vs defer-with-id; all fixes are small PRs referencing `M3-09`.
- Budget/perf spot-checks under a real two-agent load (web budgets from `12-ux-principles.md`, pane memory, daemon memory).
- Restart-resilience run in the middle of a real mission.
- Milestone close-out: README exit criteria ticked, `PROGRESS.md` rows, `RISKS.md` review, `DECISIONS.md` entries for anything decided during the run, `mvp+` tag.
### Out of scope (deferred to …)
- Quota exhaustion / reroute behaviour under a real 429 — deferred to M4 (M4-03 acceptance); if a 429 happens during this run, record it as evidence and treat a bad outcome as an M4 input, not an M3 blocker.
- Replay of the mission from recordings — deferred to M5-04.
- Lead handoff on exhaustion — deferred to M4-05.
- Any new feature work. If something is missing, it becomes a new step id in `ROADMAP.md`, not a silent addition here.
- Performance tuning beyond meeting the already-agreed budgets.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain code. The step defines two acceptance artifacts:
- **Target selection rule** — the real repo must: be one you own and can push to; have a working `.orchestra/workspace.yaml` with a `test` command that passes on `main` before the run; have a forge remote with `gh`/`glab` authenticated; contain at least two independently modifiable areas (so two implementation tasks are genuinely parallel); and have no secrets in the worktree path.
- **Evidence manifest** (`evidence/MANIFEST.md`) — a table of artifact → file → what it proves, so the milestone can be audited later without re-running anything.

### 4.2 Interfaces / contracts
```ts
// tests/e2e/mission.fixture.ts — the CI-safe twin of the real run (FakeProvider only)
export interface MissionE2EFixture {
  playbookId: 'new-feature-fullstack' | 'bugfix';
  providers: [{ id: 'fake-a'; vendorLabel: 'vendor-a' }, { id: 'fake-b'; vendorLabel: 'vendor-b' }];
  scenarios: {
    lead: 'lead-plan-and-delegate';            // M3-02
    implA: 'task-happy'; implB: 'task-happy';  // M3-03, parallel, each binds $ORCH_PORT (M3-07)
    reviewRound1: 'review-changes-requested';  // M3-04 — forces a second round
    reviewRound2: 'review-approve';
  };
  expect: {
    reviewerVendorDiffersFromAuthor: true;     // G3
    rounds: 2; merges: 2; prCreated: 'stubbed-gh';
    distinctPorts: true; distinctDbSuffixes: true;
  };
}
```
```
plan/04-m3-missions-review-merge/evidence/
  MANIFEST.md                  artifact → proof table
  00-preconditions.md          CLI versions, daemon build hash, repo + commit, config snapshot
  01-plan-card.png             Attention plan card with parsed tasks
  02-missions-dag.png          DAG mid-run: 2 running nodes, different providers
  03-terminals-parallel.png    two panes, different ports in the headers
  04-review-findings.png       cross-vendor findings anchored in the diff
  05-changes-requested.png     follow-up message delivered to the author pane
  06-merge-panel.png           merge allowed, blockers empty
  07-pr.png                    the real PR page with the generated body
  08-missions-cost.png         cost roll-up with confidence labels
  09-restart.md                what was running, kill -9 output, post-restart state
  mission-export.json          `orch mission export <id>` (mission, tasks, results, reviews, decisions)
  db-queries.md                the SQL used for the acceptance assertions + their output
  budgets.md                   measured web/pane/daemon numbers vs targets
  defects.md                   every defect found: id, severity, fixed-now | deferred-to-<step>
```

### 4.3 Data / schema changes
- None. Add `orch mission export <id> --json` if it does not already exist (small CLI addition, `apps/cli`) — it is the machine-readable evidence and is worth having for support anyway.
- Acceptance assertions are SQL over the existing schema, recorded in `evidence/db-queries.md`:
  - cross-vendor: `select count(*) from reviews r join tasks t on t.id=r.task_id where r.reviewer_provider = t.assigned_provider` ⇒ **0** (unless a degraded row exists, which must be 0 for this run).
  - review coverage: every task with `reviewRequired` has ≥ 1 `reviews` row before `merged_at` is set.
  - isolation: `select count(distinct port) from port_leases where task_id in (…)` equals the number of parallel tasks.
  - provenance: `missions.pr_url` not null; `tasks.merge_sha` not null for every in-scope task.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Real repo, real branches, real push, real PR. The PR is opened against a throwaway branch (never `main` directly) so the run is reversible: everything can be undone by deleting the PR branch and the integration branch.
- Pre-flight: `orch doctor`-style manual checklist (the real Doctor is M6-01) — provider versions recorded, `gh auth status` green, `tmux -V`, node version, disk space for worktrees + recordings.
- Load/perf measurement during the run: daemon RSS, per-pane memory from the Terminals budget instrumentation (M1-09), web cold start, first WS frame.
- CI: a new `mission-e2e` Playwright job using `FakeProvider` with two distinct fake provider ids so the cross-vendor constraint is exercised without a vendor account (C9).

### 4.5 API / UI surface
- No new API or UI. One CLI addition (`orch mission export`) and the milestone README's exit-criteria checkboxes.
- The Missions screen, Review screen and Terminals grid are the instruments used to gather evidence; anything unreadable during the run is a defect against M3-05/M3-08.

### 4.6 Flow / sequence
```
1 preconditions  ─ record versions, build hash, repo commit, config ─▶ evidence/00
2 orch playbook list ; pick new-feature-fullstack ; write the feature intent
3 New mission ─▶ Lead plans ─▶ plan card ─▶ (edit if needed) approve      ─▶ evidence/01
4 scheduler starts 2 implementation tasks on 2 vendors, in parallel       ─▶ evidence/02, 03
   └─ assert: different providers, different ports, different db suffixes
5 tasks finish ─▶ results collected (diffstat, tests, summary)
6 cross-vendor reviews run ─▶ round 1 changes_requested ─▶ findings to author ─▶ evidence/04, 05
7 round 2 approved ─▶ human approves gate ─▶ merge into integration branch ─▶ evidence/06
8 mid-run resilience: kill -9 the daemon during step 6, restart, continue  ─▶ evidence/09
9 open PR on the real forge ─▶ verify body provenance block               ─▶ evidence/07
10 cost roll-up + budgets recorded                                         ─▶ evidence/08, budgets.md
11 SQL assertions run and pasted                                           ─▶ db-queries.md
12 defect triage ─▶ fix-now PRs (referencing M3-09) or new roadmap steps   ─▶ defects.md
13 milestone README exit criteria ticked ; PROGRESS.md ; RISKS.md review
14 tag `mvp+` ; close the milestone
```

## 5. Tasks
- [ ] Pick the target repo + feature against the selection rule; write `evidence/00-preconditions.md`.
- [ ] Add `orch mission export <id> --json` to `apps/cli` (mission, tasks, results, reviews, routing decisions, events).
- [ ] Write the `FakeProvider` mission E2E (`tests/e2e/mission.spec.ts`) with two distinct fake provider ids, 2 parallel tasks, a forced `changes_requested` round, merge and stubbed PR.
- [ ] Add the `mission-e2e` job to CI; make it a required check.
- [ ] Dry run the whole path once on `~/orchestra-scratch/` to shake out obvious breakage before touching the real repo.
- [ ] Execute the real mission; capture evidence 01–08 as the run progresses (do not reconstruct afterwards).
- [ ] Perform the mid-run `kill -9` and record `evidence/09-restart.md`.
- [ ] Run and paste the SQL acceptance assertions into `evidence/db-queries.md`.
- [ ] Measure and record budgets (web cold start, first WS frame, per-pane memory, daemon RSS with 4 panes) in `evidence/budgets.md`.
- [ ] Open the real PR; verify the provenance block renders on the forge; screenshot it.
- [ ] Triage every defect into `evidence/defects.md`; open fix PRs or new roadmap step ids.
- [ ] Write `evidence/MANIFEST.md` mapping artifact → claim proved.
- [ ] Tick the M3 README exit criteria; update `PROGRESS.md` rows for M3-01..M3-09.
- [ ] Review `RISKS.md` (R11, R12, R16 at minimum) and update scores/status with what the run showed.
- [ ] Record any decisions made during the run in `DECISIONS.md` (ADR if a contract changed).
- [ ] Clean up: delete the run's worktrees, release leases, and either merge or close the PR deliberately.
- [ ] Tag `mvp+` and push.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| E2E-M3-09-01 | e2e (Playwright, CI) | FakeProvider mission: plan → 2 parallel tasks → cross-vendor review (2 rounds) → merge → stubbed PR | completes green in < 5 min; no real binary invoked (asserted by the binary allowlist spy) |
| E2E-M3-09-02 | e2e (CI) | cross-vendor constraint in the fixture | reviewer fake provider id ≠ author fake provider id for every reviewed task; zero degraded reviews |
| E2E-M3-09-03 | e2e (CI) | parallel isolation in the fixture | the two implementation tasks hold distinct ports and db suffixes; both dev-server stubs answer |
| IT-M3-09-01 | integration (CI) | daemon restart injected mid-mission in the fixture | mission completes; zero duplicate `task_results` / `reviews` rows; zero lost prompts |
| CT-M3-09-01 | contract (CI) | acceptance SQL assertions run against the fixture's database | all four assertions hold (cross-vendor 0, review coverage 100 %, distinct ports, pr_url set) |
| UT-M3-09-01 | unit | `orch mission export` serializer on a fixture mission | stable JSON shape, no secret-shaped fields (regex assertion, same as the auth contract test) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-09-01 | Real mission, real repo, two vendors | 1. Preconditions recorded 2. Start the mission with `new-feature-fullstack` 3. Approve the plan 4. Let it run | Two implementation tasks run simultaneously on two different vendors in their own worktrees; Missions DAG and Terminals both show it; evidence 02–03 captured | ⬜ |
| TC-M3-09-02 | Cross-vendor review really happened | 1. After reviews finish 2. Run the cross-vendor SQL assertion | Query returns 0 rows where reviewer provider == author provider; zero degraded reviews; evidence 04 captured | ⬜ |
| TC-M3-09-03 | A real `changes_requested` round improved the code | 1. Inspect round-1 findings 2. Inspect the author's follow-up diff | At least one finding was genuinely addressed in round 2 (not cosmetic); round 2 verdict approved; evidence 05 captured | ⬜ |
| TC-M3-09-04 | Merge and PR on a real forge | 1. Approve gates, merge both tasks 2. Open the PR | Integration branch contains both tasks' work; tests pass on the integration branch; PR body shows author models, reviewer vendors, rounds, test status, plan version; evidence 06–07 captured | ⬜ |
| TC-M3-09-05 | Mid-mission restart (resilience) | 1. During review, `kill -9` the daemon 2. Restart 3. Continue | Agents survived in tmux; the daemon re-attaches; no duplicate review rows; no lost prompt; the mission completes; evidence 09 written | ⬜ |
| TC-M3-09-06 | Budgets under real load | 1. With 4 panes live, measure web cold start, first WS frame, per-pane memory, daemon RSS | All within `12-ux-principles.md` targets, or a defect is filed with numbers in `budgets.md` | ⬜ |
| TC-M3-09-07 | Only-one-vendor degradation refused (negative) | 1. After the main run, log out of one vendor 2. Start a one-task mission with `review.allowSameVendorDegrade: false` | The task escalates to a human instead of being self-reviewed; no same-vendor review row is written | ⬜ |
| TC-M3-09-08 | Blocked mission is legible (negative) | 1. Force a task to exhaust its review rounds | Missions header says "waiting on you"; the node is flagged; Review shows the escalation; no runaway sessions or spend after the escalation | ⬜ |
| TC-M3-09-09 | Clean teardown | 1. After the run, cancel/close everything 2. `git worktree list`, `GET /isolation/leases`, `tmux ls` | No leftover worktrees, no held leases, no orphan panes; the real repo's working checkout is untouched (`git status` clean) | ⬜ |
| TC-M3-09-10 | Evidence is auditable | 1. Hand `evidence/` to a reader who did not watch the run | Every M3 exit criterion can be traced to a named artifact via `MANIFEST.md`; nothing rests on memory | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] A real feature is merged into the integration branch of a **real repository** and a real PR is open, produced by a mission with ≥ 2 vendors (TC-M3-09-01, -04).
- [ ] Cross-vendor review is proven by SQL, not by claim: zero same-vendor reviews, 100 % review coverage on tasks that require it (TC-M3-09-02).
- [ ] At least one `changes_requested` round demonstrably improved the code (TC-M3-09-03).
- [ ] Parallel tasks used distinct ports and db suffixes throughout; no collision occurred (evidence 03 + SQL).
- [ ] A mid-mission `kill -9` did not lose a prompt, duplicate a review, or break the mission (TC-M3-09-05).
- [ ] All `12-ux-principles.md` budgets met under four live panes, or each miss is filed as a defect with numbers (TC-M3-09-06).
- [ ] The CI `mission-e2e` job is green, required, and touches no real account (E2E-M3-09-01..03, C9).
- [ ] `evidence/` is complete per `MANIFEST.md`; every defect is fixed or carries a roadmap step id (TC-M3-09-10).
- [ ] M3 README exit criteria all ticked; `PROGRESS.md`, `RISKS.md`, `DECISIONS.md` updated.
- [ ] Repository tagged `mvp+`; no new lint / dependency-cruiser violations anywhere.

## 8. Risks / open questions
- **Real-repo risk**: a mission on a repo you care about can create noise (branches, a PR, CI minutes). Mitigation: target a throwaway base branch, never `main`; agree the cleanup steps (TC-09) before starting.
- **Quota risk**: a full mission with two implementation tasks and two review rounds on top-tier models can consume a meaningful slice of a 5-h window. Run it early in a window; if a 429 lands, capture it as M4 input rather than fighting it here (R6, M4-03).
- **Non-determinism**: real agents may produce a trivially small diff or a review with zero findings, which weakens TC-03. Pick a feature with a known rough edge (a missing validation, an unhandled error path) so a reviewer has something real to find.
- **Time**: 2.5 days assumes two full mission runs (one dry on scratch, one real) plus fixes. If the first real run fails badly, the honest move is to fix and re-run, not to relax the criteria.
- Whether `mvp+` is the right tag name (vs `m3`) is cosmetic — decide with `10-…`/release conventions in M10-07 and keep the tag stable afterwards.
- CLI versions may change mid-run; record them in preconditions and re-record if you update mid-flight (this is exactly the drift M6 will automate).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
