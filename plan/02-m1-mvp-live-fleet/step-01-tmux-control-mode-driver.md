# Step M1-01 — tmux control-mode driver

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M0-04 |
| Estimated effort | 3.5 days |
| Packages touched | `apps/daemon/src/infrastructure/tmux`, `apps/daemon/src/application/ports` |
| Risk | High (R2) |
| Owner | |

## 1. Goal
A `TmuxControlClient` speaks tmux control mode (`tmux -CC`) over a single long-lived child process: sends commands with correlation, parses `%begin/%end/%error` blocks and asynchronous notifications (`%output`, `%window-add`, `%window-close`, `%unlinked-window-close`, `%session-changed`, `%layout-change`, `%pane-mode-changed`, `%exit`), decodes tmux's octal-escaped output, exposes typed commands (`newWindow`, `killWindow`, `killPane`, `respawnPane`, `sendKeys`, `resizePane`, `pipePane`, `listPanes`, `setPaneOption`/`getPaneOption` for pane **user options** `@orch_*`, `setRemainOnExit`, `showEnvironment`, `setEnvironment`) and an event stream — all behind a `TmuxPort` interface with a `FakeTmux` implementation for tests. Fuzz and property tests prove the parser never throws or desyncs, including under interleaved notifications.

**Two lifecycle events, never conflated:**
- `controlClientExited` — **our `tmux -CC` control client is going away**. This is what `%exit` means (optionally with a reason). It says nothing about any pane's process: the tmux server and every pane normally survive it. Reaction: reconnect (M1-01) and re-reconcile (M1-02).
- `paneExited` — **a process running in a pane ended**. Derived from pane/window disappearance notifications (`%window-close`, and pane-level close/exit notifications where the pinned tmux version emits them) **plus** a `#{pane_dead}` / `#{pane_dead_status}` read taken **while the pane is still retained** (`remain-on-exit on`). Reaction: exit classification (M1-02).

*(Every tmux fact in this step — notification names, format variables, option scopes, `%exit` semantics — is **documented, not verified**: verify against the tmux man page for the pinned version at step start; M0-09 records the answer as evidence rows `EM-TMUX-01` … `EM-TMUX-06`.)*

## 2. Why
D2 (tmux is the substrate), D13 (one actor drives tmux; this is the actor's tool), G1 (live terminals), R2 mitigation.

## 3. Scope
### In scope
- Control-mode process management: spawn `tmux -CC -u -f <our tmux.conf> new-session -A -s orchestra -d` then attach in control mode; reconnect on exit; heartbeat via `display-message -p`.
- Protocol parser: line-based state machine; `%begin <ts> <cmd-id> <flags>` … `%end|%error`; notifications outside blocks; `%output %<paneId> <octal-escaped bytes>` → `Buffer`; `%exit [reason]` → `controlClientExited` **only**.
- Command queue with per-command promise, timeout, and ordering guarantees (control mode replies in order).
- Typed command builders (shell-escaping!) and result parsers (`list-panes -F` with tab-separated format strings), including the dead-pane format fields `#{pane_dead}`, `#{pane_dead_status}`, `#{pane_dead_signal}` *(field availability per pinned version — `EM-TMUX-02`)*.
- **Retained panes**: `set-option -w remain-on-exit on` on every window Orchestra creates (set at `new-window` time via `-e`-independent `set-option -w -t <window>`), so a finished process leaves a **dead but readable** pane. `respawnPane(pane, argv?)` and `killPane(pane)` exist so the owner (M1-02) can clean up **after** the status read. The global default in our `tmux.conf` stays `off` so panes a human creates in the orchestra server behave normally.
- **Pane user options** as durable pane metadata: `set-option -p -t <pane> @orch_session_id <sid>` and read back with `list-panes -F '#{@orch_session_id}'`. This is the adoption key (M1-02). Note: `show-environment` is **session/global scope, not per pane** — it cannot carry per-pane identity and is not used for adoption *(`EM-TMUX-04`)*.
- Our own `tmux.conf` (history-limit, escape-time 0, `set -g remain-on-exit off` as the *global* default, `focus-events on`, `aggressive-resize`, disable status bar for embedded use, mouse off, 256color/truecolor passthrough).
- `TmuxPort` interface + `FakeTmux` (scriptable panes producing output, exits).
- Metrics: commands/s, output bytes/s, parse errors (Doctor signal in M6-02).
### Out of scope (deferred)
- Session/pane lifecycle policy, concurrency limits, reconciliation → M1-02.
- Recording → M5-01 (but `pipePane` command exists here).
- tmux inside containers → M9-06.

## 4. Design
### 4.1 Domain
`PaneRef { sessionName: 'orchestra'; windowId: '@12'; paneId: '%34' }` (value object in core, added here).
### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/ports/tmux.port.ts
export interface TmuxPort {
  start(): Promise<Result<void, TmuxError>>;                       // spawn/attach control client
  stop(): Promise<void>;
  newWindow(o: { name: string; cwd: string; argv: string[]; env: Record<string,string> }): Promise<Result<PaneRef, TmuxError>>;
  killWindow(w: PaneRef): Promise<Result<void, TmuxError>>;
  killPane(p: PaneRef): Promise<Result<void, TmuxError>>;           // only after the dead-status read
  respawnPane(p: PaneRef, o?: { argv?: string[]; cwd?: string; env?: Record<string,string> }): Promise<Result<void, TmuxError>>;
  setRemainOnExit(w: PaneRef, on: boolean): Promise<Result<void, TmuxError>>;   // set-option -w remain-on-exit
  setPaneOption(p: PaneRef, name: `@${string}`, value: string): Promise<Result<void, TmuxError>>;  // set-option -p
  getPaneOption(p: PaneRef, name: `@${string}`): Promise<Result<string | null, TmuxError>>;        // display-message -p -t <pane> '#{@name}'
  sendKeys(p: PaneRef, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<Result<void, TmuxError>>;
  resize(p: PaneRef, cols: number, rows: number): Promise<Result<void, TmuxError>>;
  pipePane(p: PaneRef, shellCmd: string | null): Promise<Result<void, TmuxError>>;
  listPanes(o?: { userOptions?: `@${string}`[] }): Promise<Result<PaneInfo[], TmuxError>>;
  // PaneInfo: { pane, window, pid, cwd, title, cols, rows, dead: boolean, deadStatus: number | null, deadSignal: number | null, userOptions: Record<string,string> }
  showEnvironment(name: string): Promise<Result<string | null, TmuxError>>;     // SESSION/GLOBAL scope only — never per pane
  events(): AsyncIterable<TmuxEvent>;
  attachCommand(): string;                                          // "tmux -L orchestra attach -t orchestra"
}

export type TmuxEvent =
  | { type: 'output'; pane: string; bytes: Buffer }
  | { type: 'paneExited'; pane: string; window: string; deadStatus: number | null; deadSignal: number | null; statusKnown: boolean }
  | { type: 'windowClosed'; window: string }
  | { type: 'controlClientExited'; reason?: string }   // %exit — the -CC client, NOT a pane process
  | { type: 'disconnected' }                            // transport lost (client exited, killed, or socket error)
  | { type: 'layout'; window: string; layout: string }
  | { type: 'sessionChanged'; session: string };

export type TmuxError = { code: 'TMUX_NOT_FOUND'|'TMUX_VERSION'|'TMUX_DISCONNECTED'|'TMUX_COMMAND'|'TMUX_TIMEOUT'|'TMUX_PARSE'; message: string; stderr?: string };
```
`paneExited` is **synthesised by the driver**, not read off the wire: on a pane/window-close notification (and on the liveness sweep) the driver reads `#{pane_dead}`/`#{pane_dead_status}`/`#{pane_dead_signal}` for that pane. If the pane is already gone (not retained, or killed by a human) the event is still emitted with `statusKnown: false` and null status — the driver never invents `0`. `controlClientExited` never produces a `paneExited`.
Parser as a pure function `feed(chunk: Buffer) → TmuxFrame[]` with internal state, unit-testable without a process.
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
Dedicated tmux server socket `-L orchestra` (isolates from the user's own tmux). Version check `tmux -V` ≥ 3.3 at `start()`. Child env allowlist from M0-04. Output backpressure: `%output` frames pushed to a bounded async queue (drop-oldest for the *live* stream only, never for command replies).
### 4.5 API / UI surface
None (M1-09 consumes `events()` via the supervisor).
### 4.6 Flow
```
start → spawn control client → wait for first %begin/%end of "display-message" → ready
newWindow → "new-window -d -P -F '#{window_id}\t#{pane_id}' -n <name> -c <cwd> -e K=V … '<argv shell-escaped>'" → parse ids
          → set-option -w -t <win> remain-on-exit on
          → set-option -p -t <pane> @orch_session_id <sid>   (caller supplies; M1-02 uses it for adoption)
          → PaneRef
%output %34 \033[… → decodeOctal → event{output}

# pane process ends (pane retained):
%window-close / pane-close notification | liveness sweep
  → display-message -p -t %34 '#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}'
  → event{paneExited, deadStatus, statusKnown:true}   → M1-02 classifies, then killPane/respawnPane
# pane already destroyed (killed by a human, server restart):
  → event{paneExited, deadStatus:null, statusKnown:false} → M1-02 records exitUnknown

# our control client goes away (unrelated to panes):
%exit [reason] | child process dies → event{controlClientExited} + event{disconnected}
  → reconnect loop → on success event{reconnected} → M1-02 re-reconciles; panes untouched throughout
```

## 5. Tasks
- [ ] `tmux.conf` for the orchestra server; document each option.
- [ ] `TmuxBinary` locator (uses BinaryRegistry from M1-04 when present; until then `which tmux`) + version parse.
- [ ] Confirm the tmux facts above against the man page for the installed version; record `EM-TMUX-01` (`%exit` semantics) … `EM-TMUX-06` in the M0-09 evidence matrix before writing the parser.
- [ ] Control-mode parser (`parser.ts`): frames, octal decoding (`\\ooo`), CRLF handling, partial-line buffering, `%begin` nesting rules, `%exit` → `controlClientExited` (never a pane event).
- [ ] `CommandQueue` with ids, timeouts (default 5 s), in-order resolution, cancellation on disconnect.
- [ ] Shell escaping helper with tests (spaces, quotes, `$`, unicode, newlines).
- [ ] `TmuxControlClient implements TmuxPort` + reconnect loop (backoff, max attempts, `controlClientExited` + `disconnected` events, `reconnected` on success).
- [ ] Retained-pane support: `setRemainOnExit` applied to every created window; dead-status reader (`display-message -p -t <pane> '#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}'`) with `statusKnown:false` when the pane is gone; `respawnPane`/`killPane` builders.
- [ ] Pane user options: `setPaneOption`/`getPaneOption`, `listPanes({userOptions:['@orch_session_id']})` via `-F '#{@orch_session_id}'`; unit test that a missing option reads as `null`, not `''`.
- [ ] `FakeTmux implements TmuxPort` with scriptable panes (`emit(pane, bytes)`, `paneExit(pane, {status, signal})`, `dropPaneWithoutStatus(pane)`, `killControlClient()`), pane user options, and an interleaver that emits notifications between a `%begin`/`%end` pair.
- [ ] Property tests (fast-check): random byte streams + chunk boundaries → parser never throws, frames stable regardless of chunking.
- [ ] Integration tests on a real tmux (`-L test-<pid>`): new window running `printf`, capture `%output`, `sendKeys`, resize, exit status via `#{pane_dead_status}` on the retained pane.
- [ ] Metrics + debug log of raw protocol behind `ORCH_TMUX_TRACE=1`.
- [ ] `orch dev tmux ping` script prints server version and pane list.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M1-01-01 | unit | parser: golden transcript of control-mode session (recorded) | exact frame sequence |
| UT-M1-01-02 | property | parser fed same bytes in random chunkings | identical frames; never throws |
| UT-M1-01-03 | unit | octal decoding incl. `\\015\\012`, utf-8 multibyte split across frames | correct bytes |
| UT-M1-01-04 | unit | shell escaping round-trip through `sh -c 'printf %s'` | identical string |
| UT-M1-01-05 | unit | command timeout → `TMUX_TIMEOUT`; disconnect → all pending rejected | as specified |
| IT-M1-01-06 | integration (real tmux) | newWindow + sendKeys + output + exit | events in order; exit code captured |
| IT-M1-01-07 | integration | 50 windows × 1 MB output each | no parse errors; memory bounded; live queue drop count reported |
| IT-M1-01-08 | integration | kill control client process | `disconnected` event; `start()` again re-attaches; panes still alive |
| UT-M1-01-09 | property (fuzz) | notifications (`%output`, `%window-close`, `%layout-change`, `%exit`) randomly interleaved around and inside `%begin/%end` blocks, random chunking | command replies resolve with the right payload; notification order preserved; parser never throws or desyncs; `%exit` yields exactly one `controlClientExited` and zero `paneExited` |
| IT-M1-01-10 | integration (real tmux) | control client killed while a pane runs `sleep 600` | `controlClientExited` + `disconnected`; **no** `paneExited`; after reconnect `listPanes` shows the same pane id and pid, `@orch_session_id` still readable |
| IT-M1-01-11 | integration (real tmux) | pane command `sh -c 'exit 3'` in a window with `remain-on-exit on` | `paneExited{deadStatus:3, statusKnown:true}`; pane still listed with `#{pane_dead}=1` until `killPane` |
| IT-M1-01-12 | integration (real tmux) | pane destroyed out from under us (`kill-pane` from another client) | `paneExited{deadStatus:null, statusKnown:false}`; no fabricated `0` |
| UT-M1-01-13 | unit | pane user options: set `@orch_session_id`, read via `listPanes` and `getPaneOption`; unset pane | value round-trips; unset → `null` |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-01-01 | Server isolation | 1. run your own `tmux` session 2. `orch dev tmux ping` | orchestra server on socket `-L orchestra`; your tmux untouched | ⬜ |
| TC-M1-01-02 | Attach externally | 1. start a window via `orch dev tmux new -- bash` 2. `tmux -L orchestra attach -t orchestra` in iTerm | same shell visible; typing there shows in daemon trace log | ⬜ |
| TC-M1-01-03 | Escaping | 1. new window with argv containing `it's "quoted" $HOME` echo | printed literally | ⬜ |
| TC-M1-01-04 | Survive daemon death | 1. start window running `sleep 600` 2. kill daemon 3. restart 4. `listPanes` | pane still present, pid same | ⬜ |
| TC-M1-01-05 | Old tmux refused | 1. put a fake `tmux` script printing `tmux 3.1` first on PATH 2. start | `TMUX_VERSION` error naming required ≥ 3.3; no crash | ⬜ |
| TC-M1-01-06 | Trace | 1. `ORCH_TMUX_TRACE=1` 2. run TC-02 | raw `%begin/%end/%output` lines visible in log | ⬜ |
| TC-M1-01-07 | Control client ≠ pane | 1. start a window running `sleep 600` 2. `pkill -f 'tmux -CC'` (our control client only) 3. watch the trace | log shows `controlClientExited` then `disconnected` then `reconnected`; **no** pane-exit event; `sleep` still running with the same pid | ⬜ |
| TC-M1-01-08 | Dead pane keeps its status | 1. `orch dev tmux new -- sh -c 'exit 7'` 2. `orch dev tmux ping` | pane listed as dead with `pane_dead_status=7`; driver reported `paneExited{deadStatus:7}`; after the read the pane is cleaned up | ⬜ |
| TC-M1-01-09 | Pane metadata | 1. start a window with `@orch_session_id=test-1` 2. `tmux -L orchestra list-panes -a -F '#{pane_id} #{@orch_session_id}'` | the option is visible on the pane; `show-environment` does **not** carry it (session/global scope) | ⬜ |

## 7. Acceptance criteria
- [ ] `TmuxPort` + real + fake implementations; parser pure and property-tested (incl. interleaved notifications, UT-09).
- [ ] `controlClientExited` and `paneExited` are separate events with separate tests (IT-10 vs IT-11); no code path derives a pane exit from `%exit`.
- [ ] Retained panes: `remain-on-exit on` per Orchestra window; dead status read before cleanup; `statusKnown:false` when unavailable (IT-12) — never a fabricated exit code.
- [ ] Pane user option `@orch_session_id` written at creation and readable via `list-panes -F` (UT-13); `show-environment` documented as session/global scope only.
- [ ] Real-tmux integration suite green on macOS and Ubuntu CI.
- [ ] Reconnect after control-client death without losing panes.
- [ ] Version check and isolated socket.
- [ ] Every tmux fact used here has an `EM-TMUX-*` row in the M0-09 evidence matrix, or is marked `unverified` in the step log.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Control-mode `%output` can interleave with command replies under load — parser must treat notifications as valid anywhere outside `%begin/%end` payload lines (verified by IT-07 and UT-09).
- Large pastes via `sendKeys` are slow; use `load-buffer`/`paste-buffer` for > 1 KB (add in M1-09 if needed).
- tmux 3.5+ changed some `-e` env semantics *(verify against the tmux man page for the pinned version at step start; M0-09 row `EM-TMUX-05`)*.
- **`%exit` is the control client exiting, not a pane process** — the previous draft of this step conflated the two. `%exit` may also carry a reason string. Panes and the tmux server normally outlive it *(`EM-TMUX-01`)*.
- **Pane-level exit notifications are version-dependent.** Which of `%window-close` / `%unlinked-window-close` / a pane-level notification fires for a dead-but-retained pane must be pinned at step start *(`EM-TMUX-03`)*; until then the liveness sweep in M1-02 is the backstop, and a pane whose status cannot be read is reported `statusKnown:false`.
- **`show-environment` has session and global scope only**; there is no per-pane environment query. Pane identity therefore lives in pane user options (`@orch_session_id`), with pane title as a secondary marker *(`EM-TMUX-04`)*.
- Retaining dead panes costs memory if cleanup is missed; M1-02 owns the read-then-`killPane` sequence and the liveness sweep reaps any pane left dead for more than one sweep interval.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
