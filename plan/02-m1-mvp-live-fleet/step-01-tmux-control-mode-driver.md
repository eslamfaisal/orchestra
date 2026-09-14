# Step M1-01 — tmux control-mode driver

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M0-04 |
| Estimated effort | 3 days |
| Packages touched | `apps/daemon/src/infrastructure/tmux`, `apps/daemon/src/application/ports` |
| Risk | High (R2) |
| Owner | |

## 1. Goal
A `TmuxControlClient` speaks tmux control mode (`tmux -CC`) over a single long-lived child process: sends commands with correlation, parses `%begin/%end/%error` blocks and asynchronous notifications (`%output`, `%exit`, `%window-add`, `%window-close`, `%session-changed`, `%layout-change`, `%pane-mode-changed`), decodes tmux's octal-escaped output, exposes typed commands (`newWindow`, `killWindow`, `sendKeys`, `resizePane`, `pipePane`, `listPanes`, `showEnvironment`, `setEnvironment`) and an event stream — all behind a `TmuxPort` interface with a `FakeTmux` implementation for tests. Fuzz and property tests prove the parser never throws or desyncs.

## 2. Why
D2 (tmux is the substrate), D13 (one actor drives tmux; this is the actor's tool), G1 (live terminals), R2 mitigation.

## 3. Scope
### In scope
- Control-mode process management: spawn `tmux -CC -u -f <our tmux.conf> new-session -A -s orchestra -d` then attach in control mode; reconnect on exit; heartbeat via `display-message -p`.
- Protocol parser: line-based state machine; `%begin <ts> <cmd-id> <flags>` … `%end|%error`; notifications outside blocks; `%output %<paneId> <octal-escaped bytes>` → `Buffer`; `%exit`.
- Command queue with per-command promise, timeout, and ordering guarantees (control mode replies in order).
- Typed command builders (shell-escaping!) and result parsers (`list-panes -F` with tab-separated format strings).
- Our own `tmux.conf` (history-limit, escape-time 0, `set -g remain-on-exit off`, `focus-events on`, `aggressive-resize`, disable status bar for embedded use, mouse off, 256color/truecolor passthrough).
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
  sendKeys(p: PaneRef, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<Result<void, TmuxError>>;
  resize(p: PaneRef, cols: number, rows: number): Promise<Result<void, TmuxError>>;
  pipePane(p: PaneRef, shellCmd: string | null): Promise<Result<void, TmuxError>>;
  listPanes(): Promise<Result<PaneInfo[], TmuxError>>;             // id, window, pid, cwd, dead, title, size
  showEnvironment(p: PaneRef, name: string): Promise<Result<string | null, TmuxError>>;
  events(): AsyncIterable<TmuxEvent>;                               // {type:'output', pane, bytes} | {type:'exit', pane, code?} | {type:'window-close', window} | {type:'layout', …} | {type:'disconnected'}
  attachCommand(): string;                                          // "tmux -L orchestra attach -t orchestra"
}
export type TmuxError = { code: 'TMUX_NOT_FOUND'|'TMUX_VERSION'|'TMUX_DISCONNECTED'|'TMUX_COMMAND'|'TMUX_TIMEOUT'|'TMUX_PARSE'; message: string; stderr?: string };
```
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
newWindow → "new-window -d -P -F '#{window_id}\t#{pane_id}' -n <name> -c <cwd> -e K=V … '<argv shell-escaped>'" → parse ids → PaneRef
%output %34 \033[… → decodeOctal → event{output}
%exit / control client dies → event{disconnected} → supervisor decides (M1-02)
```

## 5. Tasks
- [ ] `tmux.conf` for the orchestra server; document each option.
- [ ] `TmuxBinary` locator (uses BinaryRegistry from M1-04 when present; until then `which tmux`) + version parse.
- [ ] Control-mode parser (`parser.ts`): frames, octal decoding (`\\ooo`), CRLF handling, partial-line buffering, `%begin` nesting rules.
- [ ] `CommandQueue` with ids, timeouts (default 5 s), in-order resolution, cancellation on disconnect.
- [ ] Shell escaping helper with tests (spaces, quotes, `$`, unicode, newlines).
- [ ] `TmuxControlClient implements TmuxPort` + reconnect loop (backoff, max attempts, `disconnected` event).
- [ ] `FakeTmux implements TmuxPort` with scriptable panes (`emit(pane, bytes)`, `exit(pane, code)`).
- [ ] Property tests (fast-check): random byte streams + chunk boundaries → parser never throws, frames stable regardless of chunking.
- [ ] Integration tests on a real tmux (`-L test-<pid>`): new window running `printf`, capture `%output`, `sendKeys`, resize, exit code via `#{pane_dead_status}`.
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

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-01-01 | Server isolation | 1. run your own `tmux` session 2. `orch dev tmux ping` | orchestra server on socket `-L orchestra`; your tmux untouched | ⬜ |
| TC-M1-01-02 | Attach externally | 1. start a window via `orch dev tmux new -- bash` 2. `tmux -L orchestra attach -t orchestra` in iTerm | same shell visible; typing there shows in daemon trace log | ⬜ |
| TC-M1-01-03 | Escaping | 1. new window with argv containing `it's "quoted" $HOME` echo | printed literally | ⬜ |
| TC-M1-01-04 | Survive daemon death | 1. start window running `sleep 600` 2. kill daemon 3. restart 4. `listPanes` | pane still present, pid same | ⬜ |
| TC-M1-01-05 | Old tmux refused | 1. put a fake `tmux` script printing `tmux 3.1` first on PATH 2. start | `TMUX_VERSION` error naming required ≥ 3.3; no crash | ⬜ |
| TC-M1-01-06 | Trace | 1. `ORCH_TMUX_TRACE=1` 2. run TC-02 | raw `%begin/%end/%output` lines visible in log | ⬜ |

## 7. Acceptance criteria
- [ ] `TmuxPort` + real + fake implementations; parser pure and property-tested.
- [ ] Real-tmux integration suite green on macOS and Ubuntu CI.
- [ ] Reconnect after control-client death without losing panes.
- [ ] Version check and isolated socket.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Control-mode `%output` can interleave with command replies under load — parser must treat notifications as valid anywhere outside `%begin/%end` payload lines (verified by IT-07).
- Large pastes via `sendKeys` are slow; use `load-buffer`/`paste-buffer` for > 1 KB (add in M1-09 if needed).
- tmux 3.5+ changed some `-e` env semantics (verify with installed version).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
