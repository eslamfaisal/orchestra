# Step M1-12 — Quick Delegate lite

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-11, M1-03 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/daemon/src/application/tasks`, `apps/web` (Quick Delegate dialog + task card), `packages/core` (Task minimal) |
| Risk | Medium |
| Owner | |

## 1. Goal
From the command palette or Fleet, the user describes one task in plain text, picks a provider + model manually (no engine yet), chooses headless or interactive, and Orchestra: creates a `Task` (type `quick`), a worktree + branch, launches the session with the goal as the initial prompt, tracks it (running / waiting for input via Attention / done), and when the session ends collects a `TaskResult`: branch, diffstat vs base, tests run (if `workspace.yaml#test` exists), the agent's final summary, exit status. The task card shows all of it with "copy branch", "open worktree path", "open in Terminals".

## 2. Why
G1 ("delegate this chore"), D11 (MVP proves the delegate → worktree → result loop before intelligence), G3 groundwork (TaskResult is what reviews consume in M3).

## 3. Scope
### In scope
- Core `Task` minimal fields + `task` state machine (draft → assigned → running → done/failed/cancelled; review states unused until M3).
- Use cases: `CreateQuickTask`, `RunTask` (worktree → session start with initial prompt; headless uses `Launcher.headless`, interactive uses `interactive` + sends the goal as first input through `PaneController.sendCommand`), `CollectTaskResult` v0 (on session stop: diffstat, test run via `ProcessRunner` in the worktree if configured, summary = last assistant message or `RESULT.md` if present), `CancelTask`.
- `.orchestra/workspace.yaml` v0: `{ test: "npm test", devServer?: … }` read from the repo (schema + validation; full settings in M8-01).
- UI: Quick Delegate dialog (goal, provider, model, mode, repo, base ref), task cards list (Board is M2-07; here a simple list on `/board` placeholder route or Fleet side panel), result view (diffstat table, tests pass/fail with output tail, summary, exit code, links).
- Events: `task.created/assigned/started/result_submitted/failed`.
### Out of scope (deferred)
- Auto-assignment/preview reasons → M2-06. Board → M2-07. Reviews/PR → M3. Budget/usage on the card (basic usage from telemetry shown if present) → M4.

## 4. Design
### 4.1 Domain
`Task { id, missionId: null, taskType: 'quick', role: 'implementer', goal, context: {repoPath, baseRef}, acceptance: [], constraints: [], budget: null, state, assignedProvider, assignedModel, worktreeId, sessionId }`; `TaskResult { taskId, branch, diffStat, summary, testsPassed: boolean|null, testsOutputTail, artifacts: [], usage, verdict: 'unreviewed', exitCode }`.
### 4.2 Interfaces / contracts
```ts
POST /tasks/quick { goal, provider, model, mode: 'headless'|'interactive', repoPath, baseRef? } → 201 Task
GET  /tasks?state=  · GET /tasks/:id (+result) · POST /tasks/:id/cancel
WS topic 'tasks'
export class CollectTaskResult { execute(taskId: string): Promise<Result<TaskResult, DomainError>> }  // idempotent; re-run allowed
```
Headless prompt template (per provider, in manifest `headless.promptTemplate` "(verify)"): goal + "work only inside this worktree; commit your changes on the current branch with a clear message; write a short summary as your final message".
### 4.3 Data / schema changes
`tasks`, `task_results` (baseline). Migration `0009_tasks_quick.ts` if columns missing (`tests_output_tail`, `exit_code`).
### 4.4 Infrastructure
Test command executed with `ProcessRunner` in the worktree, timeout 10 min, output tail 4 KB, allowlisted binaries only (npm/pnpm/node/git… → extend allowlist for workspace test runners via config with explicit user confirmation).
### 4.5 API / UI surface
Routes above; palette "Quick Delegate"; task list + card.
### 4.6 Flow
```
dialog → CreateQuickTask → CreateWorktree → StartSession(initial prompt) → task.running
… prompts → Attention (M1-11) …
session.stopped → CollectTaskResult → diffstat/tests/summary → task.done | failed(exit≠0 or no commits ⇒ warn)
```

## 5. Tasks
- [ ] Core `Task`/`TaskResult` minimal + state machine tests.
- [ ] `workspace.yaml` v0 loader + schema.
- [ ] Use cases: create, run (headless + interactive paths), collect (diffstat, tests, summary, exit), cancel (stops session, keeps worktree).
- [ ] Session → task linkage; `task.*` events; `tasks` WS topic.
- [ ] Test-runner allowlist extension flow (config + confirm).
- [ ] REST + DTOs; UI dialog + list + result view (EN/AR).
- [ ] Headless prompt templates in claude/codex/agy manifests.
- [ ] E2E with FakeProvider scenario `quick-task` (fake agent makes a commit in the worktree).
- [ ] Manual TCs on real CLIs.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| AT-M1-12-01 | application | create quick task → worktree + session created; states | draft→assigned→running |
| AT-M1-12-02 | application | session exits 0 with a commit | result: branch, diffstat > 0, summary from last message, done |
| AT-M1-12-03 | application | session exits 1 | task failed; result still collected with exit code |
| AT-M1-12-04 | application | no commits, dirty worktree | done with warning `uncommitted_changes` and diffstat of working tree |
| IT-M1-12-05 | integration | test command from workspace.yaml runs in worktree | `testsPassed` true/false; output tail stored |
| E2E-M1-12-06 | e2e | fake `quick-task` end-to-end via dialog | card shows result |
| AT-M1-12-07 | application | cancel while running | session stopped; task cancelled; worktree kept |

### 6.2 Manual test cases (scratch repo)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-12-01 | Codex headless | 1. Quick Delegate: "add a `--version` flag to cli.js printing package version", Codex, headless | task runs without prompts (sandbox workspace-write); result: branch `orch/<id>-add-version`, diffstat, tests pass, summary | ⬜ |
| TC-M1-12-02 | Claude interactive | 1. same goal, Claude, interactive | goal sent as first message; permission prompts appear in Attention; after `/exit` or stop, result collected | ⬜ |
| TC-M1-12-03 | agy headless | 1. same goal, agy Gemini Flash | multi-turn stream; result collected | ⬜ |
| TC-M1-12-04 | Failing tests | 1. goal that breaks a test on purpose | `testsPassed:false`, output tail shows the failure; task done with warning | ⬜ |
| TC-M1-12-05 | Cancel | 1. start a long task 2. Cancel | session stopped within 5 s; worktree still present with partial work | ⬜ |
| TC-M1-12-06 | Two tasks in parallel | 1. delegate two different goals to Codex and Claude simultaneously | separate worktrees/branches; results independent; Terminals shows both | ⬜ |

## 7. Acceptance criteria
- [ ] Quick task loop works headless and interactive on ≥ 2 real providers.
- [ ] Results collected idempotently with diffstat, tests, summary, exit.
- [ ] Cancel keeps work; failures reported honestly.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Agents may not commit; result then relies on working-tree diff — acceptable, flagged.
- Interactive-mode "done" detection = user stops the session in M1; M3-03 adds agent-signalled completion (Stop hook / turn.completed).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
