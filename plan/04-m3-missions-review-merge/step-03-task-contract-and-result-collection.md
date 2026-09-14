# Step M3-03 — Task contract & result collection

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-02 |
| Estimated effort | 2 days |
| Packages touched | `packages/core` (task), `packages/sdk` (FakeProvider scenarios), `apps/daemon` (application/tasks, infrastructure/git, infrastructure/exec, infrastructure/fs, interface/http, interface/mcp), `apps/web` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step a task is a **contract, not a chat**. The scheduler (M3-02) turns a queued task into a frozen `TaskSpec`, creates its worktree and branch off the mission integration branch, launches the assigned provider with that spec rendered into `TASK.md`, and — when the session stops — a `CollectTaskResult` use case reconstructs a `TaskResult` from the worktree *without asking the agent anything*: branch name and head sha, `git diff --stat <base>..<branch>`, the workspace test command's exit code and tail, and a summary taken from `RESULT.md` or the agent's final assistant message. The result is persisted in `task_results`, emitted as `task.result_submitted`, returned verbatim to the Lead through MCP `collect()`, and shown in a Task detail drawer. A task that changed nothing, failed its tests, or produced an unparsable result gets a `TaskResult` with the corresponding `verdict` — never a silent success.

## 2. Why
- Source plan §9 defines the task contract `TaskSpec → TaskResult`; every later step consumes it: reviewers read the diff (M3-04), the Review UI renders it (M3-05), PR bodies are generated from it (M3-06), the learning loop scores it (M8-06).
- D3: the Lead may *describe* work, but the daemon decides what "done" means. Result collection is deterministic file/git/process observation, not an LLM self-report (R11).
- G5 (total recall): branch, diffstat, test status, usage and summary are recorded per task, linked to the session and the recording.
- G3: a reviewer in M3-04 needs a stable, reproducible artifact (base..branch) to review; without a frozen base ref, cross-vendor review is not reproducible.
- C7 (no screen-scraping for state): the summary comes from `RESULT.md` on disk or from a normalized `message` (telemetry plane, M1-08) — never from regexing PTY bytes.
- C10: `TaskResult.usage` makes spend visible per task before any merge is offered.

## 3. Scope
### In scope
- `TaskSpec` / `TaskResult` value objects in `packages/core/src/task/` + task state machine transitions `assigned → running → review_pending` and the failure edges.
- Use cases `StartTask` (called by `MissionScheduler`), `CollectTaskResult`, `RetryTask`, `CancelTask`.
- Worktree + branch per task off the mission integration branch (`WorktreeManager` from M1-03).
- `TASK.md` rendering into the worktree, `RESULT.md` convention documented in it.
- `WorkspaceConfig` reader for `.orchestra/workspace.yaml` (`test`, `install`, `devServer` keys — `devServer` consumed in M3-07).
- `TestRunner` port + subprocess implementation with timeout, output cap and exit-code mapping.
- `task_results` table + migration; `GET /tasks/:id/result`; MCP `collect()` returning the real `TaskResult`; Task detail drawer in the Board (M2-07).
### Out of scope (deferred to …)
- Reviewer assignment, review rounds and findings — deferred to M3-04.
- Diff rendering, inline comments, approve/merge — deferred to M3-05.
- PR creation from the result — deferred to M3-06.
- Port/DB env injection for tasks that boot a dev server — deferred to M3-07.
- Per-task budget enforcement and quota reserves — deferred to M4-04.
- Outcome scoring from results (`outcomes` table writes) — deferred to M8-06.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `TaskSpec` is immutable once the task leaves `draft`; it is hashed (`specHash`, sha256 of the canonical JSON) and stored so a retry can prove it ran the same contract.
- `TaskResult.verdict` is derived by a pure rule, not by the agent:
  - `no_changes` — diffstat has 0 files.
  - `failed` — session exit code ≠ 0 **or** the task was cancelled/timed out.
  - `tests_failed` — changes exist, test command ran, exit ≠ 0.
  - `needs_review` — changes exist and (tests passed **or** no test command configured).
  - `blocked` — the session ended while an `AgentPrompt` was still open (agent stopped waiting for a human).
- `summarySource: 'result_md' | 'final_message' | 'none'`. `none` never blocks collection; it degrades the verdict reason, not the verdict.
- Rule `nextTaskState(result)`: `needs_review → review_pending`; `tests_failed|no_changes|failed → failed` (retryable); `blocked → blocked`. 100 % branch coverage.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/task/spec.ts  (source plan §9)
export interface TaskSpec {
  id: string;                       // ULID, == tasks.id
  missionId?: string;               // absent for Quick Delegate (M2-06)
  planTaskId?: string; stepId?: string;
  taskType: TaskType; role: RoleName;
  goal: string;                     // one paragraph, imperative
  context: { repoPath: string; baseRef: string; files?: string[]; notes?: string[]; relatedTaskIds?: string[] };
  acceptance: string[];             // checkable statements, rendered into TASK.md
  constraints: string[];            // e.g. "do not touch packages/core", "no new deps"
  budget: { maxTurns?: number; maxMinutes: number; maxUsdEstimate?: number };
  requiredCapabilities: CapabilityFlag[];
  skills: string[];                 // skill ids (installed in M8-04; ignored before that)
  worktree: { path: string; branch: string; baseBranch: string };
  specHash: string;
}

// packages/core/src/task/result.ts
export type TaskVerdict = 'needs_review' | 'tests_failed' | 'no_changes' | 'failed' | 'blocked';
export interface DiffStat { filesChanged: number; insertions: number; deletions: number;
  files: { path: string; insertions: number; deletions: number; binary: boolean }[]; truncated: boolean; }
export interface TestReport { command: string | null; exitCode: number | null; durationMs: number;
  passed: boolean | null; tail: string; timedOut: boolean; }
export interface TaskResult {
  taskId: string; specHash: string; branch: string; headSha: string; baseSha: string;
  diffStat: DiffStat; summary: string; summarySource: 'result_md' | 'final_message' | 'none';
  tests: TestReport; artifacts: { path: string; kind: 'file' | 'log' | 'recording' }[];
  usage: { inputTokens?: number; outputTokens?: number; costEstimateUsd?: number; wallClockMs: number; confidence: 'official' | 'estimate' };
  verdict: TaskVerdict; collectedAt: string;
}

// apps/daemon/src/application/tasks/ports.ts
export interface TaskResultRepository { add(r: TaskResult): Promise<Result<void, RepoError>>;
  latest(taskId: string): Promise<Result<TaskResult | null, RepoError>>; list(taskId: string): Promise<Result<TaskResult[], RepoError>>; }
export interface DiffPort { stat(repoPath: string, base: string, head: string): Promise<Result<DiffStat, GitError>>;
  revParse(repoPath: string, ref: string): Promise<Result<string, GitError>>; }
export interface TestRunner { run(cwd: string, command: string, env: Record<string,string>, timeoutMs: number): Promise<Result<TestReport, ExecError>>; }
export interface WorkspaceConfigPort { read(repoPath: string): Promise<Result<WorkspaceConfig, ConfigError>>; }
export interface WorkspaceConfig { test?: string; install?: string; devServer?: { command: string; portEnv?: string }; reviewCheckout?: string; }

export type TaskError =
  | { code: 'TaskStateViolation'; from: TaskState; event: string }
  | { code: 'SpecFrozen'; taskId: string }
  | { code: 'WorktreeUnavailable'; taskId: string; cause: string }
  | { code: 'ResultAlreadyCollected'; taskId: string; specHash: string }
  | { code: 'TestCommandMissing'; repoPath: string };
```
`collect()` (MCP, M2-05) returns `{ taskId, state, result: TaskResult | null, reason? }` — the same object the HTTP endpoint returns; no second shape.

### 4.3 Data / schema changes
- `task_results` (schema v1: `id, task_id, branch, diff_stat_json, summary, tests_passed, artifacts_json, usage_json, verdict`) + migration `m3_03_task_results_ext`: `spec_hash TEXT`, `head_sha TEXT`, `base_sha TEXT`, `summary_source TEXT`, `tests_json TEXT` (full `TestReport`), `attempt INT DEFAULT 1`, `collected_at TEXT`; unique `(task_id, attempt)`.
- `tasks` + migration `m3_03_tasks_spec`: `spec_json TEXT`, `spec_hash TEXT`, `attempt INT DEFAULT 1`, `started_at TEXT`, `finished_at TEXT`, `failure_reason TEXT`.
- Events: `task.started`, `task.progress`, `task.result_submitted` (catalog) **+ new** `task.collection_failed`. Payloads Zod-validated per type (M0-05). Ingestion idempotent on `(taskId, attempt)`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `StartTask`: `WorktreeManager.create({ repoPath, branch: 'orchestra/task-<shortId>', baseRef: mission.integrationBranch })` → `.orchestra/worktrees/<taskId>/`; record `base_sha = revParse(baseRef)` **before** the agent runs (the integration branch may move underneath).
- `TASK.md` written to the worktree root by `TaskFs` (never committed — `.orchestra/worktrees/` is gitignored, and `TASK.md`/`RESULT.md` are added to `.git/info/exclude` of the worktree so the agent's own `git add -A` cannot commit them).
- Launch: `Launcher.headless(spec)` when `tasks.mode = headless`, else `Launcher.interactive(spec)` with the initial message `Read TASK.md in this worktree and complete it. Write RESULT.md when done.` delivered through `PaneController.sendCommand`. Argv comes from the adapter only (C1, C8).
- Collection trigger: `session.stopped | session.crashed` for a session with `task_id` → `CollectTaskResult`. Also triggered by `budget.maxMinutes` timeout (supervisor stops the session with reason `budget_timeout`).
- Test run: command from `.orchestra/workspace.yaml#test`; executed in the **worktree** cwd with an explicit env allowlist (`PATH`, `HOME`, `LANG`, `TERM`, plus M3-07's `$ORCH_*`); timeout `tasks.testTimeoutMs` (default 600 000); stdout+stderr captured, last 8 KB kept as `tail`, full log written to `~/.orchestra/logs/tasks/<taskId>-tests.log` and referenced as an artifact.
- Diffstat via `git diff --numstat --shortstat <baseSha>..<headSha>` in the worktree (`simple-git`); > 500 files ⇒ `truncated: true`, top 500 by churn kept.
- Usage: from the session's normalized usage events (M1-08) when the provider emits them (`confidence: 'official'`), else wall-clock only (`confidence: 'estimate'`) — truth labelling per UX principle 4.

### 4.5 API / UI surface
- `GET /tasks/:id` → task + spec + latest result. `GET /tasks/:id/result?attempt=` → `TaskResult`.
- `POST /tasks/:id/collect` — manual re-collection (idempotent; returns the existing result unless `force=true` and the head sha changed). Honours `Idempotency-Key`.
- `POST /tasks/:id/retry` `{ reason }` → new attempt: same `specHash`, fresh worktree, `attempt+1`.
- `POST /tasks/:id/cancel` → stops session, collects whatever exists with verdict `failed`.
- WS: `task.<id>` (state, progress, result), `mission.<id>` deltas unchanged.
- UI: Board card (M2-07) gains a verdict chip (`needs review` / `tests failed` / `no changes` / `failed` / `blocked`) and a **Task detail drawer**: spec (goal, acceptance, constraints), branch + copy button, diffstat bars, test tail in a collapsible `<pre>`, summary markdown, usage row with confidence label, buttons *Retry* / *Cancel* / *Open worktree path*. States: loading · collected · collecting (spinner with "running tests…") · collection failed (with error code + Retry collection).

### 4.6 Flow / sequence
```
MissionScheduler(readyTask) ─▶ StartTask
   ├─ AssignmentEngine.decide(taskType)  (M2-04)   ─▶ routing_decisions row
   ├─ WorktreeManager.create(branch off integrationBranch) ─▶ worktrees row (+ base_sha)
   ├─ buildTaskSpec() ─▶ freeze + specHash ─▶ tasks.spec_json
   ├─ TaskFs.writeTaskMd() ─▶ <worktree>/TASK.md
   └─ StartSession(provider, model, cwd=worktree)  ─▶ task.started (state running)
agent works … session ends (exit 0 | non-zero | budget timeout | cancel)
   ▼
CollectTaskResult(taskId)
   ├─ headSha = revParse(branch) ; DiffPort.stat(baseSha..headSha)
   ├─ WorkspaceConfigPort.read(repo).test ? TestRunner.run(worktree) : TestReport{command:null}
   ├─ summary = RESULT.md ?? last assistant message (M1-08 messages) ?? ''
   ├─ usage from session usage events
   ├─ verdict = deriveVerdict(diff, tests, exit, openPrompts)
   └─ task_results row ─▶ task.result_submitted ─▶ nextTaskState ─▶ (review_pending → M3-04)
Lead ── MCP collect{taskId} ─▶ same TaskResult (or {state, reason} while running)
```

## 5. Tasks
- [ ] `TaskSpec`, `TaskResult`, `DiffStat`, `TestReport` value objects + `specHash` canonicalisation in `packages/core/src/task/`.
- [ ] `deriveVerdict` + `nextTaskState` rules with 100 % branch tests.
- [ ] Migrations `m3_03_tasks_spec`, `m3_03_task_results_ext`; `SqliteTaskResultRepository` + in-memory twin.
- [ ] `WorkspaceConfigPort` + Zod schema for `.orchestra/workspace.yaml` (`test`, `install`, `devServer`, `reviewCheckout`) with hot reload reusing the M2-01 watcher.
- [ ] `DiffPort` (simple-git) with numstat parsing, binary detection, truncation.
- [ ] `TestRunner` (node `spawn`, env allowlist, timeout kill-tree, 8 KB tail, full log to disk).
- [ ] `TaskFs`: `TASK.md` renderer (goal, acceptance checklist, constraints, repo facts, RESULT.md convention) + worktree `.git/info/exclude` entries.
- [ ] Use case `StartTask` (one class) wiring assignment → worktree → spec → session.
- [ ] Use case `CollectTaskResult` (idempotent by `(taskId, attempt, headSha)`).
- [ ] Use cases `RetryTask`, `CancelTask`; supervisor hook for `budget.maxMinutes` timeout.
- [ ] Subscribe collection to `session.stopped|session.crashed` on the event bus; guard against double collection.
- [ ] MCP `collect()` returns the real `TaskResult`; `status()` includes `verdict`.
- [ ] HTTP `TasksController` additions + DTOs + OpenAPI; WS `task.<id>` topic.
- [ ] Web: Task detail drawer + verdict chips on Board cards.
- [ ] FakeProvider scenarios: `task-happy.yaml` (edits a file, writes RESULT.md, exits 0), `task-no-changes.yaml`, `task-tests-fail.yaml`, `task-blocked.yaml` (opens a prompt then exits).
- [ ] Config keys `tasks.mode`, `tasks.testTimeoutMs`, `tasks.maxRetries` (default 1); docs + `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-03-01 | unit | `deriveVerdict` over the matrix (diff × tests × exit × openPrompts) | every combination maps to exactly one verdict; 100 % branch |
| UT-M3-03-02 | unit | `specHash` stable across key order / whitespace; changes when `acceptance` changes | equal / equal / different |
| UT-M3-03-03 | unit | numstat parser: binary files, renames, 0-line changes, 600-file diff | binary flagged, renames counted once, `truncated: true` with 500 entries |
| UT-M3-03-04 | unit | `nextTaskState` for each verdict | `review_pending` / `failed` / `blocked` per rule; illegal source state ⇒ `TaskStateViolation` |
| AT-M3-03-01 | application | `CollectTaskResult` called twice for the same attempt and head sha | one `task_results` row; second returns `Ok` with the same result (idempotent), no second event |
| AT-M3-03-02 | application | collection when `workspace.yaml` has no `test` key | `TestReport{command:null, passed:null}`, verdict `needs_review`, no `TestCommandMissing` error surfaced to the Lead |
| AT-M3-03-03 | application | test command exceeds timeout | `timedOut: true`, exit `null`, verdict `tests_failed`, kill-tree leaves no orphan process |
| AT-M3-03-04 | application | `RetryTask` after `tests_failed` | attempt 2, same `specHash`, new worktree, previous result retained |
| CT-M3-03-01 | contract | FakeProvider `task-happy` through `StartTask`+`CollectTaskResult` | branch exists, diffstat 1 file, summary from `RESULT.md`, verdict `needs_review` |
| IT-M3-03-01 | integration | real git scratch repo: base moves after task start | diff is computed against the frozen `base_sha`, not the moved branch |
| IT-M3-03-02 | integration | daemon killed between session stop and collection; restart | collection runs once on restart (backlog replay), exactly one `task.result_submitted` |
| E2E-M3-03-01 | e2e (Playwright) | Board card → detail drawer for a FakeProvider task | diffstat, test tail, summary and usage-with-confidence render; Retry creates attempt 2 |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-03-01 | Codex implements a small task | 1. Scratch repo with `workspace.yaml#test: pnpm test` 2. Mission `bugfix`, approve plan 3. Let the `fix` task run on Codex | Worktree `.orchestra/worktrees/<taskId>` exists on branch `orchestra/task-<id>` off the integration branch; `TASK.md` present; after the session ends the drawer shows diffstat, `pnpm test` exit 0, summary text | ⬜ |
| TC-M3-03-02 | Summary from RESULT.md wins | 1. Same task 2. Confirm the agent wrote `RESULT.md` | Drawer `summarySource = result_md`; the rendered summary matches the file byte-for-byte (first 4 KB) | ⬜ |
| TC-M3-03-03 | Summary fallback | 1. Delete `RESULT.md` from the worktree 2. `POST /tasks/:id/collect?force=true` | `summarySource = final_message`; summary equals the agent's last assistant message from Chat; no error | ⬜ |
| TC-M3-03-04 | Failing tests (negative) | 1. Seed the repo so the task's change breaks one test 2. Run the task on Claude Code | Verdict chip `tests failed`; test tail shows the failing assertion; task state `failed`; mission does **not** advance to review | ⬜ |
| TC-M3-03-05 | No changes (negative) | 1. Delegate a task whose goal is already satisfied | Verdict `no changes`; diffstat 0 files; `task.result_submitted` emitted with verdict `no_changes`; drawer explains it; Retry offered | ⬜ |
| TC-M3-03-06 | Budget timeout | 1. Set `budget.maxMinutes: 1` on a long task 2. Start it | Session stopped at ~60 s with reason `budget_timeout`; result collected with verdict `failed`; partial diff still recorded | ⬜ |
| TC-M3-03-07 | Restart during collection (resilience) | 1. Start a task 2. `kill -9` the daemon while the test command is running 3. Restart | On restart the task is re-collected once; exactly one `task_results` row for the attempt; no orphaned test process (`ps` clean) | ⬜ |
| TC-M3-03-08 | Lead collects | 1. In the Lead's Chat ask it to call `collect` for a finished task | Tool result contains branch, diffstat numbers, verdict and summary identical to `GET /tasks/:id/result`; the call appears in `audit_log` with `actor.kind = agent` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `TaskSpec` is frozen at start and its hash is stored; a retry proves the same contract ran (AT-M3-03-04).
- [ ] `deriveVerdict` and `nextTaskState` have 100 % branch coverage in `packages/core`.
- [ ] Collection is idempotent and survives a daemon restart (AT-M3-03-01, IT-M3-03-02, TC-M3-03-07).
- [ ] Diffs are computed against the frozen base sha, never a moving ref (IT-M3-03-01).
- [ ] The test command runs with an env allowlist and a hard timeout; no orphan processes after kill (AT-M3-03-03).
- [ ] Every collected result carries usage with an explicit `official`/`estimate` confidence label.
- [ ] `collect()` over MCP and `GET /tasks/:id/result` return the identical object (TC-M3-03-08).
- [ ] All TC-M3-03-xx pass and are recorded in this file and `PROGRESS.md`.
- [ ] No new lint / dependency-cruiser violations; `packages/core` still imports nothing.

## 8. Risks / open questions
- **`RESULT.md` is a convention, not a vendor feature.** Agents may ignore it; the fallback chain must never be the reason a task fails. Measure adoption per provider in TC runs and consider adding it to the instruction fragment composition (M8-08).
- Claude Code may report usage in its stream-json/session JSONL and Codex in `turn.completed`; field names and availability differ per version — treat missing usage as `estimate`. (verify against Claude Code and Codex docs at step start)
- A task's agent may commit `TASK.md`/`RESULT.md` despite `.git/info/exclude` (e.g. `git add -f`); collection must tolerate it and the PR body (M3-06) should not include them — consider stripping them in M3-06.
- Monorepo test commands can be very slow; `workspace.yaml#test` may later need a per-task-type override (candidate for M8-01 layered settings).
- If the agent leaves uncommitted work in the worktree, should collection commit it? Decision here: **no** — record `dirty: true` as an artifact note and let the verdict be based on committed work only; revisit if real runs show agents routinely forgetting to commit.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
