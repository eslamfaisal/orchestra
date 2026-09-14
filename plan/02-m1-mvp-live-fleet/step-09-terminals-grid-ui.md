# Step M1-09 — Terminals grid UI

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-02, M0-07 |
| Estimated effort | 3 days |
| Packages touched | `apps/web` (terminals), `apps/daemon/src/interface/ws` (`/term` raw channel), `packages/ui` |
| Risk | Medium (R8 perf budgets) |
| Owner | |

## 1. Goal
The Terminals screen shows every live session as an xterm.js pane (WebGL renderer) in a responsive grid, each with a header (provider · model · task · worktree branch · status badge · actions: focus, stop, attach-externally, open Chat), streaming raw PTY bytes over a dedicated binary WebSocket `/term/:sessionId` with resize and input, a broadcast bar to type into selected panes, keyboard navigation, and it meets the budgets: first frame ≤ 500 ms, input echo ≤ 50 ms, ≤ 40 MB per pane, 60 fps on 10k-line scrollback.

## 2. Why
G1 (see and control every agent), D1/D2 (one UI; panes are tmux panes), `03-architecture.md` §5 (`/term` never via Tauri IPC), `12-ux-principles.md` budgets.

## 3. Scope
### In scope
- Daemon `/term/:sessionId` WS: auth (`?token=`), binary frames: client→server `{0x01 input bytes}`, `{0x02 resize cols rows}`; server→client raw output bytes + `{0x03 status}`; replay of the `OutputHub` ring buffer on connect; backpressure (pause reading tmux output for that pane if the socket buffer > 1 MB; drop only for that subscriber); close on session end.
- Web: `TerminalPane` (xterm + `@xterm/addon-webgl`, fallback canvas; `addon-fit`; `addon-search`; unicode11), theme tokens, font from design system; scrollback cap 10k lines; link handling; copy/paste; IME.
- Grid layout: 1/2/4/6 panes, auto by count, drag to reorder, focus mode (one pane large), persisted layout per host.
- Header per pane fed by `sessions` WS topic; status badge (running / waiting_for_input / stopping / stopped / crashed) with icon+text; actions: Stop (confirm), Kill, "Attach externally" (copies `tmux -L orchestra attach -t orchestra:<window>`), "Open in Chat" (placeholder until M2-08).
- Broadcast bar: select panes → type → sent to each (with preview when > 1 pane, C10 spirit).
- Keyboard: `⌘1..9` focus pane, `⌘⇧F` search, `Esc` leave terminal focus.
- Perf harness: synthetic 10k-line burst + `requestAnimationFrame` fps counter + memory sample → `evidence/perf-terminals.md`.
### Out of scope (deferred)
- Recording/replay player → M5-04. Chat rendering → M2-08. Mobile layout tuning → M7-03.

## 4. Design
### 4.1 Domain
None (UI + transport).
### 4.2 Interfaces / contracts
```ts
// wire protocol /term/:sessionId (binary)
// client → server: [0x01, ...utf8 bytes] input | [0x02, colsHi, colsLo, rowsHi, rowsLo] resize | [0x00] ping
// server → client: [0x10, ...bytes] output | [0x11, statusCode] status | [0x12, ...json] error
export class TermSocket { constructor(sessionId: string, token: string); write(data: string): void; resize(cols: number, rows: number): void; onData(cb: (bytes: Uint8Array)=>void): Unsubscribe; onStatus(cb: (s: SessionState)=>void): Unsubscribe; close(): void }
```
Daemon side: `TermGateway` uses `PtyPort.onData/write/resize` from the supervisor (M1-02); one subscriber per socket.
### 4.3 Data / schema changes
None. Layout persisted in `localStorage` (M8-01 moves to user settings).
### 4.4 Infrastructure
Binary WS via `ws` on the same Fastify server; per-socket send buffer monitoring; heartbeat 15 s.
### 4.5 API / UI surface
Route `/terminals`; WS `/term/:sessionId`.
### 4.6 Flow
`open Terminals → subscribe sessions → for each running session mount TerminalPane → TermSocket connect → replay buffer → live bytes → xterm.write; keypress → input frame → supervisor.input → tmux send-keys (literal) …`
Note: input goes through `PtyPort.write` (tmux `send-keys -l` or paste-buffer for large input), not through the adapter — adapters are for *structured* commands; raw typing is raw.

## 5. Tasks
- [ ] `TermGateway` + protocol codec + tests (framing, resize, backpressure, replay).
- [ ] `PtyPort.write` large-input path (paste-buffer > 1 KB).
- [ ] `TermSocket` client with reconnect + replay dedupe (server sends replay marker).
- [ ] `TerminalPane` component (xterm + addons, theme, scrollback cap, dispose on unmount) + resize observer → resize frames (debounced).
- [ ] Grid + focus mode + reorder + persistence.
- [ ] Pane header (live from `sessions` topic) + actions + confirm dialogs; "Attach externally" copy.
- [ ] Broadcast bar with preview.
- [ ] Keyboard shortcuts + a11y (pane region labels, focus trap inside terminal, `Esc`).
- [ ] Perf harness + evidence; lazy-load xterm bundle on route.
- [ ] Playwright E2E with FakeProvider `tool-calls-stream` (output visible, typing echoes, stop works).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M1-09-01 | unit | protocol codec round-trip | identical frames |
| IT-M1-09-02 | integration | connect `/term` without token | 4401 close |
| IT-M1-09-03 | integration | connect mid-session | replay buffer delivered first, then live bytes, no duplication |
| IT-M1-09-04 | integration | slow client (paused socket) while pane outputs 5 MB | other subscribers unaffected; this one drops per policy; server memory bounded |
| E2E-M1-09-05 | e2e | fake session output appears; type `hello` → echoed by fake agent | passes |
| E2E-M1-09-06 | e2e | resize window | resize frame sent; fake agent reports new cols/rows |
| E2E-M1-09-07 | perf | 10k-line burst | fps ≥ 55 measured; memory delta ≤ 40 MB |

### 6.2 Manual test cases (real sessions)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-09-01 | Two real panes | 1. start Claude + Codex sessions 2. open Terminals | both panes live; headers show provider/model/branch/status | ⬜ |
| TC-M1-09-02 | Typing latency | 1. focus Claude pane 2. type a sentence | echo feels instant; harness reports ≤ 50 ms local | ⬜ |
| TC-M1-09-03 | Resize + TUI | 1. drag browser to narrow, then wide | Claude TUI reflows correctly; no garbage | ⬜ |
| TC-M1-09-04 | Attach externally | 1. click "Attach externally" 2. paste in iTerm | same pane; typing in iTerm shows in browser and vice versa | ⬜ |
| TC-M1-09-05 | Broadcast | 1. select both panes 2. type `pwd` + Enter | preview shows targets; both print their own worktree path | ⬜ |
| TC-M1-09-06 | Stop/crash badge | 1. Stop Codex pane 2. `kill -9` Claude's pid from a shell | badges: stopped / crashed with reason; panes stay readable | ⬜ |
| TC-M1-09-07 | Reconnect | 1. restart daemon with panes open | panes reconnect, replay last buffer, continue live | ⬜ |
| TC-M1-09-08 | Memory | 1. 3 panes open 30 min with activity 2. Activity Monitor / `performance.memory` | ≤ 40 MB per pane growth | ⬜ |

## 7. Acceptance criteria
- [ ] `/term` binary channel with auth, replay, resize, backpressure, tests.
- [ ] Grid, headers, actions, broadcast, keyboard, a11y.
- [ ] Budgets measured and recorded: first frame ≤ 500 ms, echo ≤ 50 ms, ≤ 40 MB/pane, ≥ 55 fps on 10k lines.
- [ ] Works with tmux-attached external terminals simultaneously.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- WebGL context limits (~16 per page): use one shared renderer strategy or canvas fallback beyond 8 panes.
- tmux `send-keys` vs raw PTY write differences (e.g. bracketed paste): validate with Claude TUI paste (TC-02/05).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
