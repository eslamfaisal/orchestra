# Step M1-05 — Claude Code adapter v1

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M0-09, M1-02, M1-04 |
| Estimated effort | 5 days |
| Packages touched | `packages/providers/claude`, `apps/daemon/src/interface/hooks` (receiver used here, formalised in M1-08) |
| Risk | High (first real adapter; R1, R5) |
| Owner | |

## 1. Goal
`@orchestra/provider-claude` implements the full `ProviderAdapter` for Claude Code through official surfaces only: `AuthProbe` via a quota-free status probe, `Launcher` for interactive PTY sessions (hooks + MCP config written per worktree) and headless runs (`-p --output-format stream-json` **with a permission host**), `TelemetryParser` for hook payloads and stream-json lines, `RateLimitParser` for 429/quota messages, `PaneController` for slash commands, model switch and prompt answers, and a manifest v0 with fixtures recorded from Claude Code 2.1.216. Contract tests pass.

### The approval contract (corrected)
The earlier draft treated `AskUserQuestion` and `ExitPlanMode` as **hook events** and excluded `updatedInput` from v1. Both are wrong.

- **`AskUserQuestion` and `ExitPlanMode` are tools, not hooks.** They are intercepted like any other tool call, through `PreToolUse`. There is no `AskUserQuestion` hook and no `ExitPlanMode` hook to subscribe to.
- **Answering them programmatically means rewriting their input**, so `updatedInput` **is in scope for v1** — for exactly these two tools. Returning `permissionDecision: "allow"` alone does not carry the user's chosen option or the plan verdict; it only lets the tool proceed to ask.
- For every **other** tool, v1 uses `permissionDecision: allow | deny | ask` (with `permissionDecisionReason`) and does **not** rewrite input. Editing arbitrary tool arguments from Orchestra stays out of scope (M2+).
- **Nothing in this step may depend on a hook name or response field that is not listed in §4.2's evidence table.** Every name carries an M0-09 evidence-matrix row id and is `unverified` until that row is filled on the real CLI. An `unverified` row disables the affected prompt kind for this provider (capability state per `00-foundations/14-provider-evidence-matrix.md`); it does not disable the adapter.

### Two separate flows, verified separately
1. **Interactive PTY** — the user-visible TUI in a tmux pane. Hooks fire; the daemon holds the hook's HTTP response and answers it. The **user can also answer in the pane**, so the adapter must reconcile: whoever answers first wins, and the other side is reconciled rather than overwritten (§4.6).
2. **Headless `-p`** — no TUI, no human at the keyboard. Hooks alone are **not** an approval channel here: a tool that needs approval and has no permission host is **denied by the CLI**. Orchestra therefore supplies a permission host — `--permission-prompt-tool` pointing at an MCP tool served by `orch mcp serve` (SDK `canUseTool` is the equivalent for embedded use, not used in v1). Without it we do not pretend a prompt exists: the run proceeds with tools denied and the adapter reports that, rather than fabricating an `AgentPrompt`.

## 2. Why
D4/D5 (official channels, plugin), C1/C3/C7/C8, G1, `05-provider-contract.md` §3 row "Claude Code".

## 3. Scope
### In scope
- Manifest v0 (`manifest.json`): models (Sonnet/Opus/Fable ids as listed by the CLI — `EM-CLAUDE-11`), features `hooks mcp skills planMode subagents streamJsonInput websearch vision`, sandbox = permission modes (`default`, `acceptEdits`, `plan`, `bypassPermissions` — the last one never auto-selected), prompt protocol per kind **keyed by execution mode** (`interactive-pty` vs `headless`), `cliVersionRange: ">=2.1.0 <3"`, `updateSources` (GitHub releases + docs changelog), paths (`CLAUDE.md`, `.claude/skills`, `.claude/commands`, `.claude/settings.json`).
- `AuthProbe`: quota-free status probe (exact command per `EM-CLAUDE-10`); parse plan/login; never read `~/.claude` credential files.
- `Launcher.interactive`: argv `claude` (+ `--model`, `--permission-mode`, optional `--resume <id>`); `preLaunchFiles`: project-local `.claude/settings.json` hooks block registering **only the hooks in the §4.2 evidence table** at `curl`-free hook commands: a tiny bundled Node script `orch-hook.mjs` that POSTs `stdin` JSON to `$ORCH_HOOK_URL/claude/$ORCH_SESSION_ID/<hook>` and prints the response JSON (so `PreToolUse` decisions come back through the official hook response). MCP config for the delegation server (M2-05) is a placeholder here.
- `Launcher.headless`: `claude -p "<goal>" --output-format stream-json --verbose --max-turns N --model … --permission-mode …` with `--allowedTools`/`--disallowedTools` from the task spec (`EM-CLAUDE-12`), **plus `--permission-prompt-tool <mcpToolName>`** and an MCP config pointing at `orch mcp serve` (see §4.4). Headless runs are launched with the permission host by default; a run explicitly configured without one is marked `permissionHost: 'none'` and its capability state for approvals is `unsupported` for that run.
- **Permission host** (`orch mcp serve`, new in this step, minimal): a local stdio MCP server exposing one tool that Claude Code calls when a tool needs approval. The call arrives with the tool name and input; the daemon opens an `AgentPrompt` and the MCP **result** carries the decision (allow/deny, and for the two answer-carrying tools the rewritten input). This is the only approval channel in headless mode.
- `TelemetryParser`: hook bodies → `prompt_opened` (permission / question / plan, discriminated by `tool_name`), `tool_call/result`, `message`, `exit`; stream-json lines → `message`, `tool_call`, `usage`, `exit`; `Notification` payloads → prompts/usage events (`EM-CLAUDE-04`); unknowns → `unknown`.
- `RateLimitParser`: stream-json error objects / stderr with rate-limit or usage-limit text + reset hints → `RateLimitSignal` (confidence `official` when a reset timestamp is present, else `estimate`).
- `PaneController`: `sendCommand` for slash commands (`/model`, `/clear`, `/compact`, `/status`, custom commands from `.claude/commands`) with ack detection from hooks/stream (`UserPromptSubmit` event, `EM-CLAUDE-05`); `switchModel` via `/model <id>`; `answerPrompt` per §4.2 — `hook-response` (interactive) or `mcp-result` (headless) as the primary transports, `send-keys` with a declared ack event as the last resort, which per M1-11 ends in `delivery_uncertain` when no ack event is declared for that prompt kind.
- Fixtures recorded with `orch fixtures record claude` (M1-08 tool; a manual capture script suffices for this step's first pass).
- Contract tests + parser fuzz.
### Out of scope (deferred)
- Full manifest incl. command discovery → M2-03. Session JSONL ingestion → M5-02. `/usage` window parsing → M4-01. Resume/fork → M5-05. Skills installer → M8-04. `--worktree` native flag (we run inside our worktree; keep `nativeFlag` empty).

## 4. Design
### 4.1 Domain
Uses SDK types. Pending hook responses are held by the daemon's hooks receiver: `PendingHookResponse { sessionId, hookName, externalId, respond(json), deadline }` (M1-08 formalises; the map lives in the receiver, not the adapter).
### 4.2 Interfaces / contracts
```ts
// packages/providers/claude/src/index.ts
export const claudeAdapter: ProviderAdapter = { id: 'claude', manifest, auth: new ClaudeAuthProbe(), launcher: new ClaudeLauncher(), telemetry: new ClaudeTelemetryParser(), rateLimit: new ClaudeRateLimitParser(), pane: new ClaudePaneController(), quota: new ClaudeQuotaProbe() /* stub until M4-01 */ };

// hook script contract (bundled at packages/providers/claude/bin/orch-hook.mjs)
// stdin: hook JSON from Claude Code; env: ORCH_HOOK_URL, ORCH_SESSION_ID; argv[2]: hook name
// stdout: JSON response returned by daemon (e.g. {"hookSpecificOutput":{"permissionDecision":"allow"}}) ; exit code per Claude hook semantics (EM-CLAUDE-06)
```

#### Evidence table — every Claude surface this step relies on
No hook name, field or flag may be used in code unless it appears here **and** its M0-09 row is filled. Rows start `unverified`; a row that stays `unverified` at step start disables the capability it backs (per `00-foundations/14-provider-evidence-matrix.md`), it does not block the adapter.

| Row | Surface | Used for | Mode | State at plan time |
|---|---|---|---|---|
| `EM-CLAUDE-01` | hook `PreToolUse` — request body shape (`tool_name`, `tool_input`, session id) | every permission prompt; also the carrier for the two answer tools | interactive-pty | unverified |
| `EM-CLAUDE-02` | hook `PreToolUse` response — `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`) + `permissionDecisionReason` | allow/deny/defer for ordinary tools | interactive-pty | unverified |
| `EM-CLAUDE-03` | hook `PreToolUse` response — `updatedInput` (exact key and shape) | answering `AskUserQuestion`; recording the `ExitPlanMode` verdict | interactive-pty | unverified |
| `EM-CLAUDE-04` | hook `Notification` — payload kinds actually emitted | "agent needs input" signal, quota notices | interactive-pty | unverified |
| `EM-CLAUDE-05` | hook `UserPromptSubmit` — fires on programmatic input | ack for `sendCommand` | interactive-pty | unverified |
| `EM-CLAUDE-06` | hook exit-code / timeout semantics for `orch-hook.mjs` | non-blocking failure behaviour | both | unverified |
| `EM-CLAUDE-07` | hooks `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd` — availability and shape | tool results, turn boundaries, lifecycle | interactive-pty | unverified |
| `EM-CLAUDE-08` | tool `AskUserQuestion` — input schema (options) and how an answer is expressed | question prompts | both | unverified |
| `EM-CLAUDE-09` | tool `ExitPlanMode` — input schema (plan text) and how approve/reject is expressed | plan approval | both | unverified |
| `EM-CLAUDE-10` | quota-free auth/status command | `AuthProbe` | headless | unverified |
| `EM-CLAUDE-11` | model ids as listed by the CLI | manifest `models` | headless | unverified |
| `EM-CLAUDE-12` | `-p` flags: `--output-format stream-json`, `--verbose`, `--max-turns`, `--allowedTools`/`--disallowedTools` | headless launcher | headless | unverified |
| `EM-CLAUDE-13` | `--permission-prompt-tool` — flag name, the MCP tool contract it expects, and the result shape that grants/denies | headless approvals | headless | unverified |
| `EM-CLAUDE-14` | behaviour of a headless run with **no** permission host when a tool needs approval | the negative case (expected: tool denied, run continues) | headless | unverified |

Prompt protocol (manifest excerpt) — **keyed by execution mode**, because the transports genuinely differ:
```json
{ "promptProtocol": {
  "permission": {
    "interactive-pty": { "source": "hook:PreToolUse",            "answerTransport": "hook-response",
                         "answerField": "hookSpecificOutput.permissionDecision",
                         "ackEvent": "hook:PostToolUse", "deadlineMs": 60000, "onDeadline": "ask",
                         "fallback": { "transport": "send-keys", "ackEvent": "hook:PostToolUse" } },
    "headless":        { "source": "mcp:permission-prompt-tool", "answerTransport": "mcp-result",
                         "ackEvent": "mcp:result-consumed", "deadlineMs": 60000, "onDeadline": "deny",
                         "fallback": null,
                         "requires": "permissionHost",
                         "withoutHost": "unsupported" } },
  "question": {
    "interactive-pty": { "source": "hook:PreToolUse", "toolName": "AskUserQuestion",
                         "answerTransport": "hook-response", "answerField": "updatedInput",
                         "ackEvent": "hook:PostToolUse",
                         "fallback": { "transport": "send-keys", "ackEvent": null } },
    "headless":        { "source": "mcp:permission-prompt-tool", "toolName": "AskUserQuestion",
                         "answerTransport": "mcp-result", "requires": "permissionHost",
                         "withoutHost": "unsupported" } },
  "planApproval": {
    "interactive-pty": { "source": "hook:PreToolUse", "toolName": "ExitPlanMode",
                         "answerTransport": "hook-response", "answerField": "updatedInput",
                         "editSupport": "plan-text", "ackEvent": "hook:PostToolUse",
                         "fallback": { "transport": "send-keys", "ackEvent": null } },
    "headless":        { "source": "mcp:permission-prompt-tool", "toolName": "ExitPlanMode",
                         "answerTransport": "mcp-result", "requires": "permissionHost",
                         "withoutHost": "unsupported" } },
  "login": { "interactive-pty": { "source": "process:stderr", "answerTransport": "none" },
             "headless":        { "source": "process:stderr", "answerTransport": "none" } } } }
```
`"fallback": { "transport": "send-keys", "ackEvent": null }` is deliberate and the UI must show it: a keystroke answer with no declared ack event resolves to **`delivery_uncertain`**, never `acknowledged` (M1-11 rule). Echoed text in the pane is not an ack.

**Answer states produced by this adapter** (definitions owned by M1-11):
| Transport | Reaches `acknowledged` when | Otherwise |
|---|---|---|
| `hook-response` | the held hook response is consumed and the matching `PostToolUse`/tool-result arrives for the same `tool_use_id` | response delivery failed → `submitted`, then `expired` at deadline |
| `mcp-result` | the MCP call returns and the CLI proceeds on that tool | call already timed out on the CLI side → `expired` |
| `send-keys` (no declared ack) | never | `delivery_uncertain` immediately after the keystrokes are written |
| deadline reached with no answer | — | `expired`; interactive: the CLI falls back to its own native prompt and the card stays answerable via keystrokes (`delivery_uncertain`); headless: the tool is denied |
### 4.3 Data / schema changes
None (uses `sessions`, `events`, `agent_prompts` via M1-11).
### 4.4 Infrastructure
Project-local `.claude/settings.json` written into the worktree (never the user's global settings); merged with an existing file if present (deep-merge, ours appended, original backed up to `.orchestra/backup/`). Hook script path absolute; hook timeout configured to `deadlineMs`.
### 4.5 API / UI surface
None new (hooks receiver route from M0-06 stub; formal in M1-08).
### 4.6 Flow (permission round-trip)
```
claude PreToolUse → orch-hook.mjs → POST /hooks/claude/:sid/PreToolUse (body) → receiver holds response, parser → prompt_opened(permission) → M1-11 AgentPrompt
user answers → AnswerPrompt → PaneController.answerPrompt → receiver.respond({permissionDecision:'allow'}) → hook exits → claude proceeds → PostToolUse hook → tool_result
deadline passes → receiver responds {permissionDecision:'ask'} → Claude shows native prompt → AgentPrompt stays open with fallback transport send-keys-acked
```

## 5. Tasks
- [ ] Package scaffold, manifest v0, `README.md` (surfaces used, ToS notes: none needed beyond normal use).
- [ ] `orch-hook.mjs` (no deps, ≤ 60 lines, timeout, error → non-blocking exit per hook semantics) + tests.
- [ ] `ClaudeLauncher` interactive + headless argv builders (typed, documented flags only) + `preLaunchFiles` settings merge with backup.
- [ ] `ClaudeAuthProbe` quota-free probe + parser + no-secrets test.
- [ ] `ClaudeTelemetryParser`: hook schemas (Zod per hook), stream-json schemas, Notification kinds, unknown handling.
- [ ] `ClaudeRateLimitParser`.
- [ ] `ClaudePaneController`: sendCommand/ack, switchModel, answerPrompt (hook-response + fallback keystrokes).
- [ ] Record fixtures on Claude Code 2.1.216 in the scratch repo: one hook payload per kind, one stream-json headless run with a tool call and usage, a plan-mode exit, a rate-limit sample if reproducible (else a synthetic one marked `synthetic: true` in `RECORDED.md`).
- [ ] `defineAdapterContract(claudeAdapter, fixtures/2.1.216)` green; fuzz test.
- [ ] Register adapter in `ProviderRegistry`; Fleet shows it (M1-04).
- [ ] Manual TC run in tmux via supervisor (M1-02) with real Claude.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M1-05-01 | contract | all seven specs on fixtures 2.1.216 | pass |
| UT-M1-05-02 | unit | `PreToolUse` fixture → `prompt_opened{kind:'permission', payload.tool, payload.input}` | fields mapped; `answerTransport: 'hook-response'` |
| UT-M1-05-03 | unit | stream-json headless fixture → message/tool_call/usage/exit sequence | golden |
| UT-M1-05-04 | unit | launcher headless argv | only documented flags; `-p` text last; no shell |
| UT-M1-05-05 | unit | settings merge keeps user hooks, adds ours, backup written | golden JSON |
| UT-M1-05-06 | fuzz | parser random JSON/hook names | never throws |
| IT-M1-05-07 | integration | `orch-hook.mjs` against a stub receiver | posts body, prints response, exits 0; receiver down → exits non-blocking code within 2 s |

### 6.2 Manual test cases (real Claude Code, scratch repo)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-05-01 | Interactive launch | 1. Fleet → start Claude session (Sonnet) in scratch worktree 2. type `/status` | pane shows Claude TUI; `.claude/settings.json` in worktree has our hooks; events show `session.launched` | ⬜ |
| TC-M1-05-02 | Permission via hook | 1. ask Claude to create `hello.txt` 2. observe Attention (M1-11) or `GET /prompts` | prompt within 1 s with tool `Write` + path; answer allow via API → file created; `PostToolUse` event logged | ⬜ |
| TC-M1-05-03 | Deadline fallback | 1. repeat TC-02 but don't answer for > deadline | Claude shows its native prompt; AgentPrompt still open with `send-keys-acked`; answering via API sends keystrokes → proceeds | ⬜ |
| TC-M1-05-04 | Plan approval | 1. `/plan` (or plan mode) a small change 2. approve via API | plan text captured in `prompt.payload`; approval continues session | ⬜ |
| TC-M1-05-05 | Model switch | 1. `POST /sessions/:id/model {model:'opus'}` | `/model` sent; ack event; Claude confirms model in TUI | ⬜ |
| TC-M1-05-06 | Headless run | 1. Quick Delegate lite (M1-12) or `orch dev run claude --headless "print hello"` | stream-json parsed: message, usage, exit 0; no interactive prompt | ⬜ |
| TC-M1-05-07 | Logged out | 1. simulate logged-out state (separate `HOME`) 2. detect + start | provider auth false; start refused with `AUTH_REQUIRED`; nothing crashes | ⬜ |
| TC-M1-05-08 | No secrets anywhere | 1. `grep -ri "sk-ant\|oauth\|token" ~/.orchestra/orchestra.db logs/` | no credential-shaped strings | ⬜ |

## 7. Acceptance criteria
- [ ] Contract suite green on recorded 2.1.216 fixtures; `RECORDED.md` complete.
- [ ] Permission, question, plan prompts round-trip via hook responses on a real session; fallback works.
- [ ] Headless stream-json parsed end to end.
- [ ] Settings written only into the worktree; user global config untouched (TC).
- [ ] Auth probe secret-free (contract test).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Exact hook names/response shapes for `AskUserQuestion`/`ExitPlanMode`/`Elicitation*` in 2.1.x — verify against Claude Code hooks reference at step start; fixtures are the source of truth afterwards.
- Hook response semantics for `defer` vs `ask` — pick per docs; TC-03 validates.
- Notification `quota_auto_resume_*` payloads useful for M4-01 — capture now if they occur.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
