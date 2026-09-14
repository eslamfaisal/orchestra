# Step M5-02 — Conversation & tool-call capture v2

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M1-08 (telemetry plane & fixture recorder), M1-05/M1-06/M1-07 (adapters), M5-01 (`packages/core/src/redaction`) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, `apps/daemon` (`src/application/history`, `src/infrastructure/session-log`, `src/interface/http`), `apps/cli`, `apps/web` |
| Risk | Medium |
| Owner | |

## 1. Goal
Every message, tool call and attachment exchanged in a session — from any provider, interactive or headless — is normalised into `conversations / messages / message_tool_calls / attachments`, idempotently keyed by the vendor's own ids, with tool arguments redacted. The user opens a session (Chat screen if M2-08 exists, otherwise `GET /sessions/:id/conversation`) and sees the full transcript within 2 s of it happening in the pane, and can back-fill older vendor session logs with `orch history import`.

## 2. Why
- G5: chat is the human-readable half of "total recall"; M5-03 search and M5-04 replay are built on these rows.
- D4: state comes only from official channels — hooks, stream-json, app-server RPC, and the CLI's own session log files on disk. Nothing is scraped from the PTY (C7).
- D5: each provider's parser lives in its plugin; core sees only `NormalizedEvent`.
- C3/C13: tool arguments can contain secrets (env dumps, curl headers); they pass the redactor before write (`message_tool_calls.args_json(redacted)` in `04-domain-model.md`).
- Engineering standard "Idempotency: hook/stream ingestion keyed by external id".

## 3. Scope
### In scope
- `TelemetrySource = 'session-log'` implemented for Claude Code (session JSONL under the Claude projects dir — verify path at step start), extending the existing `hook` and `stream-json` sources.
- Codex conversation from app-server thread/turn/item notifications and `exec --json` events (names per the pinned schema fixture from M1-06 — verify).
- Antigravity conversation from `--output-format stream-json` lines (opt-in adapter, C11).
- New `NormalizedEvent` kinds for conversation; `IngestConversationEvents` use case; upserts by `(conversation_id, external_id)`.
- Attachments: files referenced by messages (images pasted, files the agent attached) copied into `~/.orchestra/attachments/`, size-capped, hashed.
- Redaction of tool args and message content via `packages/core/src/redaction`.
- Backfill: `POST /history/imports` + `orch history import --provider <id> --path <file|dir> [--session <id>]`.
- Session-log tailer (offset-tracked, restart-safe) in `apps/daemon/src/infrastructure/session-log/`.
- Fixtures per provider: `fixtures/<cliVersion>/session-log/*.jsonl`, `rpc/thread-items.json`, `stream/conversation.jsonl`.
### Out of scope (deferred to …)
- FTS indexing of messages — deferred to M5-03 (triggers are added there).
- Rendering (markdown, code blocks, tool cards) — M2-08 Chat screen; this step ships only a minimal read-only transcript view.
- Retention / purge of attachments — deferred to M5-06.
- Kimi / OpenCode parsers — deferred to M10-04 / M10-05 (they implement the same `NormalizedEvent` kinds).
- Cloud-session transcripts (Claude web, Codex cloud) — deferred to M7-07.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Conversation` (root, 1:1 with `Session`): `{ id, sessionId, providerId, externalThreadId?, startedAt, lastMessageAt, messageCount }`.
- `Message`: `{ id, conversationId, seq, role: 'user'|'assistant'|'system'|'tool', kind: 'text'|'tool_call'|'tool_result'|'thinking_summary'|'plan'|'error', content, ts, externalId, parentExternalId?, usage?, redacted: boolean }`.
- `ToolCall` (child of Message): `{ id, messageId, externalId, tool, argsRedacted (JSON), state: 'requested'|'approved'|'denied'|'completed'|'failed', resultSummary?, durationMs? }`.
- `Attachment`: `{ id, messageId, path, mime, bytes, sha256, origin: 'user'|'agent'|'import' }`.
- Rules: `seq` is strictly increasing per conversation and assigned by the ingest use case (never by the vendor); a `tool_result` must reference an existing `ToolCall` by `externalId` or is stored as an orphan with `state='completed'` and a `parse.orphan_result` warning; messages are immutable except `redacted` rewrite (M5-06); `externalId` uniqueness is per conversation, not global.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/telemetry.ts — additions to NormalizedEvent (M1-08)
export type ConversationEvent =
  | { kind: 'message.user';       sessionId: SessionId; externalId: string; ts: string; content: string; attachments?: AttachmentRef[] }
  | { kind: 'message.assistant';  sessionId: SessionId; externalId: string; ts: string; content: string; usage?: Usage; parentExternalId?: string }
  | { kind: 'message.tool_call';  sessionId: SessionId; externalId: string; ts: string; tool: string; args: unknown; parentExternalId?: string }
  | { kind: 'message.tool_result';sessionId: SessionId; externalId: string; ts: string; callExternalId: string; summary: string; ok: boolean; durationMs?: number }
  | { kind: 'message.system';     sessionId: SessionId; externalId: string; ts: string; content: string }
  | { kind: 'thread.started';     sessionId: SessionId; externalThreadId: string; ts: string };
export interface AttachmentRef { path: string; mime?: string; origin: 'user'|'agent' }

// packages/sdk/src/adapter.ts — TelemetryParser.sources() may now return 'session-log'; new optional member
export interface SessionLogLocator {                // provider-owned: where the CLI writes its own transcript
  locate(spec: { sessionId: SessionId; cwd: string; externalSessionId?: string }): Result<string[], AdapterError>; // candidate file paths
}

// packages/core/src/ports/conversation-repository.ts
export interface ConversationRepository {
  upsertMessage(m: Message): Promise<Result<'inserted'|'skipped', RepoError>>;   // skipped ⇒ (conversationId, externalId) existed
  upsertToolCall(t: ToolCall): Promise<Result<'inserted'|'updated'|'skipped', RepoError>>;
  attach(a: Attachment): Promise<Result<void, RepoError>>;
  transcript(sessionId: SessionId, page: Page): Promise<Result<Message[], RepoError>>;
}

// apps/daemon/src/application/history/ingest-conversation-events.ts
export class IngestConversationEvents { execute(events: ConversationEvent[]): Promise<Result<IngestReport, IngestError>>; }
export interface IngestReport { inserted: number; skipped: number; orphans: number; redactedFields: number }
```
Other use cases (one class each): `TailSessionLog` (starts/stops a tailer per session), `ImportSessionLog` (backfill), `GetTranscript`. DI map `SessionLogLocator` keyed by `ProviderId`; adapters without one simply have no `session-log` source.

### 4.3 Data / schema changes
Migration `0051_conversations_v2` (extends `04-domain-model.md` §4):
- `conversations` add `provider_id text not null`, `external_thread_id text null`, `started_at text`, `last_message_at text`, `message_count integer default 0`; unique `(session_id)`.
- `messages` add `seq integer not null`, `kind text not null default 'text'`, `parent_external_id text null`, `usage_json text null`, `redacted integer not null default 0`; unique `(conversation_id, external_id)`; index `(conversation_id, seq)`.
- `message_tool_calls` add `external_id text`, `state text not null default 'requested'`; unique `(message_id, external_id)`.
- `attachments` add `bytes integer`, `sha256 text`, `origin text`; unique `(message_id, sha256)`.
- `session_log_offsets(session_id, path, byte_offset, updated_at)` primary key `(session_id, path)` — restart-safe tail position.
Config: `features.history.capture: boolean`, `history.attachments.dir`, `history.attachments.maxBytes` (25 MB per file), `history.sessionLog.pollMs` (1000, used only when `fs.watch` is unavailable).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Claude Code**: `ClaudeSessionLogLocator` resolves `~/.claude/projects/<encoded cwd>/<externalSessionId>.jsonl` (verify path and encoding against Claude Code docs at step start; the external session id comes from the `SessionStart` hook payload captured in M1-05). `SessionLogTailer` reads from the stored offset, splits lines, hands each to `adapter.telemetry.parse({source:'session-log', line})`. Headless runs already deliver stream-json (M1-08); both sources may describe the same message — dedup by `externalId`.
- **Codex**: no file tailing; the app-server client (M1-06) forwards thread/turn/item notifications as `RawTelemetry{source:'app-server'}`; `codex exec --json` lines as `stream-json`. The item kinds mapped to `message.*` follow the pinned schema fixture (verify names at step start).
- **Antigravity**: `agy --output-format stream-json` lines already parsed for prompts in M1-07; extend the parser with conversation kinds (verify line schema at step start). Interactive agy sessions without stream-json have no conversation source; the session page says "transcript unavailable for interactive agy sessions".
- Attachments: copy (never move) referenced files into `history.attachments.dir/<sha256[0:2]>/<sha256>` with `0600`; refuse > `maxBytes` and record `attachments.skipped_oversize` warning; paths outside the worktree/cwd are refused (no arbitrary file exfiltration into history).
- Redaction: `args` → JSON stringify → `Redactor` → parse back; if not valid JSON after redaction, store `{ "_redacted": "<string>" }`.
- Importer: streams a file or directory; each file is parsed with the provider's parser; `--session` binds to an existing session, otherwise creates an `imported` session row (`state='stopped'`, `headless=0`, `origin='import'`).

### 4.5 API / UI surface
- `GET /sessions/:id/conversation?after=<seq>&limit=` → `{ messages: Message[], toolCalls: ToolCall[], attachments: Attachment[] }`.
- `GET /attachments/:id` → file stream (auth required).
- `POST /history/imports` `{ providerId, path, sessionId? }` (Zod) → `202 { importId }`; `GET /history/imports/:id` → `IngestReport` + state; `Idempotency-Key` honoured.
- WS topic `conversation.<sessionId>`: `{ type: 'message.ingested', seq, messageId }` (UI fetches by `after=seq`).
- CLI (`apps/cli`, minimal command; full CLI in M7-06): `orch history import --provider claude --path ~/.claude/projects/... [--session <id>] [--json]`.
- Web: `SessionTranscript` read-only list (role badge, content, tool call rows with `args` collapsed, attachment chips) reachable from the session page; live-updates via the WS topic. States: empty ("no transcript yet"), loading, error, "unavailable for this session kind".

### 4.6 Flow / sequence
```
hook / stream-json / app-server ──▶ TelemetryPipeline (M1-08) ──▶ adapter.telemetry.parse ──▶ NormalizedEvent[]
session.launched ──▶ TailSessionLog ──▶ SessionLogLocator.locate ──▶ SessionLogTailer(offset) ──▶ parse ──▶ NormalizedEvent[]
NormalizedEvent[] ─ filter ConversationEvent ─▶ IngestConversationEvents
   ├─ ensure Conversation (create on first event)
   ├─ redact content/args
   ├─ upsertMessage / upsertToolCall / attach   (idempotent by externalId; 'skipped' counted)
   ├─ save session_log_offsets
   └─ emit ws conversation.<sid> message.ingested
orch history import ──▶ POST /history/imports ──▶ ImportSessionLog ──▶ same ingest path, batched 500 events/txn
```

## 5. Tasks
- [ ] Add `ConversationEvent` kinds + Zod schemas to `packages/sdk/src/telemetry.ts`; `SessionLogLocator` optional adapter member.
- [ ] Domain: `Conversation`, `Message`, `ToolCall`, `Attachment` entities + rules in `packages/core/src/conversation/`.
- [ ] Migration `0051_conversations_v2`; `SqliteConversationRepository`; `session_log_offsets`.
- [ ] Claude adapter: `session-log` source parser + `ClaudeSessionLogLocator`; record fixtures `session-log/*.jsonl` with `orch fixtures record claude` (redacted, `RECORDED.md` updated).
- [ ] Codex adapter: map app-server thread/turn/item notifications and `exec --json` events to `ConversationEvent`; fixtures `rpc/thread-items.json`.
- [ ] Antigravity adapter: extend stream-json parser; fixtures `stream/conversation.jsonl`.
- [ ] `SessionLogTailer` (fs.watch + poll fallback, offset persistence, partial-line buffering).
- [ ] Use cases `IngestConversationEvents`, `TailSessionLog`, `ImportSessionLog`, `GetTranscript`.
- [ ] Attachment copier with size cap, sha256, path allowlist.
- [ ] Tool-args redaction path using `createStreamingRedactor` (single-shot mode).
- [ ] HTTP controller (`/sessions/:id/conversation`, `/attachments/:id`, `/history/imports`), WS topic, OpenAPI.
- [ ] `orch history import` command in `apps/cli`.
- [ ] `SessionTranscript` component in `apps/web` with WS live update.
- [ ] Contract test additions in `packages/sdk/src/contract/telemetry.contract.spec.ts`: every provider fixture with a conversation yields ≥ 1 `message.*` event with `externalId`.
- [ ] FakeProvider scenario `conversation-basic.yaml` (user msg, assistant msg, tool call + result, attachment, duplicate replay).
- [ ] Package README + `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-02-01 | unit | `IngestConversationEvents` with in-memory repo: same batch applied twice | second run `inserted=0`, `skipped=n`; `seq` unchanged |
| UT-M5-02-02 | unit | tool_result arriving before its tool_call | stored as orphan; when the call arrives later it links and `orphans` decrements |
| UT-M5-02-03 | unit | args containing `Authorization: Bearer x…`, `AKIA…` | stored `args_json` has `[REDACTED:*]`; `redactedFields` counted |
| UT-M5-02-04 | unit (fast-check) | `SessionLogTailer` line splitter with random chunk boundaries and CRLF | every JSON line delivered exactly once; partial last line buffered |
| AT-M5-02-01 | adapter contract | Claude `session-log` fixtures, Codex `rpc/thread-items.json`, agy `stream/conversation.jsonl` | each yields ordered `message.*` events with `externalId`; unknown lines → `ParseError`, no throw |
| IT-M5-02-01 | integration (sqlite) | FakeProvider `conversation-basic.yaml` end-to-end | rows in all four tables; attachment copied with sha256; WS `message.ingested` per message |
| IT-M5-02-02 | integration | daemon restart mid-tail (offset persisted) | no duplicate and no missing messages after restart |
| E2E-M5-02-01 | e2e | `SessionTranscript` live update | new message visible ≤ 2 s after scenario emits it |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-02-01 | Claude Code interactive transcript via session log | 1. Start Claude Code session in `~/orchestra-scratch/`. 2. Ask "list the files here and tell me the count". 3. Open session page → Transcript. | User message, assistant message, `Bash`/`Glob` tool call with redacted args and result summary appear in order; `external_id` filled; `session_log_offsets` row advances | ⬜ |
| TC-M5-02-02 | Claude headless (stream-json) + session log dedup | 1. Quick Delegate (M1-12) a task headless on Claude. 2. Compare `messages` count with the stream-json line count for assistant messages. | No duplicates even though both sources saw the same messages; `skipped` > 0 in the import report | ⬜ |
| TC-M5-02-03 | Codex app-server transcript | 1. Start Codex session. 2. Ask it to create `a.txt`. 3. Open Transcript. | Messages and an `apply_patch`/exec tool call with state `completed`; `external_thread_id` set on the conversation | ⬜ |
| TC-M5-02-04 | Antigravity opt-in transcript | 1. With ToS acknowledged, run a headless agy task. 2. Open Transcript. | Messages present with `provider_id='agy'`; interactive agy session page shows "transcript unavailable" text, no error | ⬜ |
| TC-M5-02-05 | Backfill with `orch history import` | 1. Pick an older Claude session JSONL from the projects dir (verify path). 2. `orch history import --provider claude --path <file>`. 3. Run the same command again. | First run: new `imported` session + messages; second run: report `inserted=0`; transcript viewable | ⬜ |
| TC-M5-02-06 | Attachment capture | 1. In Claude Code paste a small PNG (or reference a file) in a message. 2. Open Transcript. | Attachment chip; `GET /attachments/:id` returns the bytes; file exists under `attachments/<sha>` with mode `0600` | ⬜ |
| TC-M5-02-07 | Oversize / outside-cwd attachment (negative) | 1. Set `maxBytes=1KB`. 2. Reference a 2 MB file and a file under `/etc`. | Both skipped; warnings `attachments.skipped_oversize` / `attachments.path_refused` in logs; transcript still shows the message text | ⬜ |
| TC-M5-02-08 | Restart during active tail (resilience) | 1. Long Claude task producing many messages. 2. `kill -9` daemon mid-task; restart after 20 s. | Transcript has every message the session log has; no duplicates; tailer resumed from the stored offset (log line `tail.resumed offset=…`) | ⬜ |
| TC-M5-02-09 | Malformed line does not stop ingestion (negative) | 1. Append a garbage line to a copy of a session log. 2. Import it. | Report shows 1 `ParseError`; all other lines ingested; Doctor counter `telemetry.unknown_payload` incremented | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M5-02-01 … 09 pass on real Claude Code and Codex (agy if opted in).
- [ ] Ingestion is idempotent: replaying any fixture or importing any file twice inserts 0 rows (UT-01, TC-05).
- [ ] No tool argument or message content containing a fixture secret is stored unredacted (UT-03 + grep over DB dump).
- [ ] Contract tests for all three adapters include a conversation fixture pinned to the CLI version in `RECORDED.md`.
- [ ] Transcript visible in the web ≤ 2 s after the message appears in the pane (E2E-01, TC-01).
- [ ] Restart-safe tailing proven (IT-02, TC-08).
- [ ] Attachments never copied from outside the session's cwd/worktree; size cap enforced.
- [ ] No new lint / dependency-cruiser violations (`packages/providers/*` import only `sdk`); OpenAPI updated; package README written.

## 8. Risks / open questions
- Claude Code session JSONL location, file naming and line schema (verify against Claude Code docs at step start); if the directory layout changes, the locator is a one-line adapter fix and Doctor (M6) flags it via fixture drift.
- Codex app-server item kinds and their stability (experimental; ADR-009): mapping is fixture-driven; `exec --json` fallback must produce the same `ConversationEvent`s (verify against Codex docs at step start).
- Antigravity stream-json line shapes for assistant text vs tool calls (verify against Antigravity docs at step start); C11 forbids any other source.
- Double-source dedup depends on both sources exposing the same message id; if Claude's stream-json and JSONL ids differ, prefer JSONL as canonical and mark stream-json messages `parentExternalId`-linked (decide during fixture recording).
- Tailing many session logs with `fs.watch` on macOS can hit descriptor limits with 50 panes; measure in the load test, fall back to polling above a threshold.
- Attachments increase disk use silently; the M5-06 sweeper must count them in the global budget.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
