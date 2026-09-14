# Step M2-08 — Chat screen

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M1-11, M2-03 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/web`, `packages/ui`, `apps/daemon`, `packages/core` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step every session has a readable conversation: the normalized events produced by the telemetry plane (M1-08) are projected into `conversations` / `messages` / `message_tool_calls` and rendered in a new **Chat** screen — user turns, assistant turns, tool calls with arguments and durations, errors and rate-limit notices — in a virtualized, searchable-in-page stream. The composer has a `/` command palette built from the session's discovered command list (M2-03), sending typed commands through `PaneController.sendCommand` and showing the ack state. Open `AgentPrompt`s render inline in the stream using the Attention components from M1-11 and can be answered from Chat, and plan versions render as read-only plan cards.

## 2. Why
- G1: "see, control and talk to every agent in one place" — Terminals (M1-09) give raw bytes; Chat gives the conversation a human can read on a phone (M7-03 reuses these components).
- D4/C7: the conversation is built **only** from official structured channels (hooks, stream-json, app-server RPC, session logs) via `TelemetryParser` — never by scraping PTY bytes. Chat is the visible proof that the structured plane is sufficient.
- D14: prompts are durable objects, so they must be answerable wherever the user is looking — Attention *and* Chat, with one shared answer path and no second transport.
- C10: `/` commands that write files or spend quota carry `approval: confirm` in the manifest (M2-03) and therefore get a confirm sheet before any keystroke or RPC is sent.
- G5 (total recall): the projection written here is the same read model that History/Replay (M5-03/M5-04) search and scrub; getting it right now avoids a second ingestion path later.

## 3. Scope
### In scope
- `ConversationProjector` v1 (daemon application layer): `NormalizedEvent[]` → idempotent upserts into `conversations`, `messages`, `message_tool_calls`, keyed by `(conversation_id, external_id)`.
- `GET /api/sessions/:id/conversation` (cursor pagination, newest-last) and WS topic `conversation:<sessionId>` (append + update deltas).
- Chat screen: session switcher, virtualized message list, message renderers (user, assistant, tool call, system/notice, error, rate-limit), in-page find, copy, jump-to-terminal and jump-to-task links.
- Composer: free-text prompt send (existing M1-11/M1-12 path), `/` palette from `GET /api/sessions/:id/commands`, argument entry for typed command args, confirm sheet for `approval: 'confirm'`, ack/timeout states.
- Inline prompt cards reusing the M1-11 Attention renderers; answering from Chat goes through the same `AnswerPrompt` use case.
- Plan cards v1: `plan_versions` rows rendered read-only (version, source, content, collapsed diff vs the previous version).
### Out of scope (deferred to …)
- Multi-provider conversation capture completeness, session-log backfill and attachments → M5-02 (this step ships the projector for what M1-08 already normalizes and degrades gracefully for the rest).
- Full-text search across sessions → M5-03 (Chat only has in-page find).
- Replay scrubbing linked to the recording → M5-04.
- Approving / editing / rejecting plans → M3-02 (cards are read-only here).
- Streaming token-by-token rendering of assistant output → deferred; M2 renders message-level updates (a partial message is updated in place as chunks arrive, not animated per token).
- Broadcasting one message to several sessions → already in Terminals (M1-09); not duplicated here.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- Aggregates are the existing `Conversation → Message → ToolCall` (`04 §1`). A conversation is created lazily on the first projected event for a session.
- Projection rules (`packages/core/src/conversation/projection-rules.ts`, pure and unit-tested):
  - `NormalizedEvent.kind` → message role: `user_turn → user`, `assistant_turn → assistant`, `tool_call|tool_result → tool` (attached to the owning assistant message when `parentExternalId` is known, otherwise standalone), `notice|rate_limit|error → system`.
  - Idempotency: `external_id` from the vendor payload (hook event id, stream-json message id, RPC item id). Missing external id ⇒ derive `sha256(sessionId + ts + kind + first 256 chars)`; re-ingestion of the same payload must not duplicate.
  - Ordering: by `ts`, tie-broken by ingestion sequence. Out-of-order arrivals (hook before stream line) insert at the right position rather than appending.
  - Redaction at projection time: the same secret regexes as the recorder (C13) run over `content` and `args_json` before the row is written; `message_tool_calls.args_json` is stored redacted — Chat never has an unredacted copy to leak.
  - Unknown event kinds are stored as `system` messages with `content = kind` and a `raw: false` marker; they must never throw (`Result.err` counted by the Doctor, M6-02).
- Command rules (from M2-03 manifests): a command with `approval: 'confirm'` requires a user confirmation object before send; `ackEvent: 'none'` renders as *sent (no ack available)* rather than pretending success; an unverified manifest marks every command with a warning badge but does not block it.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/conversation/types.ts
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export interface ProjectedMessage {
  externalId: string; conversationId: ConversationId; role: MessageRole;
  content: string; ts: string; partial: boolean;
  toolCalls: readonly ProjectedToolCall[];
  notice?: { kind: 'rate_limit' | 'model_switched' | 'compact' | 'error' | 'unknown'; detail?: string };
}
export interface ProjectedToolCall {
  externalId: string; tool: string; argsRedacted: string; resultSummary: string | null; durationMs: number | null;
  status: 'running' | 'ok' | 'error' | 'denied';
}
export function projectEvent(ev: NormalizedEvent, ctx: ProjectionContext): Result<ProjectionOp[], ProjectionError>;
// ProjectionOp = {op:'upsert-message'|'attach-tool-call'|'update-message'|'noop', …}

// apps/daemon/src/application/conversation/*.use-case.ts
export class ProjectSessionEvents { execute(cmd: { sessionId: SessionId; events: readonly NormalizedEvent[] }): Promise<Result<void, ProjectionError>>; }
export class GetConversation   { execute(q: { sessionId: SessionId; cursor?: string; limit: number }): Promise<Result<ConversationPage, SessionNotFound>>; }
export class SendSessionCommand {
  execute(cmd: { sessionId: SessionId; command: string; args: Record<string, string>; confirmed: boolean; idempotencyKey: string }):
    Promise<Result<{ ackState: 'acked' | 'sent-no-ack'; ackEvent?: string }, UnknownCommand | ConfirmationRequired | AckTimeout | SessionNotRunning>>;
}

// apps/web/src/features/chat/
export interface ChatMessageProps { message: ProjectedMessageDto; dense: boolean; onJumpToTerminal(): void }
export interface CommandPaletteProps {                     // cmdk, opened by '/' at composer start
  commands: TypedCommandDto[];                              // GET /api/sessions/:id/commands (M2-03)
  onPick(cmd: TypedCommandDto, args: Record<string,string>): void;
}
```

### 4.3 Data / schema changes
Tables `conversations`, `messages`, `message_tool_calls` exist in `04 §4`. Migration `m2_08_conversation_projection` adds: `messages.partial INTEGER NOT NULL DEFAULT 0`, `messages.notice_json TEXT NULL`, `messages.seq INTEGER NOT NULL` (ingestion sequence for stable ordering), unique index `(conversation_id, external_id)`, index `(conversation_id, ts, seq)`; `message_tool_calls.status TEXT NOT NULL DEFAULT 'ok'`. No new event types — the projector consumes the existing `session.*` / normalized telemetry stream and publishes UI deltas on `conversation:<sessionId>`; `session.commands_discovered` (M2-03) is consumed to refresh the palette.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- The projector subscribes to the M1-08 telemetry pipeline in-process (event bus, M0-05); it never reads PTY bytes and never spawns anything. Ingestion stays idempotent by `(providerId, sessionId, sourceGeneration, source.channel, source.externalId)` as the event store already requires.
- Command sending goes through the adapter's `PaneController.sendCommand` (M1-05..07): `transport: 'rpc'` → app-server call, `'slash'`/`'keys'` → keystrokes to the tmux pane through the `SessionSupervisor` actor (D13). Chat never talks to tmux directly and never sends raw keystrokes for a *prompt answer* — prompts use their declared `answerTransport` (D14).
- Backfill on open: if a session has fewer projected messages than events (e.g. the projector was added after the session started), `GetConversation` triggers a bounded replay of that session's stored events (max 5 000) before answering; anything beyond that is left to M5-02.

### 4.5 API / UI surface
- `GET /api/sessions/:id/conversation?cursor=&limit=` → `{ messages, nextCursor, totalApprox }`.
- WS `conversation:<sessionId>`: `{type:'append'|'update'|'tool-update'|'prompt'|'plan', payload}`.
- `POST /api/sessions/:id/commands/:name` → `{ args, confirmed, idempotencyKey }` → ack state; `409 ConfirmationRequired` when the manifest demands confirm and it was not given.
- `POST /api/sessions/:id/messages` (free-text prompt) — existing M1-12 endpoint, reused.
- `GET /api/sessions/:id/plans` → `plan_versions` rows for the plan cards.
- Chat screen (`apps/web/src/features/chat/`): `ChatScreen` (left: session list with provider·model·state and unread/attention badges; right: stream + composer), `MessageList` (virtualized, sticky day separators, "jump to latest" pill), renderers `UserMessage`, `AssistantMessage` (markdown + fenced code with copy, no HTML execution), `ToolCallRow` (collapsed by default: tool, duration, status; expands to redacted args + result summary), `NoticeRow` (rate limit shows `resetAt` with an *official/estimate* label), `InlinePromptCard` (M1-11 component), `PlanCard` (read-only, version selector, collapsed diff), `Composer` + `CommandPalette`.
- States: `loading`, `empty` ("no messages yet — the agent has not spoken"), `streaming` (partial assistant message with a subtle indicator, reduced-motion safe), `disconnected` (banner + queued composer input, sent on reconnect), `session-stopped` (composer disabled with reason), `error`.
- Keyboard: `/` at an empty composer opens the palette; `⌘↵` send; `↑` edits the last sent prompt; `⌘F` in-page find; `j/k` move between messages when the list has focus; `Esc` closes the palette. RTL: message alignment follows direction via logical properties; code blocks stay LTR inside an RTL page. Every status uses icon + text.

### 4.6 Flow / sequence
```
telemetry (hook / stream-json / app-server rpc)  ─▶ TelemetryParser (M1-08) ─▶ NormalizedEvent[]
   └─▶ ProjectSessionEvents ─▶ projectEvent() ─▶ ops ─▶ upsert messages/tool_calls (idempotent by external_id)
        └─▶ WS conversation:<sid> append|update ─▶ MessageList (virtualized, keeps scroll anchor)

open Chat ─▶ GET /api/sessions/:id/conversation (+ bounded backfill) ─▶ render
          ─▶ GET /api/sessions/:id/commands (M2-03) ─▶ palette source (refreshed on session.commands_discovered)

composer '/' ─▶ palette (native | workspace | user groups, effects + approval badges)
   ─▶ pick command ─▶ args form (from TypedCommand.args)
   ─▶ approval==='confirm' ─▶ confirm sheet ("this command writes files / spends quota")   [C10]
   ─▶ POST /api/sessions/:id/commands/:name ─▶ SendSessionCommand ─▶ PaneController.sendCommand
        ├─ ack event observed  ─▶ 'acked'          ─▶ composer shows ✓ acked
        ├─ ackEvent === 'none' ─▶ 'sent-no-ack'    ─▶ composer shows "sent (no ack available)"
        └─ timeout             ─▶ Err(AckTimeout)  ─▶ inline retry, command NOT re-sent automatically

prompt.opened (M1-11) ─▶ WS ─▶ InlinePromptCard at its ts position (and in Attention)
   ─▶ answer from Chat ─▶ AnswerPrompt (declared answerTransport) ─▶ card collapses to "answered by you"
plan_versions row ─▶ PlanCard (read-only; approve/edit arrives in M3-02)
```

## 5. Tasks
- [ ] `projection-rules.ts` in `packages/core` (pure): event→ops mapping, ordering, idempotency key derivation, redaction hooks, unknown-kind handling; 100 % branch tests.
- [ ] Migration `m2_08_conversation_projection` (columns, unique + ordering indexes) and repository methods for idempotent upsert.
- [ ] `ProjectSessionEvents` use case subscribed to the M1-08 pipeline; bounded backfill in `GetConversation`.
- [ ] `GET /api/sessions/:id/conversation` + `GET /api/sessions/:id/plans` controllers with cursor pagination and OpenAPI.
- [ ] WS topic `conversation:<sessionId>` with append/update/tool-update/prompt/plan deltas and resubscribe semantics.
- [ ] `SendSessionCommand` use case: manifest lookup, arg validation against `TypedCommand.args`, confirmation rule, `PaneController.sendCommand`, ack/timeout mapping, idempotency key.
- [ ] `POST /api/sessions/:id/commands/:name` controller with `ConfirmationRequired` semantics.
- [ ] `packages/ui`: `MessageBubble`, `ToolCallRow`, `NoticeRow`, `PlanCard`, `AckBadge` + stories (incl. very long output, error tool call, denied tool call).
- [ ] `apps/web`: `ChatScreen`, session list with attention badges, virtualized `MessageList` with scroll anchoring and "jump to latest".
- [ ] `Composer` + `CommandPalette` (cmdk) grouped by `origin`, showing effects/approval/verified badges, with arg entry and the confirm sheet.
- [ ] Inline prompt integration: reuse M1-11 renderers, shared answer path, state sync with Attention (answering in one place closes it in the other).
- [ ] In-page find, copy-message, jump-to-terminal / jump-to-task links.
- [ ] Perf harness: 10 000 messages seeded via FakeProvider; measure scroll fps and memory against the M0-07/12-ux budgets.
- [ ] a11y + RTL pass (axe, keyboard-only, screen-reader announcement for new assistant messages, reduced motion).
- [ ] Playwright E2E covering render, palette send with ack, confirm-required command, inline prompt answer, reconnect.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-08-01 | unit | `projectEvent` over the recorded fixture set for claude and codex | every fixture yields ops; no throw; roles as specified in §4.1 |
| UT-M2-08-02 | unit | same payload projected twice (duplicate hook delivery) | second run is a no-op; message count unchanged (idempotency) |
| UT-M2-08-03 | unit | out-of-order arrival (tool_result before tool_call, hook before stream line) | final ordering by `ts`,`seq`; tool call attached to the right message |
| UT-M2-08-04 | unit | payload containing a token-shaped string | redacted in `content` and `args_json` before write (C13) |
| UT-M2-08-05 | unit | unknown event kind | `system` message with the kind as content; `Result.ok`, counted, never thrown |
| AT-M2-08-01 | application | `SendSessionCommand` for a `approval:'confirm'` command without confirmation | `Err(ConfirmationRequired)`; nothing sent to the pane (C10) |
| AT-M2-08-02 | application | command whose `ackEvent` never arrives | `Err(AckTimeout)` after the manifest timeout; no automatic resend |
| CT-M2-08-01 | contract | palette source vs `GET /api/sessions/:id/commands` for every adapter incl. FakeProvider | every returned command has label, transport, effects, approval and a resolvable ack expectation |
| IT-M2-08-01 | integration | FakeProvider session emitting the full scripted scenario | conversation matches the expected transcript; tool calls have durations; rate-limit notice rendered with `resetAt` |
| IT-M2-08-02 | integration | open Chat for a session whose events predate the projector | backfill produces the same transcript as live projection (bounded at 5 000 events) |
| E2E-M2-08-01 | e2e | `/` palette: pick a no-effect command, send | composer shows acked; message appears in the stream |
| E2E-M2-08-02 | e2e | inline prompt answered from Chat | prompt card collapses; the same prompt disappears from Attention; agent continues |
| E2E-M2-08-03 | e2e | 10 000 seeded messages | initial paint < 1.5 s, scroll ≥ 55 fps, memory within budget |
| E2E-M2-08-04 | e2e | axe scan, light/dark, LTR/RTL, keyboard-only send | no critical/serious violations |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-08-01 | Live conversation on Claude Code | 1. Start an interactive Claude session from Fleet 2. Open Chat 3. Ask it to read a file and summarise it | User turn, assistant turn and the file-read tool call appear with duration and redacted args; content matches what the terminal shows; no PTY escape codes leak into the text | ⬜ |
| TC-M2-08-02 | Live conversation on Codex | 1. Repeat TC-01 on a Codex session | Same structure via app-server RPC items; model-switch and usage notices render as system rows | ⬜ |
| TC-M2-08-03 | `/` palette incl. a workspace command | 1. Put a custom command file in the workspace commands dir (as in TC-M2-03-02) 2. In Chat type `/` | Palette lists native and workspace commands grouped, with effects/approval badges and a verified marker; picking one with args shows the arg form | ⬜ |
| TC-M2-08-04 | Command ack | 1. Send a harmless native command (e.g. the model command) 2. Watch the composer | Shows *sending* then *acked* (or *sent (no ack available)* where the manifest says `ackEvent: none`); the terminal shows the same effect | ⬜ |
| TC-M2-08-05 | Confirm-required command | 1. Pick a command whose manifest marks `writes-fs` or `spends-quota` | A confirm sheet appears first, naming the effect; cancelling sends nothing; confirming sends once (C10) | ⬜ |
| TC-M2-08-06 | Inline prompt answered from Chat | 1. Ask the agent to do something that triggers a permission prompt 2. Answer from Chat | Prompt renders inline within 2 s, answering unblocks the agent, and the item disappears from Attention without a reload | ⬜ |
| TC-M2-08-07 | Plan card | 1. Put the agent into plan mode (or let it write a plan) so a `plan_versions` row exists | A read-only plan card renders with version and source; switching versions shows the collapsed diff; no approve/edit controls (deferred to M3-02) | ⬜ |
| TC-M2-08-08 | Negative: secret never rendered | 1. Have the agent echo a fake token-shaped string (`sk-` + random) in a tool argument | The value is redacted in the tool-call row and in the DB row; the terminal may show it, Chat must not (C13) | ⬜ |
| TC-M2-08-09 | Restart / resilience | 1. With Chat open on a running session, `kill -9` the daemon 2. Restart | Banner appears, composer input is preserved and queued; after restart the stream resubscribes, missed messages are backfilled in order, and a queued message is sent once (not twice) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Conversations render for real Claude Code and Codex sessions and match the terminal's semantic content (TC-M2-08-01/02); no regex-over-PTY anywhere in the path (C7, enforced by the existing ESLint rule).
- [ ] Projection is idempotent and order-stable: replaying a session's events produces byte-identical rows (UT-M2-08-02/03, IT-M2-08-02).
- [ ] Secrets are redacted before the message row is written; TC-M2-08-08 verified on a real session (C13).
- [ ] `/` palette lists native + discovered commands with effects, approval and verified badges; confirm-required commands cannot be sent without confirmation (C10).
- [ ] Ack semantics are honest: acked / sent-no-ack / timeout are distinct states and a timeout never auto-resends (R5).
- [ ] Prompts answered in Chat and in Attention are one durable object with one answer path (D14) — answering in either closes both.
- [ ] 10 000-message conversation stays within the UX budgets (E2E-M2-08-03); axe clean in light/dark and RTL.
- [ ] All TC-M2-08-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Coverage of the conversation depends entirely on what each adapter normalizes in M1-08. Claude Code (stream-json + hooks) and Codex (app-server items) are expected to be rich; `agy` may only yield coarse events — *(verify what the Antigravity stream-json output contains at step start)*. Chat must degrade to "tool calls only" gracefully rather than looking broken; the session list shows a "limited transcript" marker when the adapter declares fewer telemetry sources.
- Markdown rendering is an injection surface. Render with a sanitising renderer, no raw HTML, no remote images (external fetches would also trip the egress rule, C2); code blocks are plain text with a copy button.
- Message-level (not token-level) updates may feel laggy for long assistant turns. Partial messages are updated in place as chunks arrive; if TC-M2-08-01 feels bad, the fix is a smaller update interval, not a second streaming channel.
- Backfill bound (5 000 events) is arbitrary and protects the first paint. Sessions older/longer than that show a "older messages available in History (M5)" marker rather than silently truncating.
- Sending commands from Chat while the user also types in the terminal can interleave input. `SessionSupervisor` serialises writes per pane (D13); the composer is disabled while a command is un-acked to make the ordering visible.
- The step is scheduled ∥ with M2-03; if manifests are not complete yet, the palette falls back to `manifest.commands` from M1 with a "partial command list" badge — acceptable for development, but TC-M2-08-03 must be re-run after M2-03 lands.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
