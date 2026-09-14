# Step M1-02 — PTY port & SessionSupervisor

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-01, M0-04 (daemon single-instance lock, ADR-020) |
| Estimated effort | 4 days |
| Packages touched | `apps/daemon/src/application/sessions`, `apps/daemon/src/infrastructure/tmux`, `packages/sdk/bin` (`orch-run`), `packages/core` (Session invariants) |
| Risk | High |
| Owner | |

## 1. Goal
One `SessionSupervisor` actor per host owns every session's runtime state: it is the only component that talks to `TmuxPort`, serialises all mutations through a mailbox, enforces `manifest.limits.maxConcurrentSessions` per provider, launches sessions in tmux windows with the adapter's `LaunchPlan` wrapped by `orch-run`, forwards pane output to subscribers (terminal WS, recorder), classifies **agent-process exits** from a durably recorded exit status, and on boot **reconciles** tmux reality with the DB (re-adopting panes by the pane user option `@orch_session_id`). It replaces M0's `ProcessSessionRunner` behind the same `SessionRunnerPort`. A `PtyPort` abstraction keeps the door open for `tauri-plugin-pty` (M7).

**Precondition asserted at start:** the daemon single-instance lock from M0-04 (ADR-020 — one daemon owner per data directory and tmux namespace) must be **held by this process** before the supervisor spawns its mailbox or touches tmux. Without the lock the supervisor refuses to start (`SUPERVISOR_NOT_OWNER`) rather than racing a second daemon over the same panes, DB and `~/.orchestra/sessions/`.

**Two failure modes are never conflated** (see M1-01): a **control-client disconnect** (`controlClientExited`/`disconnected`) means our `tmux -CC` client died — sessions are untouched, the supervisor reconnects and re-reconciles; an **agent-process termination** (`paneExited`) means the process in the pane ended and needs exit classification.

## 2. Why
D13 (single actor), D2 (sessions outlive the daemon), C6 (concurrency within vendor allowances), G1, `12-ux-principles.md` restore budget.

## 3. Scope
### In scope
- Single-instance ownership assertion at construction: hold the M0-04 daemon lock for `$ORCH_DATA_DIR` (ADR-020) or fail fast with `SUPERVISOR_NOT_OWNER`; release on shutdown. The lock record carries the tmux socket name so a second daemon can report *who* owns it.
- `SessionSupervisor` (Nest provider, singleton) with a mailbox (async queue) and messages: `Start`, `Stop`, `Kill`, `Resize`, `Input`, `SubscribeOutput`, `Reconcile`, `TmuxEvent`.
- Launch: worktree path from M1-03 (or repo root), `LaunchPlan` from adapter, env injection (`ORCH_SESSION_ID`, `ORCH_HOOK_URL`, `ORCH_TASK_ID`, `TERM=xterm-256color`, allowlisted user env), `newWindow` running **`orch-run <sessionId> -- <adapter argv>`**, `set-option -w remain-on-exit on`, `set-option -p @orch_session_id <sessionId>`, pane title set to `orch:<sessionId>`, persist `tmux_window/tmux_pane`, transition `launching → running`.
- Output fan-out: per-pane `OutputHub` (ring buffer last 256 KB for late subscribers + live stream with backpressure).
- **Exit handling (rewritten — see §4.6):** primary evidence is the `orch-run` wrapper's `exit.json`; cross-check is `#{pane_dead_status}` read from the **retained** pane before cleanup; neither available ⇒ `session.crashed` with `exitUnknown: true`. Never a guessed `0`.
- Concurrency gate per provider (`maxConcurrentSessions`), queueing with `CONCURRENCY_LIMIT` error or wait option.
- Reconcile on boot and on control-client reconnect: list panes with `-F '#{@orch_session_id}'` → adopt by **pane user option (primary)**, **pane title `orch:<sid>` (secondary)**, **DB `tmux_pane` id (tertiary, only if the pane is alive and carries neither marker)** → adopt running sessions; DB-running-but-missing panes are resolved against `exit.json` before being marked `stopped`/`crashed`; kill orphans older than N minutes (config, default: keep + flag). `show-environment` is **not** an adoption mechanism (session/global scope — M1-01 `EM-TMUX-04`).
- Dead-pane reaper: panes with `#{pane_dead}=1` whose status has been read and recorded are `killPane`d; a dead pane seen twice without a matching session is reported as an orphan.
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
export interface ReconcileReport { adopted: { sessionId: string; via: 'pane-option'|'pane-title'|'db-pane-id' }[]; resolvedExited: string[]; markedCrashedUnknown: string[]; orphans: PaneInfo[] }

/** Durable exit record written by the wrapper, read by the supervisor. */
export interface ExitRecord { sessionId: string; pid: number; argv: string[]; startedAt: string; endedAt: string; exitCode: number | null; signal: string | null; wrapperVersion: string }

export type ExitEvidence =
  | { kind: 'wrapper';        exitCode: number | null; signal: string | null; endedAt: string }   // exit.json  — primary
  | { kind: 'pane-dead';      exitCode: number;        signal: number | null; readAt: string }    // #{pane_dead_status} — cross-check
  | { kind: 'unknown';        reason: 'no-exit-file'|'pane-gone'|'both-missing'|'unreadable' };
```
**Exit evidence rules (normative):**
1. `wrapper` present ⇒ it wins. `exitCode === 0 && signal === null` ⇒ `session.stopped`; otherwise `session.crashed` with `exitCode`/`signal`.
2. `pane-dead` present as well ⇒ compare. Agreement is recorded as `exitEvidence: 'wrapper+pane'`. **Disagreement is not resolved silently**: the wrapper value is used, `exitMismatch: true` is set on the event, and a Doctor signal (M6-02) is raised — a mismatch means the wrapper or the pinned tmux behaviour changed.
3. `wrapper` missing, `pane-dead` present ⇒ use it, `exitEvidence: 'pane'`, `exitConfidence: 'cross-check-only'`.
4. Neither ⇒ `session.crashed` with `exitCode: null`, `signal: null`, **`exitUnknown: true`**, `reason` from the `unknown` evidence. The UI shows "ended — exit status unknown". No component may substitute `0`, and `exitUnknown` sessions never count as a successful run for a task result (M3-03).

**Wrapper contract (`orch-run`, bundled at `packages/sdk/bin/orch-run.mjs`, no deps):**
```
orch-run <sessionId> -- <argv…>
```
- Execs the child with the pane's stdio (so the TUI is unaffected: raw mode, signals and window-size changes pass through; the wrapper installs no handlers other than the ones it forwards).
- On child exit — including on signal — writes `~/.orchestra/sessions/<sid>/exit.json` **durably**: write `exit.json.tmp` in the same directory, `fsync` the file, `rename()` over `exit.json`, `fsync` the directory. Then exits with the child's code (or re-raises the child's signal) so `#{pane_dead_status}` still carries a usable cross-check.
- `~/.orchestra/sessions/<sid>/` is created `0700` at launch and also holds `launch.json` (argv, cwd, worktree, provider, CLI version) so an adopted session can be described after a daemon restart.
- It is chosen as **primary** precisely because it survives what `pane_dead_status` does not: a pane killed or destroyed, the tmux server restarted, or the daemon absent at the moment of exit. `pane_dead_status` remains the cross-check because the wrapper itself can be `SIGKILL`ed.
- Wrapper failure is not fatal to the session: if `orch-run` cannot create its directory it logs to stderr and still execs the child (evidence degrades to `pane-dead`).
Env allowlist: `PATH HOME USER SHELL LANG LC_ALL TERM COLORTERM TMPDIR SSH_AUTH_SOCK` + provider-declared (`manifest.headless`/launcher) + `ORCH_*`.
### 4.3 Data / schema changes
`sessions`: ensure `tmux_window`, `tmux_pane`, `pid`, `last_output_at`, `stderr_tail` exist (baseline has most; add migration `0003_sessions_runtime.ts` for `pid`, `last_output_at`, `stderr_tail`, plus `exit_code INTEGER NULL`, `exit_signal TEXT NULL`, `exit_evidence TEXT NULL` (`wrapper|wrapper+pane|pane|unknown`), `exit_unknown INTEGER NOT NULL DEFAULT 0`, `adopted_via TEXT NULL`).
### 4.4 Infrastructure
Mailbox = single async loop; every handler awaits tmux calls; no shared state outside the actor. The actor is constructed only after the ADR-020 data-directory lock is acquired; losing the lock (file removed, another owner detected) drains the mailbox and stops the supervisor rather than continuing to drive panes it no longer owns.

Timers: liveness sweep every 10 s — for each running session check `#{pane_dead}` and pane pid; a dead pane triggers the exit sequence even if no notification arrived (this is the backstop for the version-dependent pane notifications of M1-01 `EM-TMUX-03`). Idle detection (`last_output_at`) feeds `waiting_for_input` heuristics only when adapters can't signal it (M1-11 prefers official signals).

Session runtime directory `~/.orchestra/sessions/<sid>/` (0700): `launch.json`, `exit.json`. Retention: pruned when the session row is deleted, or after the configured history window (M5 owns long-term retention).
### 4.5 API / UI surface
`SessionRunnerPort` used by `StartSession/StopSession` (M0-06). New: `POST /sessions/:id/input` (dev/debug; UI uses `/term` WS in M1-09), `POST /hosts/me/reconcile`.
### 4.6 Flow
```
# launch
StartSession → assert data-dir lock held (ADR-020) → supervisor.start → gate(provider)
  → worktree (M1-03) → adapter.launcher.interactive/headless → preLaunchFiles written
  → mkdir 0700 ~/.orchestra/sessions/<sid>/ + launch.json
  → tmux.newWindow(env, argv = ["orch-run", sid, "--", …adapterArgv])
  → setRemainOnExit(window, true) → setPaneOption(pane, "@orch_session_id", sid) → select-pane -T "orch:<sid>"
  → persist pane → running

# agent process ends  (the ONLY path that changes session state to stopped/crashed)
tmux paneExited(pane) | liveness sweep sees #{pane_dead}=1
  → read exit.json            (primary)
  → read #{pane_dead_status}  (cross-check, pane still retained)
  → apply evidence rules 1–4  → session.stopped | session.crashed{exitCode?,signal?,exitUnknown?,exitMismatch?}
  → stderrTail from ring buffer → RateLimitParser gets ProcessExit
  → RecordEvent → gate release → killPane (reap the retained pane)

# our tmux control client dies  (sessions are NOT touched)
controlClientExited | disconnected
  → mark transport degraded, pause Input/Resize, keep session rows as-is
  → reconnect loop (M1-01) → reconnected → Reconcile → resume subscriptions
  → no session transitions to stopped/crashed anywhere on this path

# boot / reconnect
reconcile → listPanes(userOptions:['@orch_session_id'])
  → adopt by pane option → else pane title "orch:<sid>" → else DB tmux_pane id (live pane, no marker)
  → for each DB-running session with no live pane: read exit.json
        found      → resolvedExited: stopped|crashed with the recorded status
        not found  → crashed{exitUnknown:true, reason:'both-missing'}
  → orphan panes (no marker, no DB row) → report, keep by default
```

## 5. Tasks
- [ ] Assert the M0-04/ADR-020 data-directory lock at supervisor construction; `SUPERVISOR_NOT_OWNER` error naming the owning pid/endpoint; release on shutdown; test for the double-start case.
- [ ] Mailbox/actor utility with typed messages, replies, and a drain-on-shutdown.
- [ ] `SessionSupervisor` start/stop/kill/input/resize/subscribe handlers + `OutputHub` ring buffer.
- [ ] Env allowlist builder + `ORCH_*` injection; `preLaunchFiles` writer (atomic, inside worktree); session runtime dir + `launch.json`.
- [ ] `orch-run.mjs` wrapper: stdio passthrough, signal forwarding, durable `exit.json` (tmp + fsync + rename + dir fsync), exit-code/signal propagation, degrade-not-fail on unwritable dir; unit + integration tests incl. `SIGKILL` of the wrapper itself.
- [ ] Concurrency gate per provider from manifest; config override; tests.
- [ ] `ExitEvidence` resolver implementing rules 1–4 (pure function, 100 % branch); `stderrTail`; `session.stopped/crashed` events carrying `exitEvidence`/`exitUnknown`/`exitMismatch`; `ProcessExit` to adapter rate-limit parser; Doctor signal on mismatch.
- [ ] Separate handlers for `paneExited` (exit sequence) and `controlClientExited`/`disconnected` (degrade + reconnect, no session transitions) — enforced by a test that spies on the session repository.
- [ ] Liveness sweep (10 s) reading `#{pane_dead}`; dead-pane reaper after the status read.
- [ ] Reconcile: adopt via pane option → pane title → DB pane id (record `adopted_via`); resolve missing panes against `exit.json`; orphan policy; run at boot and after `disconnected→reconnected`.
- [ ] `PtyPort` tmux implementation; `SessionRunnerPort` swap with feature flag `runner: tmux|process`.
- [ ] Migration `0003_sessions_runtime` (incl. `exit_code`, `exit_signal`, `exit_evidence`, `exit_unknown`, `adopted_via`).
- [ ] Application tests with `FakeTmux`; integration tests with real tmux + FakeProvider agent script running inside tmux under `orch-run`.
- [ ] Debug endpoint `POST /hosts/me/reconcile` + `orch dev sessions` listing tmux vs DB vs `exit.json` (and `adopted_via`).
- [ ] Docs: actor model, message list, exit-evidence rules, adoption precedence, ownership lock.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| AT-M1-02-01 | application (FakeTmux) | start → running; exit 0 → stopped | states + events in order |
| AT-M1-02-02 | application | exit 137 | `crashed`, `stderrTail` populated |
| AT-M1-02-03 | application | 3rd session for provider with max 2 | `CONCURRENCY_LIMIT` |
| AT-M1-02-04 | application | reconcile: pane carrying `@orch_session_id` of a DB session in `running` | adopted with `adopted_via:'pane-option'`; pane missing but `exit.json` present → resolved to `stopped`/`crashed` with the recorded status |
| AT-M1-02-05 | application | 1000 concurrent messages | processed serially; no interleaved tmux calls (spy) |
| IT-M1-02-06 | integration (real tmux) | FakeProvider `hello-exit0` inside tmux under `orch-run` | output received through hub; `exit.json` written; exit 0; `exitEvidence:'wrapper+pane'` |
| IT-M1-02-07 | integration | daemon restart with a live fake pane | reconcile adopts; output subscription resumes; no session transition |
| UT-M1-02-08 | unit | env allowlist strips `AWS_SECRET_ACCESS_KEY`, keeps `PATH` | as specified |
| UT-M1-02-09 | unit | `ExitEvidence` resolver, all four rules incl. wrapper/pane disagreement | wrapper wins; `exitMismatch:true` + Doctor signal; both missing → `exitUnknown:true`, code `null`; **no branch ever yields a substituted `0`** |
| IT-M1-02-10 | integration (real tmux) | agent exits 42 with `remain-on-exit on` | `exit.json` `{exitCode:42}` and `#{pane_dead_status}=42` agree; `session.crashed{exitCode:42}`; pane reaped after the read |
| IT-M1-02-11 | integration | pane destroyed before the status read (`kill-pane` from another client) | wrapper `exit.json` (signal `SIGHUP`/`SIGKILL`) still supplies the answer; `exitEvidence:'wrapper'` |
| IT-M1-02-12 | integration | wrapper `SIGKILL`ed so no `exit.json` is written, pane retained | falls back to `#{pane_dead_status}`; `exitEvidence:'pane'`, `exitConfidence:'cross-check-only'` |
| IT-M1-02-13 | integration | neither source available (pane gone **and** `exit.json` absent) | `session.crashed{exitCode:null, exitUnknown:true, reason:'both-missing'}`; API and UI show "exit status unknown" |
| IT-M1-02-14 | integration (real tmux) | **control-client disconnect**: kill the `tmux -CC` client while two agents run | driver reconnects; reconcile re-adopts both; **zero** `session.stopped`/`session.crashed` events (repository spy asserts none); input/resize resume | 
| IT-M1-02-15 | integration (real tmux) | **agent-process termination** while the control client is healthy | exactly one session transitions; the other session is untouched |
| AT-M1-02-16 | application | adoption precedence: pane with option; pane with only title; live pane with neither but matching DB `tmux_pane` | `adopted_via` = `pane-option` / `pane-title` / `db-pane-id` respectively; a pane with a *stale* DB id but a different `@orch_session_id` is adopted by the option, not the DB |
| AT-M1-02-17 | application | second supervisor started against the same data dir while the first holds the lock | `SUPERVISOR_NOT_OWNER` naming the owner; no tmux command issued (spy); first supervisor unaffected |
| UT-M1-02-18 | unit | `orch-run` durability: crash between tmp write and rename (simulated) | `exit.json` is either absent or complete — never a truncated/partial record |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-02-01 | Fake session in tmux | 1. `POST /sessions {provider:'fake', scenario:'tool-calls-stream'}` 2. `tmux -L orchestra attach` | window named `fake-<id>` shows the script output; DB row has window/pane ids | ⬜ |
| TC-M1-02-02 | Adopt after restart | 1. start fake `sleep`-style scenario 2. restart daemon 3. `GET /sessions/<id>` | still `running`; reconcile report lists it in `adopted` with `via: "pane-option"` | ⬜ |
| TC-M1-02-03 | Crash detection | 1. `tmux -L orchestra kill-pane -t %<pane>` | session → `crashed` within 2 s; event has a reason and a real `exitSignal` from `exit.json` (not a guessed code) | ⬜ |
| TC-M1-02-04 | Concurrency | 1. set fake manifest max 1 2. start two | second returns 429 `CONCURRENCY_LIMIT` with clear message | ⬜ |
| TC-M1-02-05 | Env hygiene | 1. export `MY_SECRET=x` in the daemon's shell 2. start fake session printing env | `MY_SECRET` absent; `ORCH_SESSION_ID` present | ⬜ |
| TC-M1-02-06 | Orphan policy | 1. create a pane manually in the orchestra server 2. reconcile | listed as orphan in report; not killed by default | ⬜ |
| TC-M1-02-07 | Exit status is real | 1. start a fake session whose script does `exit 42` 2. `GET /sessions/<id>` | `exitCode: 42`, `exitEvidence: "wrapper+pane"`; `cat ~/.orchestra/sessions/<id>/exit.json` shows the same; pane reaped | ⬜ |
| TC-M1-02-08 | Unknown is unknown | 1. start a fake session 2. `tmux -L orchestra kill-server` 3. `rm ~/.orchestra/sessions/<id>/exit.json` 4. restart daemon | session → `crashed` with `exitUnknown: true`, `exitCode: null`; UI reads "ended — exit status unknown"; **no `0` anywhere** | ⬜ |
| TC-M1-02-09 | Control client ≠ agents | 1. run two sessions 2. `pkill -f 'tmux -CC'` 3. watch `/events` and Terminals | both sessions stay `running`; no stopped/crashed events; terminals reconnect within the reconnect budget; typing works again afterwards | ⬜ |
| TC-M1-02-10 | Adoption without the option | 1. start a session 2. `tmux -L orchestra set-option -p -t %<pane> -u @orch_session_id` 3. reconcile | adopted via pane title; report shows `via: "pane-title"`; a warning names the missing option | ⬜ |
| TC-M1-02-11 | One owner per data dir | 1. daemon running 2. start a second `orchestrad` with the same `ORCH_DATA_DIR` | second refuses with `SUPERVISOR_NOT_OWNER` naming the first's pid and endpoint; first keeps running; no pane is touched (ADR-020) | ⬜ |

## 7. Acceptance criteria
- [ ] Supervisor is the only tmux caller (depcruise rule `tmux-only-supervisor` added).
- [ ] Supervisor refuses to start without the ADR-020 data-directory lock (AT-17, TC-11).
- [ ] Start/stop/crash/reconcile paths tested with FakeTmux and real tmux.
- [ ] Exit status comes from `exit.json` (primary) cross-checked against `#{pane_dead_status}`; every branch of the evidence resolver tested; **no code path produces a guessed exit code** — missing evidence yields `exitUnknown: true` (UT-09, IT-13, TC-08).
- [ ] Control-client disconnect and agent-process termination are tested separately and provably do not cross over (IT-14, IT-15, TC-09).
- [ ] Adoption precedence pane option → pane title → DB pane id, with `adopted_via` recorded (AT-16, TC-02, TC-10); `show-environment` is not used for adoption.
- [ ] Concurrency limits enforced from manifests.
- [ ] Env allowlist proven by test.
- [ ] Restart adopts live panes (TC-02).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Adoption reads one `list-panes -F` with the user options inlined — O(1) tmux calls instead of the O(panes) `show-environment` loop the earlier draft assumed (and which could not have worked: `show-environment` is session/global scope).
- The wrapper is an extra process in every pane. It must be transparent to TUIs (raw mode, `SIGWINCH`, job control); if a vendor CLI misbehaves under it, the fallback is launching the CLI directly and degrading to `pane-dead` evidence — record that per provider in the M0-09 evidence matrix rather than silently disabling the wrapper.
- A dead-but-retained pane holds memory until reaped; the liveness sweep plus the reaper bound it, and an unreaped dead pane is a Doctor signal.
- `exitMismatch` between wrapper and `pane_dead_status` is treated as a drift alarm, not a tie to be broken quietly.
- Idle heuristics can misclassify long tool runs as "waiting"; keep heuristics advisory until M1-11 wires official signals.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
