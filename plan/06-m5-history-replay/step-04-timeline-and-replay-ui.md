# Step M5-04 — Timeline & Replay UI

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M5-01 (pane recorder), M5-03 (FTS5 search), M5-02 (conversations), M1-03 (worktree manager), M0-07 (web shell) |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `apps/daemon` (`src/application/history`, `src/infrastructure/recorder`, `src/infrastructure/git`, `src/interface/http`), `apps/web`, `packages/ui` |
| Risk | Medium |
| Owner | |

## 1. Goal
The Timeline screen replays one session as a single synchronised object: an embedded **asciinema-player** showing the recorded pane, a scrubber with lanes for messages, tool calls, events, prompts, commits and recording gaps, a chat pane, an events pane and a diff pane — all locked to one clock. Dragging the scrubber moves the player *and* highlights the message, event and worktree diff at that instant; clicking any message, event, prompt or commit seeks the player to its second. Every Attention item, Board card and search hit carries a "Show in Timeline" link that opens the exact moment, and any moment can be copied as a shareable replay link.

## 2. Why
- G5 "total recall": M5-01/M5-02/M5-03 produce the artifacts; this step is where they become one navigable story — "replay what any agent did last Tuesday, with the chat, events and diff linked to the terminal recording" (`01-vision-scope.md` user story).
- `12-ux-principles.md` IA: Timeline / History ships in M5-04 as the screen "scrubber linking replay ↔ chat ↔ events ↔ diff; search".
- D2 (worktrees): because each task has its own worktree and branch, "the diff at time *t*" is a well-defined, cheap git query — no snapshotting needed.
- C7: replay renders recorded bytes into a player; it never parses them for state. Everything structured on the timeline comes from the DB (messages, events, prompts, commits).
- C13/C10: the player shows exactly what M5-01 wrote — already redacted; no raw-byte path is added here. Manual post-hoc redaction is M5-06 and plugs into this screen.

## 3. Scope
### In scope
- `SessionClock` mapping wall-clock timestamps ↔ replay offsets across recording segments and gaps (pure, in `packages/core`).
- `GET /sessions/:id/timeline` (lanes + markers), `GET /sessions/:id/timeline/moment` (resolve any anchor → moment), `GET /sessions/:id/diff` (worktree diff at a moment).
- Merged cast stream `GET /sessions/:id/cast` that concatenates M5-01 segments into one asciicast v2 with shifted times, gap markers and `idle_time_limit`.
- Commit index cache per worktree so "diff at t" does not shell out to `git log` on every seek.
- Timeline screen (`apps/web`): player, scrubber with lanes, chat pane, events pane, diff pane, follow-live mode, keyboard controls.
- Deep links `/timeline/:sessionId?t=|msg=|event=|prompt=|commit=|task=` (targets emitted by M5-03) + "Copy replay link" (HTTP and `orchestra://` forms).
- "Show in Timeline" actions on Attention items (M1-11) and Board cards (M2-07 if present; behind a capability check otherwise).
- History screen v2: search results (M5-03) gain an inline moment preview and open Timeline in place.
### Out of scope (deferred to …)
- Manual redaction from the chat pane and retention actions in the Timeline toolbar — deferred to M5-06 (this step reserves the toolbar slot and the `onRedact` hook).
- Mission-level timeline (many sessions on one axis) — deferred to M3-08 (Missions screen) which reuses `SessionClock` and the lane components.
- `orch replay` CLI command — deferred to M7-06.
- Offline/cached replay on the PWA — deferred to M7-03.
- Rendering rich chat (markdown, tool cards, plan cards) — M2-08 owns the Chat screen; Timeline embeds the same `SessionTranscript` list from M5-02 in a compact variant.
- Video/GIF export of a replay — not planned for 1.0.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `SessionClock` value object: built from `Recording[]` (segments with `startedAt`, `endedAt`, `bytes`) plus `session.startedAt`. Maps `ts → { segment, offsetSec, playerSec }` and back. `playerSec` is the offset in the **merged** stream.
- `TimelineLane` = `'output' | 'message' | 'tool_call' | 'event' | 'prompt' | 'commit' | 'gap' | 'marker'`.
- `TimelineItem`: `{ id, lane, ts, playerSec, label, severity?: 'info'|'warn'|'error', refId, deepLink }`.
- `Moment`: `{ ts, playerSec, segment, messageSeq?, eventId?, promptId?, commitSha? }` — the resolved target of any anchor.
- Rules (pure, 100 % branch): a `ts` before the first segment clamps to `playerSec = 0`; a `ts` inside a gap resolves to the gap's start with `inGap: true`; a `ts` after the last segment clamps to the end with `atEnd: true`; segment boundaries are half-open `[startedAt, endedAt)`; a session with no recording still yields a clock over `session.startedAt..endedAt` with `playerSec = null` (chat-only replay).
- Gap rule: merged-stream time between segment *n* `endedAt` and segment *n+1* `startedAt` is emitted as a single idle interval capped at `idleTimeLimitSec` and marked `orch:gap`; `SessionClock` stores the real and the compressed duration so wall-clock ↔ player mapping stays exact on both sides of a gap.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/timeline/session-clock.ts (pure)
export interface ClockSegment { recordingId: RecordingId; segment: number; startedAt: string; endedAt: string | null }
export interface ClockOptions { idleTimeLimitSec: number }          // default 2
export interface SessionClock {
  toPlayer(ts: string): Result<{ playerSec: number; segment: number; inGap: boolean; atEnd: boolean }, TimelineError>;
  toWallClock(playerSec: number): Result<{ ts: string; segment: number }, TimelineError>;
  readonly durationSec: number;                                      // merged, gap-compressed
  readonly gaps: ReadonlyArray<{ fromTs: string; toTs: string; compressedSec: number }>;
}
export function createSessionClock(segments: ClockSegment[], opts?: ClockOptions): Result<SessionClock, TimelineError>;
export type TimelineError = { code: 'NoRecording' | 'EmptySession' | 'TsOutOfRange' | 'AnchorNotFound' | 'GitUnavailable' | 'StoreIo'; message: string };

// packages/core/src/ports/worktree-history-port.ts   (read-only git; implemented in infrastructure)
export interface WorktreeHistoryPort {
  commits(wt: WorktreeRef, range: { fromTs: string; toTs: string }): Promise<Result<CommitRef[], TimelineError>>;
  commitAt(wt: WorktreeRef, ts: string): Promise<Result<CommitRef | null, TimelineError>>;   // newest commit with committerDate <= ts
  diff(wt: WorktreeRef, spec: DiffSpec): Promise<Result<UnifiedDiff, TimelineError>>;
}
export interface CommitRef { sha: string; ts: string; subject: string; author: string; filesChanged: number; insertions: number; deletions: number }
export interface DiffSpec { against: 'base' | 'previous' | { sha: string }; at: { sha: string }; maxBytes: number; paths?: string[] }
export interface UnifiedDiff { files: Array<{ path: string; status: 'A'|'M'|'D'|'R'; hunks: string; truncated: boolean }>; totalBytes: number; truncated: boolean }

// apps/daemon/src/application/history/* — one use case per class
export class GetTimeline     { execute(q: { sessionId: SessionId; lanes?: TimelineLane[]; from?: string; to?: string }): Promise<Result<TimelineView, TimelineError>>; }
export class ResolveMoment   { execute(a: MomentAnchor): Promise<Result<Moment, TimelineError>>; }
export class GetDiffAtMoment { execute(q: { sessionId: SessionId; ts: string; against: DiffSpec['against'] }): Promise<Result<UnifiedDiff, TimelineError>>; }
export class StreamMergedCast{ execute(q: { sessionId: SessionId; range?: ByteRange }): Promise<Result<ReadableStream<Uint8Array>, TimelineError>>; }
export type MomentAnchor =
  | { sessionId: SessionId; kind: 'ts'; ts: string } | { sessionId: SessionId; kind: 'playerSec'; playerSec: number }
  | { sessionId: SessionId; kind: 'message'; messageId: string } | { sessionId: SessionId; kind: 'event'; eventId: string }
  | { sessionId: SessionId; kind: 'prompt'; promptId: string }   | { sessionId: SessionId; kind: 'commit'; sha: string };
export interface TimelineView { sessionId: SessionId; header: SessionHeader; clock: { durationSec: number; startedAt: string; endedAt: string | null; hasRecording: boolean }; items: TimelineItem[]; gaps: SessionClock['gaps']; truncated: boolean }
```
`WorktreeHistoryPort` is implemented by `GitWorktreeHistory` in `apps/daemon/src/infrastructure/git/` (the only place allowed to spawn `git`, per `11-repo-layout.md`). It reuses the worktree paths registered by M1-03 and refuses paths outside `worktrees.path`.

### 4.3 Data / schema changes
Migration `0053_timeline` (extends `04-domain-model.md` §4):
- `commit_index(id text pk, worktree_id text not null, session_id text null, sha text not null, committed_at text not null, subject text, author text, files_changed integer, insertions integer, deletions integer, indexed_at text not null)`; unique `(worktree_id, sha)`; index `(worktree_id, committed_at)`.
- `recordings` add `merged_offset_sec real null` (cached start offset of each segment in the merged stream; recomputed when a segment closes).
- No new tables for lanes: messages, events, `agent_prompts` and `commit_index` are the lanes.
- Config (Zod): `features.history.timeline: boolean`, `history.timeline.idleTimeLimitSec` (2), `history.timeline.maxItems` (5 000 per request), `history.diff.maxBytes` (2 MB), `history.commitIndex.refreshMs` (30 000).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Merged cast**: `MergedCastStream` reads segments in order from `RecordingStore` (M5-01), emits one header (width/height from segment 0, `idle_time_limit` from config), then re-times each segment's events by `mergedOffsetSec`, inserting an `["m", "orch:gap"]` marker and a compressed idle interval per gap. Streaming, never buffered whole; honours HTTP `Range` by byte offset on the generated stream only when the whole merged stream is cacheable (ETag = concat of segment `sha256`), otherwise `206` is refused with `200` + `Accept-Ranges: none`.
- **Commit indexer**: on `session.stopped`, on demand when a timeline is requested, and every `refreshMs` for running sessions, run `git -C <worktreePath> log --no-merges --date=iso-strict --format=…` limited to the session's time range and `--shortstat`; upsert into `commit_index`. Commits are read from the session's own worktree/branch only (D2 isolation).
- **Diff at t**: `commitAt(ts)` from `commit_index` (fallback to `git log -1 --before`), then `git diff <base_ref>..<sha>` (`against: 'base'`) or `git diff <sha>~1..<sha>` (`against: 'previous'`), capped at `history.diff.maxBytes` with `truncated: true` and a per-file hunk cap. `git` runs with the child-process env allowlist from `09-engineering-standards.md` and `--no-pager`.
- No network calls; no tmux interaction (Timeline is read-only over stored artifacts). For a **running** session, "follow live" subscribes to the existing `/term/:paneId` WS (M1-09) rather than the recording, and the scrubber switches to live mode; leaving live mode re-opens the merged cast.
- `asciinema-player` is bundled from `apps/web` dependencies (pinned, `08-tech-stack.md`); no CDN.

### 4.5 API / UI surface
- `GET /sessions/:id/timeline?lanes=&from=&to=` → `TimelineView` (Zod response). `404 SessionNotFound`, `200` with `hasRecording:false` for chat-only sessions.
- `GET /sessions/:id/timeline/moment?ts=|playerSec=|msg=|event=|prompt=|commit=` → `Moment`; `404 AnchorNotFound`.
- `GET /sessions/:id/cast` → `application/x-asciicast` merged stream (`ETag`, `Cache-Control: private, max-age=0`).
- `GET /sessions/:id/diff?at=<ts>&against=base|previous|<sha>&paths=` → `UnifiedDiff`; `409 GitUnavailable` when the worktree was removed (M1-03 cleanup) — UI shows "worktree removed; diff unavailable" with the commit metadata still listed.
- WS `/ws` topic `timeline.<sessionId>`: `item.appended` (new message/event/prompt/commit while the screen is open) so live sessions grow their lanes without polling.
- Web `TimelinePage` (`apps/web/src/screens/timeline/`), components: `ReplayPlayer` (asciinema-player wrapper, exposes `seek/play/pause/onTimeUpdate`), `Scrubber` (lane rows, zoom, drag, hover tooltip with ts + label), `TranscriptPane` (compact `SessionTranscript` from M5-02 with active-message highlight), `EventsPane` (virtualised event list, severity icon + label — never colour alone), `DiffPane` (file list + unified hunks, `prefers-reduced-motion` safe), `TimelineToolbar` (follow-live toggle, speed 0.5×/1×/2×/4×, copy replay link, slot reserved for M5-06 redact/pin).
- Keyboard: `Space` play/pause · `←/→` ±5 s · `⇧←/→` ±30 s · `,`/`.` previous/next lane item · `j/k` message list · `g` jump to prompt · `⌘C` on the toolbar copies the replay link. All `packages/ui` primitives; RTL-safe (logical properties; the scrubber mirrors its axis under `dir=rtl` while time still runs left→right inside the player, which is direction-neutral).
- States: loading (skeleton lanes), `no recording` (player replaced by "chat-only replay" panel, scrubber still works on ts), `gap` (hatched lane region + "recording gap 00:42" tooltip), `live` (player replaced by the live terminal), `diff unavailable`, `error` with `code` + retry.
- "Show in Timeline" is added to: Attention item overflow menu (`/timeline/:sid?prompt=<id>`), Board card menu, search hit rows (M5-03 already emits the URL).

### 4.6 Flow / sequence
```
Search hit / Attention item / Board card ──▶ navigate(/timeline/:sid?msg=…)
TimelinePage mount
  ├─ GET /sessions/:id/timeline           → header, lanes, gaps, clock
  ├─ GET /sessions/:id/timeline/moment?msg=…  → Moment{ts, playerSec}
  ├─ ReplayPlayer.src = /sessions/:id/cast ; on ready → seek(playerSec)
  └─ clock store (Zustand) publishes tCurrent
tCurrent change (player onTimeUpdate | scrubber drag | list click)
  ├─ TranscriptPane: highlight last message with ts <= tCurrent (binary search, client-side)
  ├─ EventsPane:     scroll to last event with ts <= tCurrent
  └─ DiffPane (debounce 250 ms): GET /sessions/:id/diff?at=<ts>&against=base
Live session: WS timeline.<sid> item.appended ──▶ append to lanes ──▶ (if follow-live) keep tCurrent at the end
Copy replay link ──▶ /timeline/:sid?t=<playerSec>&ts=<iso> (both, so the link survives re-recording)
```

### 4.7 Review reconciliation contract (2026-09-15)
Timeline replay includes captured terminal/events and commit-based diffs. Resolve a historical diff only from recorded base/head commit IDs or an explicit snapshot ID with content hash and capture time. Worktree existence is not historical evidence. Without a snapshot, show "Uncommitted state not captured"; never display the current worktree as historical state. Show redaction gaps, unavailable transcript fields and missing segments explicitly.

## 5. Tasks
- [ ] `packages/core/src/timeline/`: `SessionClock`, `TimelineItem`, `Moment`, clamping/gap rules (100 % branch coverage).
- [ ] `WorktreeHistoryPort` + `TimelineError` union in `packages/core/src/ports/`.
- [ ] Migration `0053_timeline` (`commit_index`, `recordings.merged_offset_sec`) + `SqliteCommitIndexRepository`.
- [ ] `GitWorktreeHistory` in `apps/daemon/src/infrastructure/git/` (log, commitAt, diff, byte caps, env allowlist, path guard).
- [ ] `CommitIndexer` (on `session.stopped`, on demand, periodic for running sessions).
- [ ] `MergedCastStream` in `infrastructure/recorder/` (re-timing, gap markers, ETag from segment hashes).
- [ ] Use cases `GetTimeline`, `ResolveMoment`, `GetDiffAtMoment`, `StreamMergedCast`.
- [ ] HTTP controller (`/timeline`, `/timeline/moment`, `/cast`, `/diff`) + WS topic `timeline.<sessionId>` + OpenAPI + Zod schemas.
- [ ] `ReplayPlayer` wrapper around asciinema-player (pinned version, no CDN, `prefers-reduced-motion`).
- [ ] `Scrubber` with lanes, zoom, drag, hover tooltips, keyboard control; virtualised for 5 000 items.
- [ ] `TranscriptPane` (reuse M5-02 `SessionTranscript`), `EventsPane`, `DiffPane`, `TimelineToolbar` (M5-06 slot).
- [ ] Timeline clock store + binary-search highlighters; debounced diff fetch; abort in-flight requests on seek.
- [ ] Deep-link parsing/writing (`t`, `ts`, `msg`, `event`, `prompt`, `commit`, `task`) + "Copy replay link" (HTTP + `orchestra://`).
- [ ] "Show in Timeline" entries on Attention items and Board cards (feature-detected).
- [ ] History screen v2: inline moment preview on hits; open Timeline in place (M5-03 components reused).
- [ ] Perf harness: 8 h session, 50 k events, 3 GB of segments → timeline load, seek and diff budgets asserted.
- [ ] Package README (`screens/timeline`) + `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-04-01 | unit (fast-check) | `createSessionClock` over random segment/gap layouts; `toPlayer`/`toWallClock` round-trip | round-trip error ≤ 1 ms outside gaps; inside a gap resolves to gap start with `inGap`; never throws |
| UT-M5-04-02 | unit | clamping rules: ts before first segment, after last, empty recording list | `playerSec=0` / `atEnd` / `Err(NoRecording)` with chat-only clock still usable |
| UT-M5-04-03 | unit | deep-link parser/serialiser for all six anchor kinds incl. unknown params | unknown params ignored; `ts` wins over `t` when both present; output URL is stable |
| UT-M5-04-04 | unit | `MergedCastStream` re-timing with two segments and a 90 s gap | one header; monotonic times; gap compressed to `idleTimeLimitSec`; one `orch:gap` marker; event count = sum of inputs + 1 |
| IT-M5-04-01 | integration (sqlite + real git) | scratch repo with 5 timed commits; `GetDiffAtMoment` at four instants | correct commit chosen per instant; `against:'base'` and `'previous'` differ as expected; diff over `maxBytes` returns `truncated` |
| IT-M5-04-02 | integration | `GetTimeline` for a FakeProvider session with messages, tool calls, events, a prompt and 2 segments | every lane populated; `playerSec` of each item matches `SessionClock`; `items.length` capped at `maxItems` with `truncated:true` |
| IT-M5-04-03 | integration | worktree deleted after session end, then diff requested | `409 GitUnavailable`; commit metadata still returned from `commit_index` |
| E2E-M5-04-01 | e2e (Playwright + FakeProvider) | search → hit → Timeline; drag scrubber; click an event | player seeks (player `currentTime` within 1 s of target), highlighted message changes, diff pane requests `at=<ts>` once per settle |
| E2E-M5-04-02 | e2e | chat-only session (recorder disabled) | "chat-only replay" panel shown, no player errors, scrubber and panes still synchronised |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-04-01 | Replay a real Claude Code session | 1. Run a Claude session in `~/orchestra-scratch/` that edits a file and commits. 2. Stop it. 3. Open Timeline for that session. | Player shows the recorded pane and plays; scrubber lanes show messages, tool calls, events and 1 commit; total duration matches the session length ±2 s | ⬜ |
| TC-M5-04-02 | Scrub → chat + events + diff follow | 1. Drag the scrubber to the moment just after the commit. 2. Observe the three panes. | Player frame, highlighted message, selected event and the diff all describe the same instant; diff shows the committed change; dragging back before the commit shows the previous diff | ⬜ |
| TC-M5-04-03 | Click-through in both directions | 1. Click a message in the transcript. 2. Click an event in the events pane. 3. Click a commit chip in the lane. | Each click seeks the player within 1 s of the item's timestamp and the other panes re-sync; no request storm (≤ 1 diff request per click) | ⬜ |
| TC-M5-04-04 | Jump from Attention to its moment | 1. Answer a permission prompt in a running Claude session. 2. Later open Attention → the answered item → "Show in Timeline". | Timeline opens at the prompt second; the `prompt.opened` event is selected; the pane shows the prompt on screen at that time | ⬜ |
| TC-M5-04-05 | Search → Timeline round-trip (M5-03 integration) | 1. History → search a word said in a Codex session. 2. Press Enter on the hit. | Timeline opens at the matching message; going back preserves the search query and filters | ⬜ |
| TC-M5-04-06 | Replay link export | 1. Seek to a moment. 2. "Copy replay link". 3. Paste into a new browser tab. 4. Paste into the Tauri app if present (M7-01, else skip). | Same session, same second, same selected item; link contains both `t` and `ts`; `orchestra://` variant opens the desktop app when installed | ⬜ |
| TC-M5-04-07 | Recording gap (resilience) | 1. Reproduce TC-M5-01-06 (close the pipe manually, let it self-heal). 2. Open Timeline. | A hatched gap region with "recording gap" tooltip; seeking across the gap keeps chat/events/diff correct on both sides; player does not freeze | ⬜ |
| TC-M5-04-08 | Rotated multi-segment session | 1. Session with ≥ 3 rotated segments (TC-M5-01-04). 2. Play from start to end at 4×. | One continuous playback across segments, no reload flash at boundaries, times monotonic; `GET /sessions/:id/cast` returns a single stream | ⬜ |
| TC-M5-04-09 | Missing recording / removed worktree (negative) | 1. Delete `~/.orchestra/recordings/<sid>/` for a stopped session. 2. Open Timeline. 3. Also open a session whose worktree was cleaned up. | Case 1: "recording unavailable" panel, chat/events lanes still work, no 500; Case 2: diff pane shows "worktree removed", commit list still visible | ⬜ |
| TC-M5-04-10 | Long-session performance | 1. Open a session with ≥ 8 h of recording and ≥ 20 k events (load fixture or nightly run). 2. Scrub rapidly across the whole range for 30 s. | Timeline loads ≤ 1.5 s; each seek settles ≤ 300 ms (player+chat+events) and diff ≤ 800 ms; browser tab memory stays ≤ 400 MB; no dropped frames on the scrubber (60 fps budget) | ⬜ |
| TC-M5-04-11 | Live session follow mode | 1. Open Timeline for a *running* session. 2. Enable "follow live". 3. Let the agent produce output, then disable follow and scrub back. | Follow mode shows the live terminal and appends lane items as they happen; disabling switches to the recording at the same instant without losing the scroll position | ⬜ |
| TC-M5-04-12 | RTL + reduced motion | 1. Switch UI to Arabic. 2. Enable `prefers-reduced-motion` in the OS. 3. Repeat TC-02. | Lanes and panes mirror correctly; tooltips read RTL; no animated scrubber easing; keyboard shortcuts unchanged | ⬜ |

### 6.3 Review regression scenarios
- [ ] Modify an uncommitted file twice: earlier content unavailable without snapshot.
- [ ] Existing worktree with no checkpoint never supplies a historical diff.
- [ ] Recorded checkpoint hash matches replayed content; gaps are visible.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] All TC-M5-04-01 … 12 pass on real Claude Code and Codex sessions.
- [ ] Seeking from any of the four surfaces (scrubber, player, transcript, events) leaves all panes describing the same instant (TC-02, TC-03).
- [ ] `SessionClock` at 100 % branch coverage; round-trip property test green.
- [ ] Budgets met: timeline load ≤ 1.5 s, seek settle ≤ 300 ms, diff ≤ 800 ms, scrubber 60 fps on a 20 k-item session (TC-10).
- [ ] Multi-segment sessions replay as one continuous stream; gaps are visible and do not desynchronise the panes.
- [ ] Missing recording, removed worktree and chat-only sessions degrade gracefully with typed error codes — no 500s (TC-09, E2E-02).
- [ ] Deep links from search, Attention and Board all land on the correct moment; "Copy replay link" round-trips.
- [ ] No `git` or `child_process` usage outside `apps/daemon/src/infrastructure/**`; no new lint / dependency-cruiser violations; OpenAPI updated; screen README written.

## 8. Risks / open questions
- asciinema-player API surface for programmatic `seek`, `play`, speed and marker rendering, and whether it accepts a streamed (chunked) source rather than a complete file (verify against asciinema-player docs for the pinned version at step start). Fallback: serve the merged cast as a complete response with `Content-Length` and load per-segment on seek.
- asciicast v2 `"m"` marker support in the player (same verification as M5-01 risk); if markers are unsupported, gaps render only in the scrubber lane, not inside the player.
- Merged-stream `Range` support: re-timing makes byte offsets unstable if a segment is appended while streaming. Running sessions therefore disable ranges (`Accept-Ranges: none`) and re-fetch on seek; stopped sessions get a stable ETag.
- Commit timestamps are *committer* dates and can lag the agent's action (rebase, amend, squash). The diff pane labels the commit time and offers "diff of working tree at t" as an explicit alternative only when the worktree still exists — never inferred silently.
- A session whose worktree is shared with a later task (M3) could show commits from another agent; the indexer filters by the session's own branch and time range, but overlapping branches remain an open question to re-check after M3-07.
- Very large diffs (generated code, lockfiles) can dominate the response; `maxBytes` + per-file truncation is a blunt instrument. Consider a "load full file diff" action in Review (M3-05) rather than here.
- Client-side highlighting uses binary search over ts-ordered arrays; if M5-02 ever delivers out-of-order messages the highlight can jitter — ingest guarantees `seq` ordering, and a UT asserts monotonic ts within a conversation.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
