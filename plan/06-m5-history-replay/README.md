# Milestone M5 — History, recording, replay

| | |
|---|---|
| Folder | `plan/06-m5-history-replay/` |
| Steps | 6 (M5-01 … M5-06) |
| Effort | 14 working days (sum of step estimates; optional work included) |
| Depends on | M1 (live fleet: M1-02 supervisor, M1-08 telemetry plane, M1-11 Interaction Bridge) |
| Unblocks | M7-03 (PWA offline history + restore semantics), M9-03 (audit export reuses bundle format), M9-05 (`RecordingPort` → S3) |
| Status | ⬜ Not started |

## Goal

After M5, every agent session Orchestra runs is **recorded, captured, searchable, replayable and survivable**. A pane recording (asciicast v2, secrets scrubbed at capture time) sits next to a normalised conversation (messages, tool calls, attachments) from every provider; FTS5 search finds anything said, decided, reviewed or planned; the Timeline screen replays a session with chat, events and the worktree diff locked to the same clock; and a `kill -9` of the daemon while an agent is waiting for an answer loses **zero** prompts — the same prompt is answerable from the web after restart. Retention, manual redaction and mission bundles (export/import) make the history a user-owned, portable, prunable asset.

## Why this milestone now

- G5 ("total recall") and the restore budget in `12-ux-principles.md` are 1.0 Definition-of-Done items ("restore with no lost prompts"); they must be proven on the M1 substrate before M7 (PWA offline/reconnect) and M9 (audit, S3) build on them.
- M5 is a parallel lane (`ROADMAP.md`: {M2→M3} · {M4} · {M5} run concurrently after M1). It touches the storage plane and the supervisor, not the intelligence layer, so it does not collide with M2/M3 work.
- C13 (secrets scrubbed from recordings at capture time) has no implementation until M5-01; until then, recordings must stay off by default. Shipping the recorder early reduces the window in which raw PTY bytes could reach disk.
- M1-13's "restart smoke" only proves panes survive; M5-05 turns that into a measured guarantee (`restore.lost_prompts == 0`) with an explicit `kill -9` test on real CLIs.

## Entry criteria

- [ ] M1-13 (MVP acceptance) ✅ — ≥ 2 real CLIs run in tmux + worktrees; prompts round-trip from web.
- [ ] M1-02 `SessionSupervisor` exposes pane ids (`%N`) and window ids (`@N`) per session in `sessions` (`tmux_window`, `tmux_pane`).
- [ ] M1-08 telemetry pipeline emits `NormalizedEvent[]` per provider with `source.externalId` populated where the vendor supplies one.
- [ ] M1-11 `agent_prompts` table + `AnswerTransport` strategies registered in DI.
- [ ] Schema v1 tables `recordings`, `conversations`, `messages`, `message_tool_calls`, `attachments`, `plan_versions`, `review_findings` exist (M0-04 migrations), even if some are still unpopulated before M3.
- [ ] `features.history.*` flags exist in the Zod config (added in M5-01, defaults off until M5 acceptance).

## Exit criteria

- [ ] Every session started while `features.history.recorder=true` has ≥ 1 `recordings` row and a readable asciicast v2 file; a known secret typed into the pane never appears on disk (TC-M5-01-03).
- [ ] Conversations for Claude Code, Codex and (opt-in) Antigravity sessions appear in `messages`/`message_tool_calls` with idempotent ingestion — re-running the importer twice produces zero duplicate rows.
- [ ] `GET /history/search` returns ranked hits with snippets across messages, event payloads, review findings and plan versions; p95 latency ≤ 150 ms on a DB with 100 k messages (load fixture).
- [ ] Timeline screen: seeking the player to a message's time highlights that message; clicking an event seeks the player; diff pane shows the worktree diff at the commit ≤ t.
- [ ] `kill -9` of `orchestrad` with a permission prompt open on a real Claude Code session → after restart the same `AgentPrompt` id is open in Attention, is answered from the web, the agent proceeds; `restore_lost_prompts` metric = 0 across ≥ 5 consecutive runs.
- [ ] Hook payloads received during the daemon's shutdown window are persisted to `telemetry_inbox` before parsing and replayed after restart (no gap in the event sequence for the session).
- [ ] Retention sweeper removes expired artifacts (dry-run lists them first); pinned sessions are never touched; manual redaction rewrites both the recording and the message and the redacted text is no longer searchable.
- [ ] `orch history export --mission <id>` produces a zip with `manifest.json{schemaVersion}`; `orch history import --bundle` on a fresh DB restores the mission with replayable recordings.
- [ ] Nightly load test (10 k events/min, 50 panes recording) stays inside memory budgets (≤ 300 MB daemon idle, ≤ 40 MB/pane) — `10-testing-strategy.md` "Load … nightly from M5".
- [ ] All step TC tables ✅; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## Steps

| ID | File | Title | Effort | Depends on |
|---|---|---|---|---|
| M5-01 | [step-01](step-01-pane-recorder-asciicast-v2.md) | Pane recorder (asciicast v2) | 2.5 d | M1-02, M1-01, M0-05 |
| M5-02 | [step-02](step-02-conversation-and-tool-call-capture-v2.md) | Conversation & tool-call capture v2 | 2.5 d | M1-08, M1-05, M1-06, M5-01 |
| M5-03 | [step-03](step-03-fts5-search.md) | FTS5 search | 1.5 d | M5-02, M0-05, M0-07 |
| M5-04 | [step-04](step-04-timeline-and-replay-ui.md) | Timeline & Replay UI | 3 d | M5-01, M5-02, M5-03, M1-03, M0-07 |
| M5-05 | [step-05](step-05-session-restore-with-zero-lost-prompts.md) | Session restore with durable captured prompts with explicit recovery outcomes | 2.5 d | M1-11, M1-02, M1-01, M1-08, M0-05, M0-06, M5-01 |
| M5-06 | [step-06](step-06-retention-redaction-export-import.md) | Retention, redaction, export/import | 2 d | M5-04, M5-01, M5-02, M5-03, M0-04 |

## What you can test after this milestone

- Replay any session from the last N days in the browser, with the chat, events and diff moving together as you scrub.
- Type a secret-shaped string into any agent pane and prove it never reaches `~/.orchestra/recordings/`.
- Search "why did we pick X" across every provider's conversations, review findings and plans; land on the exact second in the replay.
- Kill the daemon with `kill -9` while an agent is asking for permission; restart; answer the same prompt from the web; the agent continues.
- Export a mission as a zip, wipe the DB, import it, replay it.
- Redact a leaked value after the fact and confirm it is gone from the recording, the chat and the search index.

## End-to-end demo script (real tools)

Preconditions: M5 build running with `features.history.recorder=true`, `features.history.capture=true`, `features.history.search=true`; tmux ≥ 3.3; `claude` and `codex` logged in (`claude /status`, `codex login status`); scratch repo `~/orchestra-scratch/`; Antigravity optional (ToS acknowledged, C11).

1. Open Fleet → Start session → Claude Code, interactive, repo `~/orchestra-scratch/`, new worktree. In Terminals the pane header shows `REC` and `ls ~/.orchestra/recordings/<sessionId>/` shows `000.cast` growing.
2. In the pane type `echo AKIAIOSFODNN7EXAMPLE` and `export GH=ghp_0123456789abcdefghijklmnopqrstuvwxyz` → `grep -c AKIA ~/.orchestra/recordings/<sessionId>/*.cast` prints `0`; `grep -c 'REDACTED:aws-access-key' …` prints `≥ 1`.
3. Ask the agent: "create `hello.txt` containing the word `pomegranate-7431` and commit it". Watch Chat (M2-08 if present, else `GET /sessions/:id/conversation`) fill with the user message, the assistant message, `Write`/`Bash` tool calls and the commit.
4. Start a Codex session on the same repo (its own worktree); ask it to append a line to `hello.txt`. Verify `messages` rows for the Codex session exist with `provider_id='codex'` and tool calls from app-server items.
5. History screen → search `pomegranate-7431` → ≥ 2 hits (Claude message, Codex message, possibly tool call args). Click the Claude hit → Timeline opens at that second: player seeks, message is highlighted, Events pane shows `task.*`/`prompt.*` events around it, Diff pane shows the commit that added `hello.txt`.
6. In the Claude pane ask: "delete `hello.txt` using the shell" so that a `PreToolUse` permission prompt appears. Confirm it is in Attention as `open`. **Do not answer.** Note its prompt id.
7. `kill -9 $(pgrep -f orchestrad)`. `tmux ls` still shows the `orchestra` session; the pane still shows Claude waiting. `curl 127.0.0.1:4300/health` fails.
8. Restart the daemon. Within 5 s: Attention shows the **same prompt id** as `open`; `curl 127.0.0.1:4300/metrics | grep restore_lost_prompts` prints `0`; the session row is `waiting_for_input`; the recording continued (`pipe-pane` never stopped) and the timeline shows a `daemon.restarted` marker.
9. Approve the prompt from the web. The agent deletes the file; Chat shows the tool result; the `prompt.answered` → `delivered` → `acknowledged` events appear.
10. Pin the Claude session. Set `history.retention.recordings=1m` in `config.yaml` for the test, run `orch history sweep --dry-run` → the Codex session's recording is listed, the pinned one is not. Run without `--dry-run` → file removed, `recordings.state='purged'`, `audit.*` row present. Restore the config value.
11. In Timeline (Claude session) select the text `pomegranate-7431` in the chat pane → Redact → confirm. Replay at that time shows `[REDACTED]`; History search for the word returns 0 hits; the `.cast` file no longer contains it.
12. `orch history export --session <claudeSessionId> --out ~/claude-session.zip`; `unzip -l` shows `manifest.json`, `sessions.json`, `conversations/`, `events.jsonl`, `recordings/`. Start a second daemon with `ORCH_DB_SUFFIX=import-test` (M3-07 isolation if available, else a temp `--db` path) → `orch history import --bundle ~/claude-session.zip` → Timeline replays the imported session; importing the same bundle again adds 0 rows.
13. Delete the Codex session (soft) → hidden from lists, files intact. Purge it → files gone, rows gone, FTS returns nothing for its text, one `audit.*` row records the purge.

## Milestone risks

| Risk | Impact | Mitigation |
|---|---|---|
| Raw PTY bytes reach disk before redaction (C13) | secrets in recordings | recorder helper redacts in-process before every write; contract test feeds every fixture secret through the pipe; recording files created `0600` |
| tmux `pipe-pane` command dies or is never established after restart | silent recording gaps | `#{pane_pipe}` check on boot + every 30 s (verify format variable against tmux docs); gap markers written; Attention item on repeated failure |
| Vendor session-log formats (Claude JSONL, Codex app-server items, agy stream-json) drift | capture v2 stops ingesting | parsers are adapter-owned with pinned fixtures; unknown lines → `ParseError` counted by Doctor, never dropped silently |
| FTS index growth and write amplification | slow ingestion, disk | allowlisted event types only; triggers batched in the same transaction; nightly load test |
| Restore false positives: prompt shown as open but agent already moved on | wrong answer sent | reconcile probes pane state (`waiting_for_input` requires an open prompt); ack-based transports only; stale prompts expire with an Attention note, never auto-resend keys |
| Redaction rewrite corrupts asciicast timing | replay desync | rewrite preserves event count and times; property test: timeline of markers unchanged after redaction |
| Export bundles leak tokens/config | C3/C13 breach | bundle builder runs the same redactor over every string field; never includes `config.yaml`, `token`, hook configs |
| M3 tables (review findings, plan versions) empty when M5 runs before M3 | FTS coverage untested on real data | seeded fixtures in tests; TC marks those rows "re-run after M3-04" |

## Parallelization notes

- **Two lanes:** Lane A = M5-01 → M5-04 (recorder → replay UI, needs M5-03). Lane B = M5-02 → M5-03 (capture → search). M5-05 is independent of both lanes (depends only on M1-11) and can start on day 1; it is the highest-risk step, so start it first.
- M5-06 depends on M5-04 (redaction UI lives in Timeline) but its retention sweeper and export bundle can be built against M5-01/M5-02 outputs while M5-04 is in test.
- Shared code to land first (in M5-01, day 1): `packages/core/src/redaction/` (rules + streaming redactor) — used by M5-01 (PTY bytes), M5-02 (tool args), M5-06 (export).
- Do not run M5-05 restart tests while a load test is recording; the `kill -9` test needs a quiet host to attribute lost prompts correctly.
- Nightly load harness (`10-testing-strategy.md`) is switched on at the end of M5-01 (recorder is the biggest new I/O consumer).

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
