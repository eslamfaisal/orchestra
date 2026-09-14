# Step M5-03 — FTS5 search

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M5-02 (conversations v2), M0-05 (event store), M0-07 (web shell) |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core`, `apps/daemon` (`src/application/history`, `src/infrastructure/db/migrations`, `src/infrastructure/search`, `src/interface/http`), `apps/web`, `packages/ui` |
| Risk | Low |
| Owner | |

## 1. Goal
The user types a word or phrase into the History screen and gets ranked results with highlighted snippets across every message, tool call, event payload, review finding and plan version Orchestra has stored — filtered by provider, session, mission, date and kind — and each hit deep-links to its exact moment in the Timeline (M5-04). Search is local (SQLite FTS5), answers in ≤ 150 ms p95 on 100 k messages, and stays in sync automatically through triggers.

## 2. Why
- G5 "searchable": recall without search is a filesystem full of logs.
- ADR-010 / D8: SQLite with FTS5 is the accepted local-first store; the `SearchPort` abstraction keeps the Postgres driver swap (M9-05, `tsvector`) a pure infrastructure change.
- D3/D7 downstream: routing decisions and review findings become searchable evidence ("why did we choose model X for this task type").
- `12-ux-principles.md`: History screen ships in M5-04; this step provides its data path and the first version of the screen (search only).

## 3. Scope
### In scope
- FTS5 virtual tables `fts_messages`, `fts_events`, `fts_review_findings`, `fts_plan_versions` with maintenance triggers.
- Allowlist of `events.type` namespaces indexed; body flattening of `payload_json`.
- Safe query builder (user text → FTS5 MATCH expression), `bm25` ranking, `snippet()` highlights.
- `SearchPort` + `SqliteFts5Search`; `SearchHistory` use case with filters and cursor paging.
- `GET /history/search` endpoint; History screen v1 (search box, filter chips, grouped results, keyboard navigation, deep links).
- One-off reindex command `orch history reindex` and boot integrity check (`integrity-check` of FTS tables).
- Tables for review findings and plan versions are indexed now (schema v1 exists from M0-04); real content arrives in M3-02/M3-04 — tests use seeded rows.
### Out of scope (deferred to …)
- Timeline deep-link target screen — M5-04 (this step emits the URL; M5-04 renders it).
- Semantic / embedding search — not planned for 1.0 (see `RISKS.md` R16 bandwidth).
- Searching recording bytes (terminal output) — never; C7 forbids parsing PTY bytes for state and recordings may contain noise; transcripts are the searchable form.
- Postgres `tsvector` implementation — M9-05.
- Redaction-driven reindex — M5-06 (uses the triggers added here; nothing extra needed).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `SearchQuery` value object: `{ text, kinds?: SearchKind[], providerId?, sessionId?, missionId?, from?, to?, limit (≤ 100), cursor? }`. `SearchKind = 'message'|'tool_call'|'event'|'review_finding'|'plan_version'`.
- `SearchHit`: `{ docId, kind, snippetHtml (only `<mark>` allowed), ts, sessionId?, missionId?, providerId?, rank, deepLink }`.
- Rules (pure): empty/whitespace `text` → `Err(EmptyQuery)`; the query builder tokenises user text into terms, quotes each as `"term"`, keeps `"…"` phrases, supports trailing `*` prefix and leading `-` NOT, joins with implicit AND; any other FTS syntax characters are escaped — a raw user string never reaches `MATCH`.
- Deep link rule: `message`/`tool_call` → `/timeline/:sessionId?msg=<id>`; `event` → `/timeline/:sessionId?event=<id>` (or `/missions/:missionId` when no session); `review_finding` → `/review/:taskId?finding=<id>`; `plan_version` → `/missions/:missionId?plan=<id>`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/ports/search-port.ts
export interface SearchPort {
  search(q: SearchQuery): Promise<Result<SearchPage, SearchError>>;
  reindex(kind?: SearchKind): Promise<Result<{ indexed: number }, SearchError>>;
  integrity(): Promise<Result<{ ok: boolean; issues: string[] }, SearchError>>;
}
export interface SearchPage { hits: SearchHit[]; nextCursor?: string; total?: number; tookMs: number }
export type SearchError = { code: 'EmptyQuery' | 'BadQuery' | 'IndexUnavailable' | 'StoreIo'; message: string };

// packages/core/src/search/query-builder.ts (pure, 100 % branch)
export function buildMatchExpression(userText: string): Result<string, SearchError>;   // e.g. `"rate" "limit"*`  ,  `"exact phrase" NOT "foo"`

// apps/daemon/src/application/history/search-history.ts
export class SearchHistory { execute(q: SearchQuery, actor: Actor): Promise<Result<SearchPage, SearchError>>; }
```
Zod schemas at the edge: `SearchQuerySchema` (query string params), `SearchPageSchema` (response). `snippetHtml` is produced server-side with fixed `<mark>`/`</mark>` tokens; the web renders it through a sanitiser that permits only `<mark>`.

### 4.3 Data / schema changes
Migration `0052_fts5` (all FTS5, `tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_-./'''` so identifiers and paths stay whole tokens):
- `fts_messages(doc_id UNINDEXED, kind UNINDEXED, session_id UNINDEXED, mission_id UNINDEXED, provider_id UNINDEXED, ts UNINDEXED, body)` — one row per message **and** one per tool call (`kind='tool_call'`, body = `tool` + redacted args + result summary).
- `fts_events(doc_id, type UNINDEXED, session_id, mission_id, task_id, ts, body)` — only types matching the allowlist `prompt.* task.* mission.* routing.* quota.rate_limited doctor.* provider.*`; body = flattened string leaves of `payload_json` joined by spaces, plus `type`.
- `fts_review_findings(doc_id, task_id, mission_id, review_id, ts, body)` — body = `severity file:line message`.
- `fts_plan_versions(doc_id, mission_id, session_id, version, ts, body)` — body = `content`.
- Standard (not external-content) FTS tables: text is duplicated but rows are keyed by ULID `doc_id`, which avoids rowid coupling (VACUUM-safe) and keeps Postgres parity simple. Triggers `AFTER INSERT/UPDATE OF content,redacted/DELETE` on `messages`, `message_tool_calls`, `review_findings`, `plan_versions`, and `AFTER INSERT/DELETE` on `events` (events are never updated) maintain the FTS rows by `doc_id`.
- `mission_id` for messages is resolved at trigger time via `sessions.task_id → tasks.mission_id` (nullable).
- Config: `features.history.search: boolean`, `history.search.maxLimit` (100), `history.search.snippetTokens` (12).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `SqliteFts5Search` (`apps/daemon/src/infrastructure/search/`): parameterised Kysely raw queries: `SELECT doc_id, kind, …, bm25(fts_messages, 0,0,0,0,0,0,1.0) AS rank, snippet(fts_messages, 6, '<mark>', '</mark>', '…', ?) FROM fts_messages WHERE fts_messages MATCH ? AND (session_id = ? OR ?) … ORDER BY rank LIMIT ? OFFSET ?`. Kinds are queried separately and merged by rank (bounded by `limit` each) — simpler than a UNION over tables with different columns.
- Cursor = opaque base64 of `{ offsets per kind }`; `total` only computed when `limit` ≤ 20 (count query is O(n) in FTS5).
- `reindex`: `DELETE` + repopulate per kind inside one transaction, batched 5 000 rows; boot runs `INSERT INTO fts_x(fts_x) VALUES('integrity-check')` and, on failure, schedules a reindex and logs `search.reindex_scheduled`.
- Write path cost: triggers run inside the ingest transaction (M5-02) — the load test asserts ingest p95 stays < 5 ms per message with FTS on.
- No network; no external processes.

### 4.5 API / UI surface
- `GET /history/search?q=&kind=message,event&provider=&sessionId=&missionId=&from=&to=&limit=&cursor=` → `SearchPage`. Errors: `400 BadQuery|EmptyQuery`, `503 IndexUnavailable` (reindex in progress).
- `POST /history/reindex` (admin-only guard placeholder until M9-01) → `202`; CLI `orch history reindex [--kind]`.
- WS: none (search is request/response).
- Web `HistoryPage` (`apps/web/src/screens/history/`): `SearchBox` (⌘K-focusable, `⌘⇧F` from anywhere), `FilterChips` (kind, provider, date range presets, mission/session pickers), `ResultList` grouped by session with header `provider · model · task · date`, snippet with `<mark>`, `↑/↓` navigate, `Enter` opens deep link, `⌘Enter` opens in Timeline in a new tab. States: idle (recent sessions), loading (skeleton), empty ("no results — try fewer filters"), error (`code` + retry), index-rebuilding banner. RTL-safe (logical properties), snippet direction auto (`dir="auto"`).
- `packages/ui`: `SnippetText` component (sanitised `<mark>` rendering) reused by M5-04.

### 4.6 Flow / sequence
```
messages/tool_calls/events/findings/plans INSERT ─▶ trigger ─▶ fts_* INSERT (same txn)
UI SearchBox (debounce 150 ms) ─▶ GET /history/search ─▶ Zod parse ─▶ SearchHistory
   ├─ buildMatchExpression(text) → Err(EmptyQuery|BadQuery) → 400
   ├─ SearchPort.search per kind (bounded) → merge by rank → nextCursor
   └─ map deepLink per hit → SearchPage
Result click ─▶ navigate(deepLink) ─▶ Timeline (M5-04) seeks to msg/event
```

## 5. Tasks
- [ ] `packages/core/src/search/`: `SearchQuery`, `SearchHit`, `buildMatchExpression` (100 % branch), deep-link mapper.
- [ ] `SearchPort` in `packages/core/src/ports/`.
- [ ] Migration `0052_fts5`: four FTS tables + triggers + events allowlist; payload flattening as a SQL-side JSON walk (`json_tree`) — verify `json_tree` availability in the pinned better-sqlite3 build at step start.
- [ ] `SqliteFts5Search` with parameterised queries, per-kind merge, cursor, `reindex`, `integrity`.
- [ ] `SearchHistory` use case + `ReindexSearch` use case; boot integrity check hook in the daemon lifecycle.
- [ ] HTTP controller `/history/search`, `/history/reindex`; OpenAPI; Zod schemas.
- [ ] `orch history reindex` in `apps/cli`.
- [ ] Seed fixture `fixtures/history/search-100k.sql` generator script (100 k messages, 20 k events, 2 k findings, 200 plans) for perf tests.
- [ ] `HistoryPage`, `SearchBox`, `FilterChips`, `ResultList`, `SnippetText` (`packages/ui`) with keyboard navigation and RTL check.
- [ ] Sanitiser for `snippetHtml` (allow `<mark>` only) + unit test with injected `<script>`.
- [ ] Load test addition: ingest p95 with triggers on; search p95 on the 100 k fixture.
- [ ] Package README + `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-03-01 | unit (fast-check) | `buildMatchExpression` on arbitrary strings incl. `"`, `(`, `NEAR`, `:`, `*`, `-` | never throws; output is either `Err` or a string FTS5 accepts (round-trip through an in-memory sqlite `MATCH`) |
| UT-M5-03-02 | unit | deep-link mapper for every `SearchKind` with/without session/mission | correct URL; missing ids fall back to mission/review routes |
| UT-M5-03-03 | unit | snippet sanitiser | `<mark>` kept; `<script>`, attributes, other tags stripped |
| IT-M5-03-01 | integration (sqlite) | insert message, tool call, allowlisted event, non-allowlisted event, finding, plan | FTS rows exist for all but the non-allowlisted event; delete source row → FTS row gone; update `content` → new text searchable |
| IT-M5-03-02 | integration | filters: provider, sessionId, missionId, date range, kind | only matching hits; cursor paging yields no duplicates/omissions across 3 pages |
| IT-M5-03-03 | integration (perf) | 100 k fixture; 50 random queries | p95 ≤ 150 ms; ingest p95 with triggers ≤ 5 ms/message |
| IT-M5-03-04 | integration | corrupt an FTS table, restart daemon | integrity check fails → reindex runs → search works; `search.reindex_scheduled` logged |
| E2E-M5-03-01 | e2e (Playwright + FakeProvider) | type a word from the scenario, navigate with keys, press Enter | result list shows `<mark>`; Enter navigates to `/timeline/:sid?msg=…` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-03-01 | Find a word said to Claude Code | 1. In a Claude session say "remember the token word is kumquat-9921". 2. History → search `kumquat-9921`. | ≥ 1 hit (user message) with `kumquat-9921` inside `<mark>`; header shows provider `claude`, session, date; click opens Timeline at the message | ⬜ |
| TC-M5-03-02 | Cross-provider results and provider filter | 1. Say the same word in a Codex session. 2. Search again. 3. Filter provider = codex. | Two sessions grouped; after filter only the Codex hit remains | ⬜ |
| TC-M5-03-03 | Tool-call args are searchable but redacted | 1. Ask Claude to run `curl -H "Authorization: Bearer abc123def456ghi789" https://example.invalid`. 2. Search `example.invalid`. 3. Search `abc123def456`. | Step 2: tool_call hit with `[REDACTED:bearer-header]` visible in snippet; step 3: 0 hits | ⬜ |
| TC-M5-03-04 | Event payload search | 1. Trigger a permission prompt and answer it. 2. Search the tool name that was in the prompt title. | `event` hit of type `prompt.opened` with deep link to Timeline event | ⬜ |
| TC-M5-03-05 | Malformed query (negative) | 1. Search `"unterminated (phrase NEAR`. 2. Search `   `. | Step 1: results or a friendly "could not parse" notice, never a 500; step 2: input hint "type to search", no request sent | ⬜ |
| TC-M5-03-06 | Date range + mission filters | 1. Set range to "today". 2. Pick a mission (seeded or M3 data). | Only hits inside the range and mission; chips removable; URL reflects filters (shareable) | ⬜ |
| TC-M5-03-07 | Index survives restart and rebuild (resilience) | 1. Note a search result. 2. `kill -9` daemon; restart. 3. Repeat search. 4. `orch history reindex`; repeat search. | Identical hits in steps 3 and 4; reindex completes with `indexed` count = source rows | ⬜ |
| TC-M5-03-08 | Review findings / plan versions (re-run after M3-04) | 1. Seed via test script (pre-M3) or complete a mission with review (post-M3). 2. Search a finding phrase and a plan phrase. | `review_finding` and `plan_version` hits with correct deep links | ⬜ |
| TC-M5-03-09 | RTL / Arabic query | 1. Say an Arabic sentence to an agent. 2. Search an Arabic word from it. | Hit found (unicode61 tokeniser); snippet renders RTL correctly with `<mark>` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M5-03-01 … 09 pass (TC-08 may be provisional on seeded data until M3-04; note in log).
- [ ] `buildMatchExpression` at 100 % branch coverage; fuzz test proves no raw user text reaches `MATCH`.
- [ ] p95 search latency ≤ 150 ms on the 100 k fixture; ingest p95 with triggers ≤ 5 ms/message.
- [ ] Triggers keep FTS in sync for insert/update/delete on all four sources; non-allowlisted events are not indexed.
- [ ] Redacted content is searchable only in its redacted form (TC-03).
- [ ] History screen keyboard-navigable, RTL-correct, WCAG AA contrast on `<mark>`.
- [ ] No new lint / dependency-cruiser violations; OpenAPI updated; package README written.

## 8. Risks / open questions
- FTS5 `tokenchars` including `.`/`/` makes `foo.bar` one token; searching `bar` alone will not match it. Trade-off chosen for code identifiers/paths; revisit with a `trigram` secondary table if users complain (verify `trigram` tokenizer availability in the pinned SQLite at step start).
- `json_tree` for payload flattening inside triggers may be slow on large payloads; cap indexed body at 8 KB per event.
- Standard FTS tables double text storage; retention (M5-06) must delete source rows (triggers clean FTS) rather than truncating FTS directly.
- Postgres parity (M9-05) must reproduce `snippet()`-style highlights (`ts_headline`) — keep the `SearchHit` contract free of SQLite-specific fields.
- Review findings and plan versions have no producer before M3; the trigger definitions are tested on seeded rows only until then.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
