# M1 — MVP: Live fleet (MVP part 2)

| | |
|---|---|
| Steps | 13 (M1-01 … M1-13) |
| Effort | 38.5 working days (sum of step estimates; optional work included) |
| Status | ⬜ |
| Entry | M0 exit criteria all ✅; tmux ≥ 3.3 installed; Claude Code logged in; Codex reinstalled and logged in (ENVIRONMENT.md); scratch repo created |
| Exit | **the MVP**: ≥ 2 real vendor CLIs live in tmux panes inside per-task git worktrees, visible and controllable in the browser, supported structured prompts surfaced in Attention and answerable through evidenced channels; manual-only kinds labelled, Quick Delegate returns a branch + diff, daemon restart reports persisted state and per-mode recovery limitations |

## Goal
Replace the M0 fake process runner with the real substrate — tmux control mode, a single `SessionSupervisor` actor, git worktrees, an allowlisted `BinaryRegistry` — and ship the two required real adapters and an optional gated third adapter (Claude Code, Codex, Antigravity opt-in) with recorded fixtures and contract tests. On top of that: a Terminals grid with live xterm panes over a raw WebSocket, a Fleet screen to start sessions, the Interaction Bridge that turns every stop-and-ask into a durable `AgentPrompt` in an Attention queue, and a "Quick Delegate lite" that runs one task for one manually chosen provider in its own worktree. M1-13 is a hard acceptance gate on real CLIs.

## Why this milestone now
The riskiest assumptions in the whole product are here (RISKS R1, R2, R3, R5): can we drive tmux control mode reliably, can we get structured prompts out of each CLI through official channels, and can we answer them round-trip without screen-scraping. Proving that on real CLIs before building intelligence (M2+) is decision D11.

## Entry criteria
- [ ] M0 ✅ (all 9 steps, TCs recorded).
- [ ] `brew install tmux` (≥ 3.3); `tmux -V` recorded in ENVIRONMENT.md.
- [ ] `claude` logged in (`claude /status` shows plan); Codex reinstalled (`codex --version` works, `codex login status` ok); agy is not an entry requirement.
- [ ] Scratch repo `~/orchestra-scratch/` initialised with a tiny Node project (used by all TCs; never a real project in M1).

## Exit criteria (= MVP definition, D11)
- [ ] Start a Claude Code session and a Codex session from Fleet; both appear in Terminals with live output; typing in the browser reaches the agent; resize works.
- [ ] Each session runs in its own worktree under `<scratch>/.orchestra/worktrees/<taskId>` on its own branch.
- [ ] A permission prompt from Claude Code (hook) and an approval request from Codex (app-server) both appear in Attention within 1 s and are answered from the browser; the agent proceeds; the round-trip is visible in Events.
- [ ] A Claude plan-mode plan appears as a plan card; approving it continues the session.
- [ ] Quick Delegate: "add a `--version` flag to the scratch CLI" on Codex (headless) and on Claude (interactive) both return a branch, a diffstat and a summary.
- [ ] `kill -9` the daemon while a prompt is open → restart → the prompt is still in Attention and answering it works (smoke; full guarantees in M5-05).
- [ ] Contract tests for claude/codex pass (agy only when its gate is resolved) on recorded fixtures pinned to the installed CLI versions.
- [ ] Budgets: first WS frame ≤ 500 ms, input echo ≤ 50 ms local, ≤ 40 MB per pane with 3 panes open.
- [ ] `orch fixtures record` works for each provider; fixtures committed with `RECORDED.md`.
- [ ] All manual TCs in M1-01 … M1-13 ✅; `PROGRESS.md` updated; git tag `mvp-1`.

## Steps
| ID | File | Title | Effort | Depends |
|---|---|---|---|---|
| M1-01 | [step-01](step-01-tmux-control-mode-driver.md) | tmux control-mode driver | 3 d | M0-04 |
| M1-02 | [step-02](step-02-pty-port-and-sessionsupervisor.md) | PTY port & SessionSupervisor | 3 d | M1-01, M0-04 |
| M1-03 | [step-03](step-03-worktree-manager.md) | Worktree manager | 2 d | M0-04 |
| M1-04 | [step-04](step-04-binaryregistry-and-provider-detection.md) | BinaryRegistry & provider detection | 1.5 d | M0-04 |
| M1-05 | [step-05](step-05-claude-code-adapter-v1.md) | Claude Code adapter v1 | 5 d | M0-09, M1-02, M1-04 |
| M1-06 | [step-06](step-06-codex-adapter-v1.md) | Codex adapter v1 | 5 d | M0-09, M1-02, M1-04 |
| M1-07 | [step-07](step-07-antigravity-adapter-v1-opt-in.md) | Antigravity adapter v1 (opt-in) | 3 d | M0-09, M1-02, M1-04 |
| M1-08 | [step-08](step-08-telemetry-plane-and-fixture-recorder.md) | Telemetry plane & fixture recorder | 2.5 d | M1-05 |
| M1-09 | [step-09](step-09-terminals-grid-ui.md) | Terminals grid UI | 3 d | M1-02, M0-07 |
| M1-10 | [step-10](step-10-fleet-screen-v1-start-session.md) | Fleet screen v1 + start session | 2 d | M1-04, M0-07 |
| M1-11 | [step-11](step-11-interaction-bridge-v1-and-attention-queue.md) | Interaction Bridge v1 & Attention queue | 4 d | M1-05, M1-06, M1-08 |
| M1-12 | [step-12](step-12-quick-delegate-lite.md) | Quick Delegate lite | 2.5 d | M1-11, M1-03 |
| M1-13 | [step-13](step-13-mvp-acceptance.md) | MVP acceptance | 2 d | M1-01, M1-02, M1-03, M1-04, M1-05, M1-06, M1-08, M1-09, M1-10, M1-11, M1-12 |

## What you can test after this milestone
- Your real Claude Code and Codex sessions, side by side, in one browser tab, each in its own worktree.
- Answering permission prompts, questions and plan approvals from the browser instead of the terminal.
- Handing one small task to one agent and getting a branch back.
- Attaching to the same panes from any terminal with `tmux attach -t orchestra`.
- Killing the daemon and losing nothing.

## Demo script (end of M1)
1. `orchestrad` running; open `http://127.0.0.1:4300/fleet` → Claude Code and Codex show version, auth ✔, plan label; agy shows "opt-in required".
2. Fleet → **Start session** → provider Claude Code, model Sonnet, repo `~/orchestra-scratch`, "new worktree" → Terminals shows the pane; type `/status` → output streams.
3. Start a Codex session the same way → second pane; broadcast bar → type `pwd` to both → each prints its own worktree path.
4. In the Claude pane ask it to create a file → `PreToolUse` hook → Attention shows a permission card with tool + path → **Allow** → file created; Events shows `prompt.opened → prompt.answered → prompt.delivered`.
5. In the Codex pane ask it to run `npm test` → app-server `execCommandApproval` → Attention card → **Deny** → Codex reports the denial.
6. Claude: `/plan` a change → plan card in Attention → **Approve** → Claude proceeds.
7. **Quick Delegate** → "add a `--version` flag to cli.js", provider Codex, headless → task card shows running → done → branch `orch/task-<id>`, diffstat `+7 −1`, summary; "open in Review (M3)" placeholder.
8. `kill -9 $(cat ~/.orchestra/orchestrad.pid)` while a Claude permission is open → `orchestrad` → Attention still shows the card → **Allow** → agent continues.
9. `tmux attach -t orchestra` in iTerm → same panes visible; detach.
10. `pnpm test` → contract suites for claude/codex green (agy only when its gate is resolved) on fixtures `claude@2.1.216`, `codex@<ver>`, `agy@1.2.1`.

## Milestone risks
- R2 tmux control-mode parsing (M1-01 fuzz + fake tmux mitigate).
- R3 Codex app-server drift (pin schema fixture; `exec --json` fallback exists from M1-06).
- R5 prompt round-trip reliability (each supported transport has a defined correlated outcome; uncertain/manual delivery is explicit; TC per prompt kind).
- R4 Antigravity ToS (adapter opt-in; terms resolution required before enablement; ToS acknowledgement stored in DECISIONS ADR-008).
- Usage cost of recording fixtures on real accounts: keep scenarios tiny; record once per CLI version.

## Parallelization
Lane A (substrate): M1-01 → M1-02 → M1-09. Lane B (∥ from M0-04): M1-03, M1-04, M1-10. Lane C (after M1-02 + M1-04): M1-05, M1-06, M1-07 in parallel (one per agent). M1-08 after M1-05; M1-11 after M1-08; M1-12 after M1-11 + M1-03; M1-13 last.

## Evidence
Put screenshots, perf numbers and recorded TC runs in `evidence/` (create the folder at M1-01).

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
