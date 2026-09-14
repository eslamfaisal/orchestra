# Step M3-07 — Parallel isolation

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M1-03 ∥ (may start any time after M1-03; integrates with M3-03) |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core` (allocation rules), `apps/daemon` (application/isolation, infrastructure/net, infrastructure/git, interface/http), `packages/sdk` (FakeProvider scenario), `apps/web` (Terminals/Board badges) |
| Risk | Medium |
| Owner | |

## 1. Goal
Two or more agents can work on the same repository at the same time without colliding on ports, databases, caches or lock files. Every task session is launched with `$ORCH_PORT`, `$ORCH_PORT_2`, `$ORCH_DB_SUFFIX`, `$ORCH_TASK_ID` and `$ORCH_WORKTREE` in its environment; a **port allocator** hands out leases from a configured range, persists them on the `worktrees` row, releases them when the worktree is removed, and reclaims stale leases at boot. `.orchestra/workspace.yaml#devServer` is a template that turns those variables into the project's own dev-server command, and `TASK.md` tells the agent to use them rather than the project default. A collision test with two parallel FakeProvider tasks proves that nothing is shared.

## 2. Why
- Source plan §9: "dev-server **port injection** (`$ORCH_PORT`, `$ORCH_DB_SUFFIX`) so parallel agents don't collide on ports/DBs" — this is the missing half of "worktree per task" (D2). Separate files are useless if both agents bind `:3000`.
- G2 / G4: the whole economic argument for a fleet is running several paid windows in parallel; the first real mission with two implementation tasks hits this immediately.
- R8 (resource budgets) and the mission-level `missions.maxParallelTasks` (M3-02) need a deterministic resource model, not "hope nobody starts a server".
- C6 (concurrency within vendor allowances): this step's allocator is also where per-host concurrency ceilings become observable, complementing `manifest.limits.maxConcurrentSessions` enforced by the SessionSupervisor.
- G5: leases are persisted, so a replay (M5-04) can explain why a task's dev server was on port 4312.

## 3. Scope
### In scope
- `PortAllocator` domain service + `PortLeaseRepository`; range from config, leases persisted on `worktrees` (`port`, `db_suffix` columns already exist in schema v1) plus a new `port_leases` detail table for multi-port tasks.
- Env injection into **every** task session launch (author and reviewer): `ORCH_TASK_ID`, `ORCH_PORT`, `ORCH_PORT_2..N`, `ORCH_DB_SUFFIX`, `ORCH_WORKTREE`, `ORCH_REPO`, `ORCH_MISSION_ID`.
- Liveness check before handing out a port (bind-probe on `127.0.0.1`), plus a reserved-ports deny list (daemon's own `4300`, anything in `isolation.reservedPorts`).
- `.orchestra/workspace.yaml#devServer` template expansion + `TASK.md` "Isolation" section.
- Stale-lease reclamation at boot and on worktree removal (M1-03 `WorktreeManager` hook).
- Test-run env: the `TestRunner` (M3-03) receives the same variables so a test suite that boots a server also isolates.
- UI: port/db-suffix chips on the Terminals pane header and Task drawer; `GET /isolation/leases` for debugging.
### Out of scope (deferred to …)
- Container/VM-level isolation per task — not planned for v1 (tmux + worktree + env is the model); container deployment of the *daemon* is M9-06.
- Cross-host port coordination (several daemons) — deferred to M7-05.
- Automatic database creation/teardown per suffix (the project's own scripts own that) — Orchestra only supplies the suffix.
- Filesystem sandboxing / deny lists per task — provider `sandboxProfiles` already cover this (M2-03); tightening them is M8-02.
- Resource quotas (CPU/RAM per pane) — deferred to M5 load work / M9-06.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `PortLease { id, taskId, worktreeId, port, index, state: 'held'|'released', acquiredAt, releasedAt? }`.
- `DbSuffix` value object: `_orch_<full taskId, lowercased>` — deterministic from the entire task id, 33 chars for a ULID, `[a-z0-9_]` only, so it is a legal identifier suffix in Postgres, MySQL, SQLite filenames and Redis key prefixes.
- `PortAllocator` (pure allocation rule + injected `PortProbe`):
  - `allocate(range, held: Set<number>, reserved: Set<number>, count) → Result<number[], IsolationError>`; deterministic ordering (lowest free first) so two runs of the same mission are comparable; skips reserved and held; asks `PortProbe.isFree(port)` for each candidate; `Err(NoFreePort)` when the range is exhausted.
  - `reclaim(leases, now, ttlMs, isTaskActive) → PortLease[]` — leases whose task is not active (or older than `ttlMs`) are released.
  - 100 % branch coverage.
- Rule: a task never gets a port **lazily**; allocation happens in `StartTask` before launch, so the env is complete at process start (a CLI reads env once).

### 4.2 Interfaces / contracts
```ts
// packages/core/src/isolation/ports.ts
export interface PortProbe { isFree(port: number, host?: string): Promise<boolean>; }
export interface PortLeaseRepository {
  held(): Promise<Result<PortLease[], RepoError>>;
  acquire(leases: PortLease[]): Promise<Result<void, RepoError>>;     // atomic insert, unique(port) where state='held'
  releaseByTask(taskId: string): Promise<Result<void, RepoError>>;
  all(): Promise<Result<PortLease[], RepoError>>;
}
export type IsolationError =
  | { code: 'NoFreePort'; range: [number, number]; held: number }
  | { code: 'PortRangeInvalid'; range: [number, number] }
  | { code: 'ReservedPortRequested'; port: number }
  | { code: 'LeaseConflict'; port: number; taskId: string };

// apps/daemon/src/application/isolation/task-env.ts
export interface IsolationEnv {
  ORCH_TASK_ID: string; ORCH_MISSION_ID?: string; ORCH_WORKTREE: string; ORCH_REPO: string;
  ORCH_PORT: string; ORCH_DB_SUFFIX: string;
  [extraPort: `ORCH_PORT_${number}`]: string;                          // ORCH_PORT_2 … ORCH_PORT_N
}
export interface IsolationPlan { env: IsolationEnv; ports: number[]; dbSuffix: string; devServerCommand?: string; }
export interface IsolationService {
  plan(task: { id: string; missionId?: string; worktreePath: string; repoPath: string }, portCount: number): Promise<Result<IsolationPlan, IsolationError>>;
  release(taskId: string): Promise<Result<void, RepoError>>;
}
```
`IsolationEnv` is merged into `LaunchPlan.env` by the daemon **after** the adapter builds it, and the merge is additive-only: an adapter-provided key is never overwritten (adapters own provider-required vars; Orchestra owns `ORCH_*`). The child-process env allowlist from `09-engineering-standards.md` is extended with the `ORCH_*` prefix.

### 4.3 Data / schema changes
- `worktrees.port` and `worktrees.db_suffix` already exist (schema v1) — now actually written.
- New table via migration `m3_07_port_leases`: `port_leases (id TEXT PK, task_id TEXT, worktree_id TEXT, port INT, idx INT, state TEXT, acquired_at TEXT, released_at TEXT)` with a partial unique index on `(port)` where `state = 'held'` (SQLite partial index; Postgres-compatible).
- Events: **new** `isolation.leases_acquired`, `isolation.leases_released`, `isolation.exhausted`.
- `tasks` unchanged (env is derivable from the lease rows + task id).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `PortProbe` implementation: attempt a `net.createServer().listen(port, '127.0.0.1')` and close immediately; treats `EADDRINUSE` as taken. A TOCTOU race remains possible (another process grabs the port between probe and agent start); it is accepted and handled by the agent's own retry, and the lease row makes the collision visible.
- Default range `isolation.portRange: [4400, 4499]` (well clear of the daemon's 4300), `isolation.portsPerTask: 2`, `isolation.reservedPorts: [4300]`, `isolation.leaseTtlMs: 86_400_000`.
- `workspace.yaml#devServer` template, e.g.:
  ```yaml
  devServer:
    command: "pnpm dev --port ${ORCH_PORT}"
    portEnv: PORT           # optional: also export PORT=${ORCH_PORT} for frameworks that only read PORT
    readyLog: "ready on"     # optional, used by TC-04 as a human check only
  db:
    suffixEnv: DATABASE_SUFFIX   # optional alias exported alongside ORCH_DB_SUFFIX
  ```
  Expansion is `${VAR}`-only (no shell evaluation, no command substitution) and is validated by Zod; an unknown `${VAR}` is a load-time error.
- `TASK.md` (M3-03) gains an **Isolation** section listing the variables with their concrete values and the exact dev-server command to use, plus the instruction "never hardcode a port; never write to the project's default database".
- Release hooks: `WorktreeManager.remove` (M1-03) → `IsolationService.release(taskId)`; boot sweep calls `reclaim` against live sessions.

### 4.5 API / UI surface
- `GET /isolation/leases` → `[{ taskId, port, idx, state, acquiredAt, worktreePath }]`.
- `POST /isolation/reclaim` (admin/debug) → releases stale leases, returns the count.
- `GET /isolation/config` → effective range, reserved, per-task count, free count.
- WS: `isolation` topic for lease deltas (drives the badges).
- UI: Terminals pane header (M1-09) gains a chip `:4402 · _orch_a1b2c3d4`, copyable; Task detail drawer (M3-03) shows the isolation block; Fleet health row "ports: 12/100 leased" with a warning state at ≥ 90 %.

### 4.6 Flow / sequence
```
StartTask (M3-03)
   ├─ WorktreeManager.create(...)                       ─▶ worktrees row
   ├─ IsolationService.plan(task, isolation.portsPerTask)
   │     ├─ held = PortLeaseRepository.held()
   │     ├─ PortAllocator.allocate(range, held, reserved, count) ─▶ [4402, 4403]
   │     │     └─ NoFreePort ⇒ isolation.exhausted ─▶ StartTask fails fast (task stays queued, scheduler retries)
   │     ├─ acquire(leases)  (unique index enforces the last-writer race)
   │     ├─ dbSuffix = _orch_<taskId[0..8]>
   │     └─ devServerCommand = expand(workspace.devServer.command, env)
   ├─ worktrees.port/db_suffix ← plan ─▶ isolation.leases_acquired
   ├─ LaunchPlan.env = { ...adapterEnv, ...plan.env }    (additive merge, adapter wins on conflict)
   └─ StartSession(...)  ─▶ agent sees ORCH_* at process start
TestRunner (M3-03) ─▶ same env
task ends ─▶ CollectTaskResult ─▶ WorktreeManager.remove ─▶ IsolationService.release ─▶ isolation.leases_released
daemon boot ─▶ reclaim(leases, now, ttl, isTaskActive) ─▶ release orphans ─▶ log count
```

### 4.7 Review reconciliation contract (2026-09-15)
Reserve database/cache namespaces using the full task ID with a uniqueness constraint. Validate the complete identifier against the target engine length limit (including the application prefix). A dialect with shorter limits uses a sufficiently long hash of the entire ID with collision detection and a persisted mapping. ORCH_DATABASE_SUFFIX and cache prefixes are effective only when the app/test harness honors them; require a configured isolation smoke test. Otherwise mark external-service isolation unsupported and serialize those tasks or require an explicit shared-service policy.

## 5. Tasks
- [ ] `PortLease`, `DbSuffix`, `PortAllocator` (`allocate`, `reclaim`) in `packages/core/src/isolation/` with 100 % branch tests.
- [ ] Migration `m3_07_port_leases` (+ partial unique index); `SqlitePortLeaseRepository` + in-memory twin.
- [ ] `PortProbe` implementation (bind-and-close on `127.0.0.1`) with a fake for tests.
- [ ] `IsolationService` (`plan`, `release`) as one injectable application service; `isolation.*` events.
- [ ] Extend `.orchestra/workspace.yaml` Zod schema (M3-03) with `devServer` and `db` blocks; `${VAR}`-only expander with unknown-var errors.
- [ ] Merge `IsolationEnv` into `LaunchPlan.env` in the session launch path (additive; adapter keys win) and extend the child-process env allowlist with `ORCH_*`.
- [ ] Pass the same env to `TestRunner` runs.
- [ ] `TASK.md` **Isolation** section renderer.
- [ ] Release hook on `WorktreeManager.remove`; boot-time reclamation sweep with a log line.
- [ ] HTTP `IsolationController` (`GET /isolation/leases|config`, `POST /isolation/reclaim`) + OpenAPI; WS `isolation` topic.
- [ ] Web: pane-header chip, task-drawer isolation block, Fleet "ports leased" health row.
- [ ] FakeProvider scenario `dev-server.yaml`: binds `$ORCH_PORT`, writes `$ORCH_DB_SUFFIX` to a file, stays up, exits on signal.
- [ ] Collision test harness: run two `dev-server.yaml` tasks in parallel on the same repo and assert distinct ports/suffixes and both servers reachable.
- [ ] Config keys `isolation.portRange`, `isolation.portsPerTask`, `isolation.reservedPorts`, `isolation.leaseTtlMs`; docs + `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-07-01 | unit | `allocate` with held `{4400,4401}`, reserved `{4402}`, count 2 | `[4403, 4404]`; deterministic lowest-free-first |
| UT-M3-07-02 | unit | `allocate` when the range is exhausted | `Err(NoFreePort)` with range and held count; no partial allocation |
| UT-M3-07-03 | unit | `DbSuffix` for ULIDs incl. upper-case and leading digits | always `[a-z0-9_]{1,16}`, prefixed `_orch_`, stable for the same task id |
| UT-M3-07-04 | unit | `reclaim` with an active task, an inactive task, and an expired lease | only the latter two released; 100 % branch |
| AT-M3-07-01 | application | two `plan()` calls racing for the last free port (same repository, concurrent) | one succeeds, the other gets `LeaseConflict` or the next free port; unique index never violated |
| AT-M3-07-02 | application | adapter env contains `ORCH_PORT` already | adapter value wins; a warning is logged; no silent overwrite |
| AT-M3-07-03 | application | `workspace.yaml#devServer.command` with `${ORCH_NOPE}` | load-time Zod/expansion error; task start blocked with a clear message; no session launched |
| AT-M3-07-04 | application | task ends ⇒ release; boot with an orphaned `held` lease | lease released on removal; orphan reclaimed at boot and logged |
| IT-M3-07-01 | integration | **collision test**: two FakeProvider `dev-server` tasks in parallel on one repo | distinct ports, distinct db suffixes, both servers answer on their own port, neither errors `EADDRINUSE` |
| IT-M3-07-02 | integration | port taken by an unrelated process inside the range | probe skips it; allocation succeeds with the next port; the skipped port is never leased |
| E2E-M3-07-01 | e2e (Playwright) | Terminals pane headers during a two-task mission | each pane shows a different port chip and suffix; `GET /isolation/leases` matches the chips |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-07-01 | Env reaches a real CLI | 1. Start a task on Claude Code 2. In its pane run `env \| grep ORCH_` | All of `ORCH_TASK_ID`, `ORCH_PORT`, `ORCH_DB_SUFFIX`, `ORCH_WORKTREE`, `ORCH_REPO` are present with the values shown in the task drawer | ⬜ |
| TC-M3-07-02 | Two real agents, two dev servers | 1. Scratch repo with `devServer.command: "pnpm dev --port ${ORCH_PORT}"` 2. Run two implementation tasks in parallel (Claude + Codex) 3. Ask each to start the dev server | Both start; `curl 127.0.0.1:<port1>` and `<port2>` both answer; neither logs `EADDRINUSE`; chips in Terminals match | ⬜ |
| TC-M3-07-03 | Database suffix respected | 1. Scratch repo whose test script appends `$ORCH_DB_SUFFIX` to the DB name 2. Run two test-gen tasks in parallel | Two distinct database files/schemas created; no "database is locked" / cross-contamination; both suites pass | ⬜ |
| TC-M3-07-04 | Range exhaustion (negative) | 1. Set `isolation.portRange: [4400, 4401]`, `portsPerTask: 1` 2. Start three tasks | Two start; the third stays queued with reason `NoFreePort`; `isolation.exhausted` event; Fleet shows the ports warning; no crash and no session launched without a port | ⬜ |
| TC-M3-07-05 | Lease released on cleanup | 1. Finish a task and let the worktree be removed 2. `GET /isolation/leases` | The task's leases are `released`; the port is reused by the next task | ⬜ |
| TC-M3-07-06 | Restart with live agents (resilience) | 1. Two tasks running with dev servers 2. `kill -9` the daemon 3. Restart | Agents keep running (tmux); after re-attach the leases are still `held` (not reclaimed, because the sessions are alive); chips reappear with the same ports | ⬜ |
| TC-M3-07-07 | Orphan reclamation | 1. Stop the daemon 2. `tmux kill-session -t orchestra` 3. Start the daemon | Boot sweep releases the orphaned leases and logs the count; `GET /isolation/leases` shows none held | ⬜ |
| TC-M3-07-08 | Foreign process squats a port (negative) | 1. `python3 -m http.server 4403` 2. Start a task | The allocator skips 4403; the task gets another port; no failure surfaced to the user | ⬜ |

### 6.3 Review regression scenarios
- [ ] Create 10,000 IDs with identical timestamp: namespaces unique.
- [ ] Force a hash collision: reservation fails or allocates a checked alternate.
- [ ] Application ignores env suffix: concurrent shared-service execution is blocked.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] Every task session (author, reviewer, retry) launches with the complete `ORCH_*` env set at process start (TC-M3-07-01).
- [ ] Two parallel tasks on one repo never share a port or a db suffix (IT-M3-07-01, TC-M3-07-02, TC-M3-07-03).
- [ ] `PortAllocator` has 100 % branch coverage; allocation is deterministic and never partial.
- [ ] Leases are persisted, released on worktree removal, and reclaimed at boot without touching live sessions (TC-M3-07-05, -06, -07).
- [ ] Range exhaustion degrades to "task stays queued" with a visible reason — never a silent launch without isolation (TC-M3-07-04).
- [ ] Adapter-provided env is never overwritten by Orchestra (AT-M3-07-02).
- [ ] `workspace.yaml#devServer` expansion is `${VAR}`-only with no shell evaluation, and unknown variables fail loudly (AT-M3-07-03).
- [ ] All TC-M3-07-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations.

## 8. Risks / open questions
- **TOCTOU on ports** is unavoidable without binding the socket ourselves and passing the fd (which no vendor CLI supports). The probe + lease + agent retry is the accepted mitigation; the lease row makes any collision diagnosable.
- Projects that hardcode ports in config files (`vite.config.ts`, `docker-compose.yml`) will ignore `$ORCH_PORT`. `TASK.md` instructs the agent to use the variable, but this is agent compliance, not enforcement — measure in TC-02 and consider a workspace lint in M8.
- Docker-based dev servers publish host ports themselves; `${ORCH_PORT}` must be threaded into the compose command by the workspace template. Document the pattern; do not special-case Docker in code.
- `portsPerTask: 2` is a guess (app + API). Projects needing more should raise it in config; per-task-type port counts are a candidate for M8-01 layered settings.
- The db suffix is only useful if the project's scripts read it; Orchestra deliberately does not create or drop databases (that would need credentials and is out of scope for C2/C3 hygiene).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
