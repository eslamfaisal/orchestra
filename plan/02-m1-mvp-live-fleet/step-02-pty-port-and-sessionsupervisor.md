# Step M1-02 — PTY port & SessionSupervisor

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-01 |
| Estimated effort | 3 days |
| Packages touched | `apps/daemon/src/application/sessions`, `apps/daemon/src/infrastructure/tmux`, `packages/core` (Session invariants) |
| Risk | High |
| Owner | |

## 1. Goal
One `SessionSupervisor` actor per host owns every session's runtime state: it is the only component that talks to `TmuxPort`, serialises all mutations through a mailbox, enforces `manifest.limits.maxConcurrentSessions` per provider, launches sessions in tmux windows with the adapter's `LaunchPlan`, forwards pane output to subscribers (terminal WS, recorder), detects exits/crashes, and on boot **reconciles** tmux reality with the DB (re-adopting panes tagged with `ORCH_SESSION_ID`). It replaces M0's `ProcessSessionRunner` behind the same `SessionRunnerPort`. A `PtyPort` abstraction keeps the door open for `tauri-plugin-pty` (M7).

## 2. Why
D13 (single actor), D2 (sessions outlive the daemon), C6 (concurrency within vendor allowances), G1, `12-ux-principles.md` restore budget.

## 3. Scope
### In scope
- `SessionSupervisor` (Nest provider, singleton) with a mailbox (async queue) and messages: `Start`, `Stop`, `Kill`, `Resize`, `Input`, `SubscribeOutput`, `Reconcile`, `TmuxEvent`.
- Launch: worktree path from M1-03 (or repo root), `LaunchPlan` from adapter, env injection (`ORCH_SESSION_ID`, `ORCH_HOOK_URL`, `ORCH_TASK_ID`, `TERM=xterm-256color`, allowlisted user env), `newWindow`, persist `tmux_window/tmux_pane`, transition `launching → running`.
- Output fan-out: per-pane `OutputHub` (ring buffer last 256 KB for late subscribers + live stream with backpressure).
- Exit handling: `%exit`/`window-close` → read `pane_dead_status` → `session.stopped` (code 0) or `session.crashed` (≠0) + `stderrTail` from ring buffer → adapters' `RateLimitParser` gets `ProcessExit`.
- Concurrency gate per provider (`maxConcurrentSessions`), queueing with `CONCURRENCY_LIMIT` error or wait option.
- Reconcile on boot and on control-client reconnect: list panes → match `ORCH_SESSION_ID` (`show-environment` per pane; fallback pane title) → adopt running sessions; mark DB-running-but-missing panes `crashed`; kill orphans older than N minutes (config, default: keep + flag).
- `PtyPort` (interface only + tmux-backed implementation) so terminals don't depend on tmux specifics.
- `SessionRunnerPort` implementation swap (M0's process runner remains for `fake` in tests via config).
### Out of scope (deferred)
- Prompt re-derivation and hook inbox replay → M5-05. Recording → M5-01. Resume of a stopped session (provider `--resume`) → M1-05/06 add adapter support; supervisor exposes `Resume` in M5-05.

## 4. Design
### 4.1 Domain
`Session` state machine from core. New invariant: at most one live pane per session. `Host` gains `tmuxSocket`.
### 4.2 Interfaces / contracts
```ts
export type SupervisorMsg =
  | { type:'start'; session: Session; plan: LaunchPlan; reply: Reply<Result<PaneRef, DomainError>> }
  | { type:'stop'; sessionId: string; force?: boolean; reply: Reply<Result<void, DomainError>> }
  | { type:'input'; sessionId: string; bytes: Buffer }
  | { type:'resize'; sessionId: string; cols: number; rows: number }
  | { type:'subscribe'; sessionId: string; sink: OutputSink; reply: Reply<Unsubscribe> }
  | { type:'reconcile'; reply: Reply<ReconcileReport> }
  | { type:'tmux'; event: TmuxEvent };

export interface PtyPort { write(paneId: string, bytes: Buffer): Promise<void>; resize(paneId: string, cols: number, rows: number): Promise<void>; onData(paneId: string, sink: OutputSink): Unsubscribe; }
export interface ReconcileReport { adopted: string[]; markedCrashed: string[]; orphans: PaneInfo[] }
```
Env allowlist: `PATH HOME USER SHELL LANG LC_ALL TERM COLORTERM TMPDIR SSH_AUTH_SOCK` + provider-declared (`manifest.headless`/launcher) + `ORCH_*`.
### 4.3 Data / schema changes
`sessions`: ensure `tmux_window`, `tmux_pane`, `pid`, `last_output_at`, `stderr_tail` exist (baseline has most; add migration `0003_sessions_runtime.ts` for `pid`, `last_output_at`, `stderr_tail`).
### 4.4 Infrastructure
Mailbox = single async loop; every handler awaits tmux calls; no shared state outside the actor. Timers: liveness check (pane pid alive) every 10 s; idle detection (`last_output_at`) feeds `waiting_for_input` heuristics only when adapters can't signal it (M1-11 prefers official signals).
### 4.5 API / UI surface
`SessionRunnerPort` used by `StartSession/StopSession` (M0-06). New: `POST /sessions/:id/input` (dev/debug; UI uses `/term` WS in M1-09), `POST /hosts/me/reconcile`.
### 4.6 Flow
```
StartSession → supervisor.start → gate(provider) → worktree (M1-03) → adapter.launcher.interactive/headless → preLaunchFiles written → tmux.newWindow(env+argv) → persist pane → running
boot → tmux.start → reconcile → adopt panes with ORCH_SESSION_ID → subscribers may attach
tmux exit event → classify → session.stopped|crashed → RecordEvent → gate release
```

## 5. Tasks
- [ ] Mailbox/actor utility with typed messages, replies, and a drain-on-shutdown.
- [ ] `SessionSupervisor` start/stop/kill/input/resize/subscribe handlers + `OutputHub` ring buffer.
- [ ] Env allowlist builder + `ORCH_*` injection; `preLaunchFiles` writer (atomic, inside worktree).
- [ ] Concurrency gate per provider from manifest; config override; tests.
- [ ] Exit classification + `stderrTail`; `session.stopped/crashed` events; `ProcessExit` to adapter rate-limit parser.
- [ ] Reconcile: adopt / mark crashed / orphan policy; run at boot and after `disconnected→reconnected`.
- [ ] `PtyPort` tmux implementation; `SessionRunnerPort` swap with feature flag `runner: tmux|process`.
- [ ] Migration `0003_sessions_runtime`.
- [ ] Application tests with `FakeTmux`; integration tests with real tmux + FakeProvider agent script running inside tmux.
- [ ] Debug endpoint `POST /hosts/me/reconcile` + `orch dev sessions` listing tmux vs DB.
- [ ] Docs: actor model, message list, reconcile rules.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| AT-M1-02-01 | application (FakeTmux) | start → running; exit 0 → stopped | states + events in order |
| AT-M1-02-02 | application | exit 137 | `crashed`, `stderrTail` populated |
| AT-M1-02-03 | application | 3rd session for provider with max 2 | `CONCURRENCY_LIMIT` |
| AT-M1-02-04 | application | reconcile: pane with `ORCH_SESSION_ID` of a DB session in `running` | adopted; pane missing → `crashed` |
| AT-M1-02-05 | application | 1000 concurrent messages | processed serially; no interleaved tmux calls (spy) |
| IT-M1-02-06 | integration (real tmux) | FakeProvider `hello-exit0` inside tmux | output received through hub; exit 0 |
| IT-M1-02-07 | integration | daemon restart with a live fake pane | reconcile adopts; output subscription resumes |
| UT-M1-02-08 | unit | env allowlist strips `AWS_SECRET_ACCESS_KEY`, keeps `PATH` | as specified |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-02-01 | Fake session in tmux | 1. `POST /sessions {provider:'fake', scenario:'tool-calls-stream'}` 2. `tmux -L orchestra attach` | window named `fake-<id>` shows the script output; DB row has window/pane ids | ⬜ |
| TC-M1-02-02 | Adopt after restart | 1. start fake `sleep`-style scenario 2. restart daemon 3. `GET /sessions/<id>` | still `running`; reconcile report lists it in `adopted` | ⬜ |
| TC-M1-02-03 | Crash detection | 1. `tmux -L orchestra kill-pane -t %<pane>` | session → `crashed` within 2 s; event has reason | ⬜ |
| TC-M1-02-04 | Concurrency | 1. set fake manifest max 1 2. start two | second returns 429 `CONCURRENCY_LIMIT` with clear message | ⬜ |
| TC-M1-02-05 | Env hygiene | 1. export `MY_SECRET=x` in the daemon's shell 2. start fake session printing env | `MY_SECRET` absent; `ORCH_SESSION_ID` present | ⬜ |
| TC-M1-02-06 | Orphan policy | 1. create a pane manually in the orchestra server 2. reconcile | listed as orphan in report; not killed by default | ⬜ |

## 7. Acceptance criteria
- [ ] Supervisor is the only tmux caller (depcruise rule `tmux-only-supervisor` added).
- [ ] Start/stop/crash/reconcile paths tested with FakeTmux and real tmux.
- [ ] Concurrency limits enforced from manifests.
- [ ] Env allowlist proven by test.
- [ ] Restart adopts live panes (TC-02).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- `show-environment` per pane on reconcile is O(panes) tmux calls; acceptable (< 100 panes). Pane title fallback for tmux versions where `-e` is limited.
- Idle heuristics can misclassify long tool runs as "waiting"; keep heuristics advisory until M1-11 wires official signals.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
