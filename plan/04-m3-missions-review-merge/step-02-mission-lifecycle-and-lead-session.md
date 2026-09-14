# Step M3-02 — Mission lifecycle & Lead session

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-01, M2-05 |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `apps/daemon` (application/missions, infrastructure/git, interface/http, interface/mcp), `apps/web`, `packages/sdk` (FakeProvider scenario) |
| Risk | High |
| Owner | |

## 1. Goal
A user types a mission title + intent, picks a playbook and a repo, and clicks **Plan**. The daemon launches a **Lead session** (a normal `Session` with role `lead`, any provider, MCP delegation server registered), writes a `BRIEF.md`, and the Lead produces `PLAN.md` under `<repo>/.orchestra/missions/<missionId>/`. The plan appears as a **plan card in Attention** with *Approve / Edit & resend / Reject*. On approval the mission moves to `executing`, the Lead instantiates the playbook DAG through `delegate()`, and the daemon's `MissionScheduler` starts tasks in dependency order. Every plan revision is stored in `plan_versions`. Task execution details (worktree, result) come from M3-03; this step ends when tasks are created, ordered and started.

## 2. Why
- D3: the Lead decomposes; the daemon decides order, concurrency and assignment. This step is where the two tiers meet.
- D14 / G1: plan approval is an `AgentPrompt` (kind `planApproval`) like any other stop-and-ask — answerable from web now and phone in M7-03.
- G5: `PLAN.md` versions are first-class records (`plan_versions`) linked to the mission and Lead session.
- R11 (bad decompositions): approval gate + `maxPlanRevisions` + daemon-side DAG validation bound the damage.
- C10: the Lead's plan is previewed and explicitly approved before any task spends quota.

## 3. Scope
### In scope
- `Mission` aggregate + state machine (`draft → planning → plan_review → executing → reviewing → merging → done | failed | cancelled`) in `packages/core/src/mission/`.
- Use cases: `CreateMission`, `StartPlanning`, `SubmitPlan`, `DecidePlan`, `StartExecution`, `CompleteMission`, `FailMission`, `CancelMission`; application service `MissionScheduler`.
- Lead launch via existing `StartSession` (M1-02) with `role: lead`, MCP config from `Launcher.preLaunchFiles` (M2-05), `BRIEF.md` composition.
- MCP tool additions on the M2-05 server: `submit_plan`; `delegate()` gains `missionId`, `planTaskId`, `dependsOn[]`; `status()` returns the mission DAG.
- Mission integration branch `orchestra/mission-<shortId>` created from `baseRef`.
- Plan card variant for missions in Attention (extends M2-08 plan cards v1), minimal Missions list (v0) and *New mission* dialog.
### Out of scope (deferred to …)
- Result collection, tests, `RESULT.md` — deferred to M3-03.
- Review rounds and reviewer assignment — deferred to M3-04.
- Full Missions screen (DAG view, cancel/retry per task) — deferred to M3-08.
- Lead handoff on quota exhaustion via PLAN.md — deferred to M4-05; Lead reserve — M4-04.
- Scheduled / triggered missions — deferred to M9-07.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Mission { id, title, intent, playbookRef {id, version, yamlSnapshot}, repoPath, baseRef, integrationBranch, state, stateReason?, leadSessionId?, currentPlanVersionId?, planRevisions, budget, createdAt }`.
- `PlanVersion { id, missionId, sessionId?, version, content (markdown), tasks: PlannedTask[], source: 'plan_md'|'plan_mode'|'codex', authorKind: 'agent'|'user', decision: 'pending'|'approved'|'edited'|'rejected', feedback?, createdAt }`.
- `PlannedTask { planTaskId, stepId, title, taskType, role, goal, acceptance[], constraints[], dependsOn: planTaskId[], skills[] }` — parsed from the fenced ```` ```yaml orchestra-plan ```` block inside `PLAN.md` (Zod). The block is mandatory; prose around it is free.
- Rules (`packages/core/src/mission/rules.ts`): `transition(mission, event)` table-driven state machine (100 % branch); `validatePlanAgainstPlaybook(plan, playbook)`: every `stepId` exists, `multiplicity: one` steps appear at most once, `executor: lead` steps are not in the task list, `dependsOn` resolves and is acyclic (reuses M3-01 `validateDag`), every non-lead step with `multiplicity: one` is present (error `E_STEP_MISSING`, may be waived per step with `optional: true` in the plan).
- Lifecycle placement of `gate` (from M3-01): a task's gate is evaluated after review approval (M3-04) and before merge into the integration branch (M3-05/06); `lead` gate = Lead calls `collect()` with `decision: accept`; `human` gate = human accepts in Review; `4-eyes` ⇒ `human` until M9-04.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/missions/ports.ts
export interface MissionRepository { get(id): Promise<Result<Mission, MissionNotFound>>; save(m: Mission): Promise<Result<void, RepoError>>; list(f?: MissionFilter): Promise<Result<Mission[], RepoError>>; }
export interface PlanVersionRepository { add(v: PlanVersion): Promise<Result<void, RepoError>>; listByMission(id): Promise<Result<PlanVersion[], RepoError>>; }
export interface MissionFs { writeBrief(m: Mission, brief: string): Promise<Result<string, FsError>>; writePlan(m: Mission, v: PlanVersion): Promise<Result<string, FsError>>; }
export interface IntegrationBranchPort { create(repoPath: string, baseRef: string, name: string): Promise<Result<{ sha: string }, GitError>>; exists(repoPath: string, name: string): Promise<Result<boolean, GitError>>; }

// MCP tool contracts (additions to M2-05 server; Zod at the edge)
// submit_plan — long-running (MCP tasks extension); resolves when a human decides
type SubmitPlanInput  = { missionId: string; markdown: string };
type SubmitPlanResult = { decision: 'approved' | 'rejected'; edited: boolean; planVersion: number; content: string; feedback?: string };
type DelegateInput    = DelegateInputV1 & { missionId?: string; planTaskId?: string; dependsOn?: string[] /* taskIds */ };
type StatusResult     = StatusResultV1 & { mission?: { state: MissionState; tasks: { id; planTaskId; state; provider?; model?; blockedBy: string[] }[] } };

export type MissionError =
  | { code: 'MissionStateViolation'; from: MissionState; event: string }
  | { code: 'PlanInvalid'; errors: PlaybookError[] }
  | { code: 'PlanRevisionsExhausted'; max: number }
  | { code: 'DependencyNotSatisfied'; taskId: string; waitingOn: string[] }
  | { code: 'IntegrationBranchExists'; name: string };
```
`AgentPrompt` for plan approval: `kind: 'planApproval'`, `options: ['approve','edit','reject']`, `payload: { missionId, planVersionId, content, tasks }`, `answerTransport: 'mcp-result'` (the transport M2-05 introduced for `ask_user`; fallback `send-keys-acked` with the message `Plan v<N> <decision>. <feedback>` if the originating tool call is gone).

### 4.3 Data / schema changes
- `missions` (schema v1) + migration `m3_02_missions_ext`: `intent TEXT`, `repo_path TEXT`, `base_ref TEXT`, `integration_branch TEXT`, `playbook_version TEXT`, `playbook_yaml TEXT` (snapshot), `plan_revisions INT DEFAULT 0`, `state_reason TEXT`, `updated_at TEXT`, `completed_at TEXT`.
- `plan_versions` + `tasks_json TEXT`, `author_kind TEXT`, `decision TEXT`, `feedback TEXT`, `created_at TEXT`. `approved` (bool) kept for M2-08 compatibility, derived from `decision`.
- `tasks.plan_task_id TEXT`, `tasks.step_id TEXT`, `tasks.depends_on_json TEXT` (taskIds), `tasks.blocked_reason TEXT`.
- Events: `mission.created|planned|plan_approved|executing|completed` (catalog) **+ new** `mission.plan_rejected`, `mission.plan_edited`, `mission.failed`, `mission.cancelled`, `task.queued` (created but waiting on deps). Note the additions in `04-domain-model.md` §3 when the step closes.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Lead session = `StartSession` (M1-02) with `InteractiveSpec { role:'lead', cwd: repoPath (main checkout, not a worktree), mcpServers: [delegation] }`. Interactive by default so the user can watch/chat (Terminals + Chat); headless Lead is a flag `missions.leadMode: interactive|headless`.
- `BRIEF.md` written by the daemon at `<repo>/.orchestra/missions/<id>/BRIEF.md`: title, intent, repo facts (base ref, `.orchestra/workspace.yaml#test`), playbook steps table (id, taskType, role, deps, gate, rounds, multiplicity), the required `orchestra-plan` YAML block spec, tool rules ("call `submit_plan` when the plan is ready; after approval call `delegate` once per task with `planTaskId` and `dependsOn`; use `ask_user` for questions; never run tests or edit code yourself"). Initial prompt after launch ack: `Read .orchestra/missions/<id>/BRIEF.md and produce the plan.` delivered via `PaneController.sendCommand` (interactive) or as the headless prompt.
- `.orchestra/.gitignore` (M1-03 template) gains `missions/`.
- Git: `git branch orchestra/mission-<shortId> <baseRef>` in the main checkout (no checkout switch; `IntegrationBranchPort` via `simple-git` in `infrastructure/git`). Tasks branch from it (M3-03).
- Persistence of the pending `submit_plan` call: the MCP shim (M2-05) holds the open tool call; the daemon stores `agent_prompts.payload.mcpCallId`. If the daemon restarts, the prompt survives (durable), the shim call fails on the Lead side, and the answer falls back to `send-keys-acked`.

### 4.5 API / UI surface
- `POST /missions` `{ title, intent, playbookId, repoPath, baseRef?, lead?: { provider, model } }` → 201 mission (state `draft`). `Idempotency-Key` honoured.
- `POST /missions/:id/plan` → launches the Lead (state `planning`); 409 on state violation.
- `GET /missions`, `GET /missions/:id` (mission + tasks + current plan), `GET /missions/:id/plan-versions`, `GET /missions/:id/plan-versions/:v`.
- `POST /missions/:id/plan-versions/:v/decision` `{ decision: 'approve'|'edit'|'reject', content?, feedback? }` — same effect as answering the Attention prompt (`POST /prompts/:id/answer`, M1-11).
- `POST /missions/:id/cancel` (stops Lead + tasks).
- WS topics: `missions` (list deltas), `mission.<id>` (state, plan versions, task queue changes).
- UI (`apps/web/src/screens/missions/`): `NewMissionDialog` (title, intent textarea, playbook select with step preview from M3-01, repo picker, Lead provider/model preview from the assignment engine with override), `MissionsListV0` (title, playbook, state chip, Lead session link). Attention plan card: markdown render, parsed task table, three buttons; *Edit & resend* opens a markdown editor pre-filled with the plan; saving creates a user-authored `PlanVersion` (`decision: edited`, auto-approved) and returns it to the Lead.

### 4.6 Flow / sequence
```
UI POST /missions ──▶ CreateMission ─▶ missions(draft) ─▶ mission.created
UI POST /missions/:id/plan ─▶ StartPlanning
   ├─ AssignmentEngine(taskType=decomposition) → Lead provider/model (or override)
   ├─ MissionFs.writeBrief → BRIEF.md
   ├─ StartSession(role=lead, mcp=delegation) → sessions row, tmux pane
   └─ state=planning ─▶ mission.planned? no: `session.launched`
Lead ── MCP submit_plan{markdown} ─▶ SubmitPlan
   ├─ parse orchestra-plan block ─▶ validatePlanAgainstPlaybook ─▶ Err ⇒ tool result {error, hints} (Lead fixes, no revision counted)
   ├─ plan_versions v=N (decision pending) ; MissionFs.writePlan → PLAN.md
   ├─ AgentPrompt(planApproval) ─▶ Attention  ; state=plan_review ─▶ mission.planned
Human answers ─▶ AnswerPrompt(M1-11) ─▶ DecidePlan
   ├─ approve ─▶ v.decision=approved ─▶ StartExecution: create integration branch, state=executing ─▶ mcp-result {approved}
   ├─ edit    ─▶ new v=N+1 (user) approved ─▶ StartExecution ─▶ mcp-result {approved, edited:true, content}
   └─ reject  ─▶ planRevisions++ ; ≥ max ⇒ FailMission ; else state=planning ─▶ mcp-result {rejected, feedback}
Lead ── delegate{planTaskId, dependsOn} ×N ─▶ tasks(draft→assigned) ; deps unmet ⇒ state=assigned + task.queued
MissionScheduler(on task.created|task.done|task.failed) ─▶ readyTasks ∩ freeSlots(missions.maxParallelTasks) ─▶ StartTask (M3-03)
all tasks done ─▶ CompleteMission (state per M3-06 merge policy) ; any task failed & no retry ⇒ mission stays executing with blocked_reason (human decides in M3-08)
```

## 5. Tasks
- [ ] `Mission`, `PlanVersion`, `PlannedTask` entities + table-driven state machine in `packages/core/src/mission/` (100 % branch tests).
- [ ] `validatePlanAgainstPlaybook` rule + Zod schema for the `orchestra-plan` block (`packages/catalog/schemas/plan-block.schema.ts`).
- [ ] Migrations `m3_02_missions_ext`, `m3_02_plan_versions_ext`, `m3_02_tasks_dag`; repositories (sqlite + in-memory).
- [ ] `LeadBriefComposer` + `MissionFs` (infrastructure/fs) writing `BRIEF.md` / `PLAN.md`; extend `.orchestra/.gitignore` template.
- [ ] `IntegrationBranchPort` implementation (infrastructure/git) + `GitError` mapping.
- [ ] Use cases `CreateMission`, `StartPlanning`, `SubmitPlan`, `DecidePlan`, `StartExecution`, `CompleteMission`, `FailMission`, `CancelMission` (one class each, Result-returning).
- [ ] `MissionScheduler` application service subscribed to the event bus; concurrency `missions.maxParallelTasks` (config, default 4); idempotent on replayed events.
- [ ] MCP server: add `submit_plan` (tasks-extension long-running), extend `delegate` and `status` schemas; register `mcp-result` transport for `planApproval` with `send-keys-acked` fallback.
- [ ] `AgentPrompt` classifier: map `submit_plan` to `kind: planApproval` (reuse M1-11 durable queue).
- [ ] HTTP `MissionsController` + DTOs + OpenAPI; WS topics `missions`, `mission.<id>`.
- [ ] Web: `NewMissionDialog`, `MissionsListV0`, mission plan-card variant with editor; ⌘K action "New mission".
- [ ] FakeProvider scenario `lead-plan-and-delegate.yaml`: Lead calls `submit_plan`, then `delegate` ×3 with deps, then idles.
- [ ] Config keys `missions.maxPlanRevisions` (3), `missions.maxParallelTasks` (4), `missions.leadMode`.
- [ ] Docs: `apps/daemon/README` mission section; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-02-01 | unit | mission state machine: every (state, event) pair | legal pairs transition; illegal return `MissionStateViolation`; 100 % branch |
| UT-M3-02-02 | unit | parse `PLAN.md` with/without `orchestra-plan` block; block with unknown `stepId` | ok / `PlanInvalid{E_BLOCK_MISSING}` / `PlanInvalid{E_UNKNOWN_STEP}` |
| UT-M3-02-03 | unit | `validatePlanAgainstPlaybook`: `multiplicity: one` step twice; lead step listed; missing required step | three distinct errors, all reported |
| AT-M3-02-01 | application | `SubmitPlan` twice with identical markdown (Lead retry) | one `plan_versions` row (idempotent by content hash), one prompt |
| AT-M3-02-02 | application | `DecidePlan(reject)` × `maxPlanRevisions` | mission `failed`, `state_reason = PlanRevisionsExhausted`, Lead session stopped |
| AT-M3-02-03 | application | `MissionScheduler` with 5 tasks, diamond DAG, `maxParallelTasks = 2` | never > 2 running; dependents start only after all deps `done`; replaying the same `task.done` event twice starts nothing extra |
| AT-M3-02-04 | application | `delegate` with `dependsOn` referencing a task of another mission | `Err(DependencyNotSatisfied)` and nothing persisted |
| IT-M3-02-01 | integration | FakeProvider Lead scenario end-to-end (tmux + sqlite) | plan prompt opened; approve ⇒ tasks created in order; integration branch exists in scratch repo |
| IT-M3-02-02 | integration | daemon killed while prompt `planApproval` open; restart; answer approve | mission reaches `executing`; answer delivered through `send-keys-acked` fallback; audit row records transport |
| E2E-M3-02-01 | e2e (Playwright) | New mission dialog → Plan → plan card → *Edit & resend* | v2 authored by user, `decision: edited`, mission `executing`, FakeProvider Lead received content |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-02-01 | Claude Code Lead plans a bugfix mission | 1. `claude` logged in; scratch repo with a seeded bug 2. New mission: playbook `bugfix`, intent "fix off-by-one in `paginate()`" 3. Plan | Lead pane opens in Terminals within 5 s; `BRIEF.md` exists; within one Lead turn a plan card appears in Attention with ≥ 3 parsed tasks mapped to `triage/fix/regression/changelog` | ⬜ |
| TC-M3-02-02 | Approve → DAG instantiated | 1. Approve the card 2. Watch Chat for the Lead | Lead calls `delegate` per task; `GET /missions/:id` shows tasks with `depends_on`; only `triage` is `running`, others `assigned` with `blockedBy`; branch `orchestra/mission-<id>` exists | ⬜ |
| TC-M3-02-03 | Edit & resend | 1. New mission (playbook `refactor`) 2. On the card click *Edit & resend*, remove the `docs` task and mark it `optional: true` 3. Save | `plan_versions` has v2 `author_kind=user`, `decision=edited`; Lead's next message acknowledges the edited plan; no `docs` task created | ⬜ |
| TC-M3-02-04 | Reject cap (negative) | 1. New mission 2. Reject with feedback "too coarse" three times | After the 3rd rejection mission state `failed`, reason `PlanRevisionsExhausted`; Lead session stopped; Attention has no dangling prompt | ⬜ |
| TC-M3-02-05 | Invalid plan block from Lead (negative) | 1. Ask the Lead in Chat to submit a plan whose block references `stepId: deploy` (not in `bugfix`) | Tool result shows `E_UNKNOWN_STEP deploy` with the list of valid steps; no plan version stored; Lead self-corrects | ⬜ |
| TC-M3-02-06 | Restart during plan review (resilience) | 1. Reach a plan card 2. `kill -9` the daemon 3. Restart 4. Approve the card | Card still present after restart; approval lands; Lead pane shows the fallback message "Plan v1 approved…" and proceeds to delegate | ⬜ |
| TC-M3-02-07 | Codex as Lead | 1. Same as TC-01 with Lead override `codex` | MCP config is written by `preLaunchFiles` (verify path from manifest `paths.mcpConfig`); `submit_plan` arrives; card renders | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Mission state machine and plan validation rules at 100 % branch coverage in `packages/core`.
- [ ] A real Lead (Claude Code) and a second provider (Codex) both produce an accepted plan on the scratch repo (TC-01, TC-07).
- [ ] Approve / Edit & resend / Reject all round-trip to the Lead through `mcp-result`; fallback transport proven by TC-06 / IT-M3-02-02.
- [ ] `MissionScheduler` respects DAG order and `maxParallelTasks` (AT-M3-02-03) and is idempotent under event replay.
- [ ] Every plan revision is a `plan_versions` row and a `PLAN.md` on disk; `mission.*` events emitted for each transition.
- [ ] No task session starts before a plan is approved (audit query shows zero `task.started` before `mission.plan_approved`).
- [ ] All TC-M3-02-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations.

## 8. Risks / open questions
- **Lead quota**: an interactive Lead burns a top-tier model while idle-waiting; M4-04 adds reserves. Mitigation now: Lead idles after `delegate()` and is only messaged on gate/collect events.
- The `mcp-result` transport name and the shim behaviour on daemon restart are assumed from M2-05; align names at step start.
- FakeProvider must be able to issue MCP calls in scenarios (assumed delivered in M2-05 for `delegate`); if not, add `mcpCall` scenario steps here.
- Claude Code native plan mode (`ExitPlanMode`) may fire *in addition to* `submit_plan` when the Lead enters plan mode on its own — the classifier must not open two cards; dedupe by mission + content hash. (verify against Claude Code docs at step start)
- Codex Lead via app-server: MCP server registration path/format for Codex is manifest-driven (`paths.mcpConfig`) — verify against Codex docs at step start.
- Whether the Lead should delegate all tasks up-front or lazily is left to the Lead; the scheduler handles both.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
