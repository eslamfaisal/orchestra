# Step M1-06 — Codex adapter v1

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-02, M1-04 (∥ with M1-05) |
| Estimated effort | 4 days |
| Packages touched | `packages/providers/codex`, `apps/daemon/src/infrastructure/rpc` (JSON-RPC over stdio client) |
| Risk | High (R3: app-server experimental) |
| Owner | |

## 1. Goal
`@orchestra/provider-codex` drives Codex through `codex app-server` (JSON-RPC over stdio: threads, turns, items, approvals, model switch, token/usage notifications) for the managed session mode, and through `codex exec --json --output-schema` for headless tasks, with the plain interactive `codex` TUI in a tmux pane as the user-visible surface when app-server is not in use. Approvals (`execCommandApproval`, `applyPatchApproval`, `item/permissions/requestApproval`) become prompts answered via RPC. A pinned app-server JSON schema fixture makes drift visible. `codex mcp-server` is never used (ADR-009).

## 2. Why
D4/D5, ADR-009, C1/C3/C8, G1/G3, `05-provider-contract.md` §3 row "Codex".

## 3. Scope
### In scope
- Manifest v0: models (GPT-5.x family ids as reported by `codex` "(verify)"), features `appServer hooks? mcp sandbox nativeReview` "(verify hooks availability)", sandbox profiles `read-only | workspace-write | danger-full-access` (the last never auto-selected), prompt protocol (approvals → `app-server-rpc`), headless (`exec --json --output-schema`), `cliVersionRange` pinned to the reinstalled version, `updateSources`.
- Two session modes decided per launch:
  - **managed** (default for delegated tasks): tmux pane runs `codex app-server`; daemon connects to its stdio through a tiny bridge (`orch-stdio-bridge.mjs`: pane process ↔ Unix socket) so the pane remains attachable and the RPC stream is structured; the daemon's `JsonRpcClient` sends `thread/start`, `turn/start`, receives item/approval/usage notifications "(verify method names via `generate-json-schema`)".
  - **interactive** (user-driven): plain `codex` TUI in the pane; telemetry limited to process exit + optional hooks; prompts fall back to `send-keys-acked`.
- `Launcher.headless`: `codex exec --json --output-schema <schema.json> --sandbox <profile> --model … "<goal>"` in the worktree; stdout JSONL parsed.
- `TelemetryParser`: app-server notifications → `message`, `tool_call/result`, `usage` (with token counts), `prompt_opened` (approvals with command/patch payloads), `model_switched`, `exit`; `exec --json` events likewise.
- `RateLimitParser`: RPC error objects / stderr 429 / usage-limit messages → `RateLimitSignal`.
- `PaneController`: `answerPrompt` via RPC approval response; `switchModel` via RPC (managed) or `/model` keystrokes (interactive); `sendCommand` maps to `turn/start` (managed) or keys.
- Schema fixture: `codex app-server generate-json-schema` output committed under `fixtures/<ver>/rpc/schema.json`; contract test diffs current CLI output vs fixture (skipped in CI, run by Doctor/M6 and manually).
- Contract tests + fuzz.
### Out of scope (deferred)
- Token window forecasting → M4-01. Cloud sessions → M7-07. Native `codex` worktrees → we use ours. Codex SDK (TypeScript) usage — not needed; RPC covers it.

## 4. Design
### 4.1 Domain
Session gains `mode: 'managed'|'interactive'|'headless'` (config + start dialog).
### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/infrastructure/rpc/jsonrpc-stdio.client.ts (generic; reused by future adapters)
export class JsonRpcStdioClient { constructor(io: Duplex, opts: { timeoutMs: number; onNotification: (m: Notification) => void }); request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<Result<T, RpcError>>; respond(id: RpcId, result: unknown): void; close(): void }

// packages/providers/codex/src/app-server.ts
export interface CodexAppServer { startThread(cwd: string, model?: string, sandbox?: SandboxProfile): Promise<Result<{ threadId: string }, AdapterError>>;
  startTurn(threadId: string, input: string): Promise<Result<{ turnId: string }, AdapterError>>;
  approve(requestId: RpcId, decision: 'approve'|'deny'|'approve_for_session'): Promise<Result<void, AdapterError>>;
  setModel(threadId: string, model: string): Promise<Result<void, AdapterError>>; }
```
Bridge: `orch-stdio-bridge.mjs <socketPath> -- codex app-server` runs in the tmux pane, proxies the child's stdio to a Unix socket the daemon connects to, and mirrors a human-readable transcript to the pane (so Terminals shows something useful). Socket path under `~/.orchestra/run/<sessionId>.sock` (0600).
### 4.3 Data / schema changes
`sessions.mode` column (migration `0006_sessions_mode.ts`).
### 4.4 Infrastructure
Unix socket per managed session; reconnect after daemon restart (socket persists while the pane lives) — enables M5-05 restore. RPC ids correlate to `AgentPrompt.externalId`.
### 4.5 API / UI surface
Start-session dialog exposes `mode` (M1-10). No new routes.
### 4.6 Flow (approval round-trip)
```
turn/start → … notification item/… requestApproval{id, command} → parser → prompt_opened(permission, transport app-server-rpc)
AnswerPrompt → CodexAppServer.approve(id,'approve') → RPC response → Codex runs command → item notifications → tool_result → turn.completed{usage} → usage event
```

## 5. Tasks
- [ ] Reinstall Codex (ENVIRONMENT.md); record version; run `codex app-server generate-json-schema` → fixture.
- [ ] Generic `JsonRpcStdioClient` + tests (framing, ids, timeouts, notifications, server-initiated requests).
- [ ] `orch-stdio-bridge.mjs` (no deps) + tests; socket perms; transcript mirroring.
- [ ] Manifest v0; `CodexLauncher` for managed/interactive/headless; `preLaunchFiles` (Codex config for hooks/MCP if applicable "(verify)").
- [ ] `CodexAppServer` wrapper with Zod-validated methods derived from the schema fixture.
- [ ] `CodexTelemetryParser` (RPC notifications + exec JSONL), `CodexRateLimitParser`, `CodexPaneController`, `CodexAuthProbe` (`codex login status` "(verify)").
- [ ] Fixture recording: managed session with one approval, one patch approval, usage; headless exec with output schema; 429 sample or synthetic.
- [ ] Contract suite green; fuzz; schema-diff test (manual/Doctor).
- [ ] Register adapter; Fleet shows version/auth.
- [ ] Manual TCs.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M1-06-01 | contract | seven specs on fixtures | pass |
| UT-M1-06-02 | unit | RPC client: request/response, notification, server request, timeout | as specified |
| UT-M1-06-03 | unit | approval notification fixture → `prompt_opened{kind:'permission', answerTransport:'app-server-rpc', payload.command}` | mapped |
| UT-M1-06-04 | unit | `turn.completed` fixture → `usage` with tokens | mapped |
| UT-M1-06-05 | unit | exec JSONL fixture → message/tool/exit | golden |
| IT-M1-06-06 | integration | bridge + fake app-server script over socket in tmux | round-trip; daemon reconnects to socket after restart |
| UT-M1-06-07 | fuzz | parser random RPC messages | never throws |

### 6.2 Manual test cases (real Codex, scratch repo)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-06-01 | Managed session | 1. Fleet → Codex, mode managed, sandbox workspace-write 2. send "list files" via `POST /sessions/:id/input` | pane shows transcript; RPC events logged; assistant message captured | ⬜ |
| TC-M1-06-02 | Command approval | 1. ask Codex to run `npm test` | approval prompt within 1 s with the command; approve via API → runs; `usage` event after turn | ⬜ |
| TC-M1-06-03 | Patch approval deny | 1. ask Codex to edit `cli.js` | `applyPatchApproval` prompt with diff payload; deny → Codex reports denial; file unchanged | ⬜ |
| TC-M1-06-04 | Interactive TUI | 1. start mode interactive 2. use the pane directly in Terminals | works like a normal terminal; exit ends session with code | ⬜ |
| TC-M1-06-05 | Headless exec | 1. `orch dev run codex --headless "add a comment to cli.js"` | JSONL parsed; output matches schema; exit 0; diff visible in worktree | ⬜ |
| TC-M1-06-06 | Schema drift check | 1. `orch dev codex schema-diff` | "no drift" for pinned version; after a CLI upgrade shows diff summary | ⬜ |
| TC-M1-06-07 | Restart survives | 1. managed session mid-turn 2. restart daemon | daemon reconnects to socket; next notifications flow; session still `running` | ⬜ |

## 7. Acceptance criteria
- [ ] Managed (app-server), interactive and headless modes work on the real CLI.
- [ ] Approvals round-trip via RPC; deny path verified.
- [ ] Schema fixture pinned; drift check tool exists.
- [ ] Contract suite + fuzz green; `RECORDED.md` complete.
- [ ] Daemon restart re-attaches to the managed session socket.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- App-server method names/shape evolve (experimental): everything derived from the schema fixture; `exec --json` is the fallback transport (M6-04 ladder step).
- Bridge adds a moving part; alternative is running app-server as a daemon child (not in tmux) — rejected for MVP to keep "everything attachable" (D2); revisit in ADR if the bridge proves flaky.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
