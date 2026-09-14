# Step M1-05 — Claude Code adapter v1

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-02, M1-04 |
| Estimated effort | 4 days |
| Packages touched | `packages/providers/claude`, `apps/daemon/src/interface/hooks` (receiver used here, formalised in M1-08) |
| Risk | High (first real adapter; R1, R5) |
| Owner | |

## 1. Goal
`@orchestra/provider-claude` implements the full `ProviderAdapter` for Claude Code through official surfaces only: `AuthProbe` via `claude /status`-style quota-free probe, `Launcher` for interactive PTY sessions (with hooks + MCP config written per worktree) and headless runs (`-p --output-format stream-json`), `TelemetryParser` for hook payloads and stream-json lines, `RateLimitParser` for 429/quota messages, `PaneController` for slash commands, model switch and prompt answers (hook-response first, `send-keys-acked` fallback), and a manifest v0 with fixtures recorded from Claude Code 2.1.216. Contract tests pass.

## 2. Why
D4/D5 (official channels, plugin), C1/C3/C7/C8, G1, `05-provider-contract.md` §3 row "Claude Code".

## 3. Scope
### In scope
- Manifest v0 (`manifest.json`): models (Sonnet/Opus/Fable ids as listed by the CLI "(verify)"), features `hooks mcp skills planMode subagents streamJsonInput websearch vision`, sandbox = permission modes (`default`, `acceptEdits`, `plan`, `bypassPermissions` — the last one never auto-selected), prompt protocol per kind, `cliVersionRange: ">=2.1.0 <3"`, `updateSources` (GitHub releases + docs changelog), paths (`CLAUDE.md`, `.claude/skills`, `.claude/commands`, `.claude/settings.json`).
- `AuthProbe`: run `claude` with a quota-free status command "(verify exact command: `claude /status` non-interactive or `claude auth status`)"; parse plan/login; never read `~/.claude` credential files.
- `Launcher.interactive`: argv `claude` (+ `--model`, `--permission-mode`, optional `--resume <id>`); `preLaunchFiles`: project-local `.claude/settings.json` hooks block pointing every relevant hook (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `ExitPlanMode`/plan-related "(verify names)") at `curl`-free hook commands: a tiny bundled Node script `orch-hook.mjs` that POSTs `stdin` JSON to `$ORCH_HOOK_URL/claude/$ORCH_SESSION_ID/<hook>` and prints the response JSON (so `PreToolUse` decisions come back through the official hook response). MCP config for the delegation server (M2-05) is a placeholder here.
- `Launcher.headless`: `claude -p "<goal>" --output-format stream-json --verbose --max-turns N --model … --permission-mode …` with `--allowedTools`/`--disallowedTools` from the task spec "(verify flags)"; stdin closed.
- `TelemetryParser`: hook bodies → `prompt_opened` (permission/question/plan), `tool_call/result`, `message`, `exit`; stream-json lines → `message`, `tool_call`, `usage`, `exit`; `Notification` kinds (`agent_needs_input`, `permission_prompt`, `quota_auto_resume_*`) → prompts/usage events; unknowns → `unknown`.
- `RateLimitParser`: stream-json error objects / stderr with rate-limit or usage-limit text + reset hints → `RateLimitSignal` (confidence `official` when a reset timestamp is present, else `estimate`).
- `PaneController`: `sendCommand` for slash commands (`/model`, `/clear`, `/compact`, `/status`, custom commands from `.claude/commands`) with ack detection from hooks/stream (`UserPromptSubmit` or output echo within timeout); `switchModel` via `/model <id>`; `answerPrompt`: `hook-response` (held HTTP response for the pending hook, decision `allow|deny|ask`, `updatedInput` unsupported in v1), `AskUserQuestion` answer via the hook's structured response "(verify)", plan approval via `ExitPlanMode` hook response, fallback `send-keys-acked` using keystroke maps from `fixtures/keys.yaml`.
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
// stdout: JSON response returned by daemon (e.g. {"hookSpecificOutput":{"permissionDecision":"allow"}}) ; exit code per Claude hook semantics (verify)
```
Prompt protocol (manifest excerpt):
```json
{ "promptProtocol": { "permission": { "source": "hook:PreToolUse|PermissionRequest", "answerTransport": "hook-response", "fallback": "send-keys-acked", "deadlineMs": 60000 },
  "question": { "source": "hook:AskUserQuestion", "answerTransport": "hook-response", "fallback": "send-keys-acked" },
  "planApproval": { "source": "hook:ExitPlanMode", "answerTransport": "hook-response", "fallback": "send-keys-acked" },
  "login": { "source": "process:stderr", "answerTransport": "none" } } }
```
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
