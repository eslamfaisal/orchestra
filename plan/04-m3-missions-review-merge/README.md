# Milestone M3 — Missions, review & merge

| Field | Value |
|---|---|
| Folder | `plan/04-m3-missions-review-merge/` |
| Steps | 9 (M3-01 … M3-09) |
| Effort | ~22 working days |
| Entry gate | M2 acceptance ✅ (assignment engine + MCP delegation live on real CLIs) |
| Feature flags | `features.missions`, `features.review`, `features.forge`, `features.isolation` (all default `false` until M3-09 passes) |
| Exit tag | `mvp+` |

## Goal

After M3 the unit of work stops being "a task" and becomes **a mission**. You describe a feature once; a Lead agent (any provider) decomposes it against a versioned **playbook** into a typed task DAG; you approve the plan as a card in Attention; the daemon schedules the tasks in dependency order, each in its own git worktree with its own injected port and database suffix; each finished task is turned into a deterministic `TaskResult` (branch, diffstat, test status, summary) by the daemon rather than self-reported by the agent; every task is then reviewed by a model from a **different vendor**, whose structured findings either approve it or go back to the author as a follow-up message for another bounded round; you read the diff and the findings in a **Review** screen, comment inline (previewed before it is sent to the agent), approve, and merge into the mission's integration branch; and one click opens a real pull request through your own `gh`/`glab` credentials, with a body that states which model wrote each task and which vendor reviewed it. The **Missions** screen shows the whole thing as a live DAG with assignments, reasons, rounds and cost.

## Why this milestone now

- M2 proved the decision layer on one task at a time. The product promise in `01-vision-scope.md` — "describe a feature once → planned, split, assigned, cross-reviewed, PR'd" — is unmet until missions exist; M3 is the first milestone a user would describe as *the product*.
- **G3 ("better output through diversity", cross-vendor review on 100 % of mission tasks)** has no implementation anywhere else in the roadmap. M3-04 is the only place it becomes a machine-enforced constraint (D3: a deterministic `ReviewRule`, not Lead goodwill).
- D2 (worktree per task) is only economically useful once several tasks run at once — which immediately requires M3-07's port/DB isolation. Parallelism without isolation is a bug generator.
- Downstream milestones depend on M3 contracts: M4-04/M4-05 budget and hand off *missions*; M8-06 scores models from `review_findings` and `task_results`; M9-04 gates merges; M10-01's repair agent reuses the review + PR path. Building them on a missing task contract would mean rework (D11's rule: extend, never rewrite).
- The 1.0 Definition of Done line "worktrees + Review & Merge end-to-end on ≥ 2 providers · cross-vendor review enforced (e2e)" is claimed and evidenced here (M3-09), not later.

## Entry criteria

| Requirement | Why |
|---|---|
| M2-01 ✅ (task taxonomy) | playbook steps reference `taskType`; `reviewRequired` / `two-reviewer` come from the taxonomy |
| M2-04 ✅ (assignment engine) | task and reviewer assignment, and the cross-vendor constraint, are engine inputs |
| M2-05 ✅ (MCP delegation server) | the Lead delegates and collects through it; M3-02 adds `submit_plan` on top |
| M2-09 ✅ (routing decision log) | the Missions screen renders "why this model" from `routing_decisions` |
| M1-03 ✅ (worktree manager) | M3-07 may start in parallel with M2 work, it only needs worktrees |
| M1-11 ✅ (Attention queue) | plan cards and review escalations are `AgentPrompt`s |
| ≥ 2 providers logged in and passing contract tests on pinned fixtures | cross-vendor review is impossible with one healthy vendor (R12) |
| `gh` or `glab` installed and authenticated | M3-06; Orchestra never stores forge tokens (C2, C3) |
| A real repository with a green `test` command and a forge remote | M3-09 acceptance target |

## Exit criteria (measurable)

- [ ] `orch playbook validate --all` exits 0 for the six shipped playbooks; a workspace override shadows a shipped one and hot-reloads within 2 s.
- [ ] A real Lead on **two different vendors** each produce an accepted plan; every plan revision is a `plan_versions` row plus a `PLAN.md` on disk; zero `task.started` events precede `mission.plan_approved`.
- [ ] Every finished task has a `task_results` row whose `verdict` was derived by the daemon from git + test exit code, never from the agent's claim; collection is idempotent across a daemon restart.
- [ ] SQL over the run's database returns **zero** rows where `reviews.reviewer_provider = tasks.assigned_provider`, and **100 %** of tasks whose taxonomy entry requires review have ≥ 1 `reviews` row before `merged_at` is set.
- [ ] A same-vendor review is impossible unless `review.allowSameVendorDegrade` is explicitly enabled, and every degraded review emits `review.degraded` into the audit log.
- [ ] Review rounds are bounded by the playbook / `review.maxRounds` and escalate to a human — proven by a run that exhausts them without looping.
- [ ] From the Review screen a human can comment inline, see the verbatim preview, send it to the author agent through `PaneController`, approve, and merge; every send and merge is audited and hash-checked against its preview.
- [ ] The merge button is never enabled while `MergeEligibility.allowed` is false, and always lists its blockers as text.
- [ ] Two parallel tasks on one repo hold **distinct** `$ORCH_PORT` and `$ORCH_DB_SUFFIX` values; leases are released on worktree removal and reclaimed at boot without disturbing live sessions.
- [ ] A real pull request is opened on a real repo through `gh`/`glab`; `grep -Ei 'token|authorization|ghp_|glpat-'` over logs and the database returns nothing; the M0-08 egress test shows zero daemon-originated connections to forge hosts.
- [ ] The Missions screen shows a live DAG with provider/model + reasons per node, round chips, cost with `official`/`estimate` labelling, and a keyboard-navigable list view with the same data and actions.
- [ ] A mid-mission `kill -9` of the daemon loses no prompt, duplicates no review or result, and the mission still completes.
- [ ] CI `mission-e2e` job (FakeProvider, two distinct fake vendor ids) is green and required; no real account is touched in CI.
- [ ] `packages/core` rule modules added in M3 (`playbook`, `mission`, `task`, `review`, `isolation`, `forge`) are at 100 % branch coverage; no new ESLint / dependency-cruiser violations.
- [ ] All TC-M3-\*\* manual cases ✅ and recorded; `evidence/` complete per its `MANIFEST.md`; `PROGRESS.md`, `RISKS.md`, `DECISIONS.md` updated; tag `mvp+` pushed.

## Steps

| ID | File | Title | Effort | Depends on |
|---|---|---|---|---|
| M3-01 | [step-01-playbook-schema-and-shipped-playbooks.md](step-01-playbook-schema-and-shipped-playbooks.md) | Playbook schema & shipped playbooks | 2 d | M2-01 |
| M3-02 | [step-02-mission-lifecycle-and-lead-session.md](step-02-mission-lifecycle-and-lead-session.md) | Mission lifecycle & Lead session | 3 d | M3-01, M2-05 |
| M3-03 | [step-03-task-contract-and-result-collection.md](step-03-task-contract-and-result-collection.md) | Task contract & result collection | 2 d | M3-02 |
| M3-04 | [step-04-cross-vendor-review-rule-and-rounds.md](step-04-cross-vendor-review-rule-and-rounds.md) | Cross-vendor review rule & rounds | 3 d | M3-03 |
| M3-05 | [step-05-review-and-merge-ui.md](step-05-review-and-merge-ui.md) | Review & Merge UI | 3 d | M3-04 |
| M3-06 | [step-06-pr-integration.md](step-06-pr-integration.md) | PR integration | 2 d | M3-05 |
| M3-07 | [step-07-parallel-isolation.md](step-07-parallel-isolation.md) | Parallel isolation | 1.5 d | M1-03 ∥ (lands before M3-03 runs in parallel) |
| M3-08 | [step-08-missions-screen.md](step-08-missions-screen.md) | Missions screen | 3 d | M3-04 |
| M3-09 | [step-09-e2e-feature-mission-acceptance.md](step-09-e2e-feature-mission-acceptance.md) | E2E feature mission acceptance | 2.5 d | all M3 |

## What you can test after this milestone

| Scenario | Where |
|---|---|
| Pick a playbook, describe a feature, watch a Lead turn it into a task DAG you can approve, edit or reject | New mission dialog + Attention plan card (M3-01, M3-02) |
| A task finishes and you see branch, diffstat, test exit code and summary without opening a terminal — including "no changes" and "tests failed" verdicts | Board card + task drawer (M3-03) |
| A Codex-authored task is automatically reviewed by Claude (or vice versa), with findings pinned to file and line | Review screen (M3-04, M3-05) |
| Request changes and watch the findings arrive in the author's own pane, then a round-2 review approve it | Terminals + Review (M3-04) |
| Turn off every provider but one and confirm the task escalates to you instead of self-reviewing | Attention + `reviews` table (M3-04) |
| Comment on a diff line, read the exact text that will be sent, send it, and see it land in the agent's pane | Review composer preview (M3-05) |
| Merge two task branches into the mission branch without your own `git status` ever changing | Merge panel (M3-05) |
| One click opens a real PR whose body says which model wrote what and which vendor reviewed it | PR preview dialog (M3-06) |
| Two agents run dev servers at the same time on one repo without an `EADDRINUSE` in sight | Terminals port chips (M3-07) |
| Ask "why this model?" on any node of a running mission and get score, reasons and alternatives | Missions DAG (M3-08) |
| Cancel a runaway mission and watch panes stop, leases release and worktrees clean up | Missions actions (M3-08) |
| `kill -9` the daemon mid-review and watch the mission continue after restart | any of the above (M3-09) |

## Demo script (run end-to-end on real tools)

Preconditions: M2 demo passes; `claude` and `codex` logged in; `gh auth status` green; feature flags `missions`, `review`, `forge`, `isolation` set to `true`; scratch repo `~/orchestra-scratch/` with `.orchestra/workspace.yaml` containing a `test` command and a `devServer` template.

1. `orch playbook list` → six playbooks with step counts. `orch playbook validate --all` → `ok` ×6, exit 0.
2. **New mission**: playbook `new-feature-fullstack`, intent "add rate limiting to the public API with tests and docs", repo = scratch. Click **Plan**.
3. Watch the Lead pane open in **Terminals**; within a turn a **plan card** appears in **Attention** with the parsed task table. Click *Edit & resend*, delete the `docs` task, save → the Lead acknowledges the edited plan (v2, `author_kind: user`).
4. Open **Missions** → the DAG renders. Two implementation tasks start in parallel on **two different vendors**; hover a provider badge → "why this model" shows score, reasons, alternatives.
5. Back in **Terminals**: the two panes show different port chips (e.g. `:4402` and `:4404`) and different db suffixes. In each pane run `env | grep ORCH_` to confirm.
6. Tasks finish → **Board** cards show verdict chips; open a task drawer → diffstat, `pnpm test` exit code, summary sourced from `RESULT.md`.
7. Reviews start automatically on the *other* vendor. Round 1 returns `changes_requested`; watch the findings arrive as a follow-up message in the author's pane; the author fixes; round 2 approves.
8. Open **Review** → diff with agent findings in the gutter. Add your own comment on a line, click *Send to author*, compare the preview modal with what lands in the pane. Approve.
9. Click **Merge** (squash) → the integration branch gains the commit; your own `git status` in the repo is untouched. Repeat for the second task.
10. `kill -9 $(pgrep -f orchestrad)` mid-way through step 9, restart the daemon, and confirm nothing was lost: same tasks, same reviews, no duplicates, panes still alive in tmux.
11. Click **Open PR** → the preview shows title, body and the exact `gh pr create` argv. Confirm → the PR opens in the browser with the provenance block ("written by Codex …, reviewed by Claude …, 2 rounds").
12. Back in **Missions**: cost roll-up per provider with `official`/`estimate` labels; click *Simulate* → tooltip says it ships in M4-06.
13. `sqlite3 ~/.orchestra/orchestra.db "select count(*) from reviews r join tasks t on t.id=r.task_id where r.reviewer_provider=t.assigned_provider"` → `0`.
14. Cancel/clean up: `git worktree list`, `GET /isolation/leases`, `tmux ls` → nothing left behind.

## Milestone risks

| Risk | Why it bites here | Mitigation in this milestone |
|---|---|---|
| R11 — Lead produces bad decompositions or loops | the Lead now creates the whole DAG and spends quota per node | plan approval gate + `maxPlanRevisions` + daemon-side DAG validation (M3-02); bounded review rounds with human escalation (M3-04); cancel from the DAG (M3-08) |
| R12 — cross-vendor review impossible with one healthy provider | the milestone's headline goal (G3) is unachievable in that state | escalate to a human by default; same-vendor degradation only behind `review.allowSameVendorDegrade` with an audit record and a UI badge (M3-04); proven negative test TC-M3-09-07 |
| R1 — vendor CLI changes break structured-output capture | findings capture depends on `--output-schema` / `--output-format json` shapes | strategy-per-provider extractors with a `REVIEW.md` fallback and a Zod gate; every path pinned to a fixture; unparsable output escalates rather than silently approving (M3-04) |
| R5 — prompt/answer round-trip reliability | review comments and plan decisions are answers delivered to live agents | preview + hash + ack-or-timeout; unsent comments stay retryable; fall back to a fresh task run with findings folded into `TASK.md` (M3-04, M3-05) |
| R8 — resource budgets with several live panes | missions make 4+ concurrent agents the normal case | budgets measured under real load in M3-09; port/lease pressure visible in Fleet (M3-07) |
| New — merge/PR side effects on real repos | this is the first milestone that writes outside the scratch repo | never `--force`, never the user's working checkout, dedicated `.orchestra/integration/` worktree, throwaway base branch for the acceptance run, documented teardown (M3-05, M3-06, M3-09) |
| R16 — bandwidth; M3 is the largest non-MVP milestone | 22 days with a hard gate at the end | three parallel lanes (below); M3-07 can land during M2; M3-08 can start as soon as M3-04's contracts exist |

## Parallelization

- **M3-07 is independent.** It depends only on M1-03 and can be built at any point during M2 or early M3; it must land before the first parallel mission run (M3-03 onward) to be useful.
- **Critical path:** M3-01 → M3-02 → M3-03 → M3-04 → M3-05 → M3-06 → M3-09 (~15.5 d).
- **M3-08 runs in parallel with M3-05/M3-06** once M3-04's `MissionGraphResponse` inputs (`reviews`, `routing_decisions`) are stable — it is a read-model screen and adds no write path.
- Within M3-05, the `DiffView`/`FindingGutter` components in `packages/ui` can be built against fixtures before the `GET /tasks/:id/diff` endpoint exists; agree the DTO first, then split.
- Within M3-04, the three `FindingsExtractor` strategies are independent of the round state machine; the `REVIEW.md` extractor is enough to unblock the whole loop, with the structured-output ones added after.
- M3-09's CI `mission-e2e` fixture can be written as soon as M3-04 lands and will catch regressions in M3-05..M3-08 while they are still being built.
- Do **not** parallelize M3-02 with M3-01 (the playbook schema is M3-02's input) or M3-06 with M3-05 (the PR panel lives inside the merge panel).
