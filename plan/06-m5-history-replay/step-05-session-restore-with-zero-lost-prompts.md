# Step M5-05 — Session restore with zero lost prompts

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M1-11 (Interaction Bridge & Attention queue), M1-02 (SessionSupervisor), M1-01 (tmux control-mode driver), M1-08 (telemetry plane), M0-05 (event store), M0-06 (WS gateway) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon` (`src/application/restore`, `src/infrastructure/tmux`, `src/infrastructure/telemetry`, `src/interface/http`, `src/interface/ws`), `apps/web`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy` |
| Risk | High |
| Owner | |

## 1. Goal
`kill -9` on `orchestrad` while an agent is waiting for a permission, question or plan approval no longer costs the user anything. On restart the daemon re-attaches to the `orchestra` tmux server, matches every live pane back to its `Session` row via `ORCH_SESSION_ID`, reconciles session states, replays the raw telemetry backlog it had persisted **before** parsing, re-derives the open `AgentPrompt`s, and pushes a snapshot + delta to every reconnecting UI. The same prompt id is answerable from the web seconds after restart, the agent continues, and the metric `restore_lost_prompts` reads `0`.

## 2. Why
- 1.0 Definition of Done (`ROADMAP.md`, source plan §20): "restore with no lost prompts". `12-ux-principles.md` reliability budget: "Restore — re-attach tmux + replay events; zero lost prompts".
- D2: tmux is the substrate precisely so that agents outlive the daemon; that promise is only real if the daemon can find them again and rebuild the interaction state.
- D13: one `SessionSupervisor` owns all tmux state, so reconcile is a single, testable actor operation rather than a scattered recovery path.
- D14: "every agent stop-and-ask becomes a durable `AgentPrompt`" — durable means it survives process death, including the window between an agent asking and the daemon persisting.
- G1/G5: an unanswerable prompt blocks an agent indefinitely and leaves a hole in the history; this step closes both.
- C7: reconciliation reads structured tmux metadata and DB rows only — never the pane's scrollback text — to decide what state a session is in.

## 3. Scope
### In scope
- `ORCH_SESSION_ID` (+ `ORCH_HOST_ID`) injected at launch into the pane environment, the tmux window user option and the pane title; read back at boot.
- `ReconcileSessions` use case: enumerate tmux windows/panes, match to `sessions`, classify, apply state transitions, emit events.
- Raw telemetry inbox: `telemetry_inbox` table written by the hooks receiver / stream readers **before** any parsing; drained asynchronously; replayed on boot.
- `RederiveOpenPrompts`: rebuild the open-prompt set from `agent_prompts` + replayed inbox + last events; re-deliver answered-but-undelivered answers over ack-based transports only.
- `ReattachStrategy` per provider (`pty-pane` vs `stdio-child`) with an explicit, documented outcome for transports the daemon owned.
- Restore metrics (`restore_lost_prompts`, `restore_duration_ms`, `restore_sessions_*`, `telemetry_inbox_backlog`) + `restore.*` events + a `daemon.restarted` timeline marker.
- WS reconnect protocol: `subscribe { topics, sinceEventId }` → `snapshot` + ordered `delta`, with re-snapshot on sequence gap.
- Restore banner + per-session restore badges in the web UI; Attention shows recovered prompts with a "recovered after restart" note.
- `kill -9` test harness (`scripts/restore-soak.sh`) and an automated 5-run soak on FakeProvider plus the manual run on a real CLI.
### Out of scope (deferred to …)
- Restarting agents that did not survive (relaunch/resume of a dead CLI) — `ResumeSession` UI action is M5-06 (`resume`/`fork`); this step only classifies and reports them.
- Offline answer queueing in the client — deferred to M7-03 (PWA offline queue) which reuses the `sinceEventId` protocol added here.
- Multi-host restore (daemon B adopting daemon A's panes) — deferred to M7-05.
- Postgres/S3 durability semantics — deferred to M9-05 (the inbox table is Postgres-compatible by construction).
- Recording continuity across restart — already delivered by M5-01 (`pipe-pane` is owned by tmux); this step only re-runs `VerifyRecordingPipes`.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `SessionIdentity` value object: `{ sessionId, hostId, tmuxWindow, tmuxPane, launchedAt, paneStartCommand }` — what must match for a pane to be adopted.
- `ReconcileVerdict`: `'matched_alive' | 'matched_dead' | 'pane_missing' | 'orphan_pane' | 'transport_lost' | 'stale_row'`.
- `RestoreRun` entity: `{ id, startedAt, finishedAt, sessionsSeen, matched, crashed, orphans, inboxReplayed, promptsOpenBefore, promptsRecovered, promptsLost, durationMs }`.
- `PromptRecovery` value object: `{ promptId, previousState, newState, reason: 'still_open' | 'answer_redelivered' | 'expired' | 'session_gone' | 'superseded' }`.
- Rules (pure, 100 % branch):
  - A pane may only be adopted when its `ORCH_SESSION_ID` equals the DB row's id **and** `hostId` matches; a pane-id match alone is never sufficient (tmux reuses `%N` after a pane closes).
  - `matched_alive` + prompt open ⇒ session state `waiting_for_input`; `matched_alive` + no open prompt ⇒ `running`.
  - `pane_missing` / `matched_dead` ⇒ `crashed` (never `stopped`, which is reserved for a requested stop) and every open prompt of that session → `cancelled` with reason `session_gone`.
  - `orphan_pane` (a pane with an `ORCH_SESSION_ID` unknown to this DB) is **never** killed; it is reported as an Attention item.
  - An `AgentPrompt` in `open` stays `open` with the same id — restore never mints a new prompt id for the same `(sessionId, externalPromptId)`.
  - A prompt in `answered` but not `delivered` is re-delivered **only** when its `AnswerTransport` is ack-based and idempotent; `send-keys-acked` is never auto-replayed (keystrokes cannot be made idempotent) — it is surfaced to the user as "re-send answer?".
  - `promptsLost` = prompts that were `open` before shutdown and after restore are in none of `{open, answered, delivered, acknowledged, cancelled(session_gone), expired}` — by construction this must be `0`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/restore/ (pure)
export interface PaneSnapshot { windowId: string; paneId: string; panePid: number; paneDead: boolean; paneTitle: string; orchSessionId?: SessionId; orchHostId?: HostId; startCommand?: string }
export interface SessionRow { id: SessionId; hostId: HostId; state: SessionState; tmuxWindow: string; tmuxPane: string; providerId: ProviderId; reattach: ReattachKind }
export type ReattachKind = 'pty-pane' | 'stdio-child';
export interface ReconcileDecision { sessionId: SessionId; verdict: ReconcileVerdict; nextState: SessionState; promptAction: 'keep' | 'cancel' | 'expire'; note?: string }
export function reconcile(panes: PaneSnapshot[], rows: SessionRow[], now: Iso8601): ReconcileDecision[];   // pure, total, order-independent

// packages/core/src/ports/telemetry-inbox-port.ts
export interface TelemetryInboxPort {
  put(r: InboxRecord): Promise<Result<'stored' | 'duplicate', RepoError>>;   // MUST complete before parsing
  claimBatch(limit: number): Promise<Result<InboxRecord[], RepoError>>;      // pending → claimed, single-writer
  markParsed(ids: string[]): Promise<Result<void, RepoError>>;
  markFailed(id: string, error: string): Promise<Result<void, RepoError>>;   // attempts++, → 'failed' after maxAttempts
  backlog(): Promise<Result<{ pending: number; failed: number; oldestTs?: Iso8601 }, RepoError>>;
}
export interface InboxRecord {
  id: string; receivedAt: Iso8601; providerId: ProviderId; channel: 'hook' | 'stream' | 'app-server' | 'session-log' | 'otlp';
  sessionIdHint?: SessionId; externalId?: string; body: string; headersJson?: string;
  state: 'pending' | 'claimed' | 'parsed' | 'failed'; attempts: number;
}

// apps/daemon/src/application/restore/ — one use case per class
export class ReconcileSessions   { execute(): Promise<Result<RestoreRun, RestoreError>>; }
export class ReplayTelemetryInbox{ execute(opts: { batch: number }): Promise<Result<{ replayed: number; failed: number }, RestoreError>>; }
export class RederiveOpenPrompts { execute(): Promise<Result<PromptRecovery[], RestoreError>>; }
export class GetRestoreReport    { execute(id?: string): Promise<Result<RestoreRun, RestoreError>>; }
export type RestoreError = { code: 'TmuxUnavailable' | 'ServerMissing' | 'StoreIo' | 'TransportLost' | 'Timeout'; message: string };

// packages/sdk/src/adapter.ts — additive, optional
export interface ReattachSupport {
  readonly kind: ReattachKind;
  /** Re-bind the daemon-side transport to an already-running agent. `pty-pane` adapters return Ok(noop). */
  reattach(ctx: { sessionId: SessionId; pane: PaneRef; externalSessionId?: string }): Promise<Result<ReattachOutcome, AdapterError>>;
}
export type ReattachOutcome = { status: 'attached' } | { status: 'unavailable'; resumable: boolean; hint: string };
```
`ReattachSupport` is optional on `ProviderAdapter`; an adapter that omits it is treated as `pty-pane` with a no-op reattach (the PTY keeps running in tmux and the daemon needs nothing but the hooks receiver to come back on the same port).

### 4.3 Data / schema changes
Migration `0054_restore` (extends `04-domain-model.md` §4):
- `telemetry_inbox(id text pk, received_at text not null, provider_id text not null, channel text not null, session_id_hint text null, external_id text null, headers_json text null, body text not null, state text not null default 'pending', attempts integer not null default 0, error text null, parsed_at text null)`; unique `(channel, external_id)` where `external_id` is not null (idempotency, matching the ingestion rule in `04-domain-model.md` §3); index `(state, received_at)`.
- `sessions` add `external_session_id text null` (the vendor's own session/thread id, captured at `SessionStart`), `reattach_kind text not null default 'pty-pane'`, `restored_at text null`, `restore_run_id text null`.
- `agent_prompts` add `external_prompt_id text null`, `recovered_count integer not null default 0`, `last_delivery_at text null`; unique `(session_id, external_prompt_id)` where not null.
- `restore_runs(id text pk, started_at, finished_at, sessions_seen, matched, crashed, orphans, inbox_replayed, prompts_open_before, prompts_recovered, prompts_lost, duration_ms, report_json)`.
- New events (extension of the catalog in `04-domain-model.md` §3): `daemon.restarted`, `restore.started`, `restore.completed`, `restore.session_reconciled`, `restore.prompt_recovered`, `restore.prompt_lost`, `restore.orphan_pane`, `telemetry.backlog_replayed`.
- Config (Zod): `features.restore.enabled` (default `true`), `restore.reconcileTimeoutMs` (5 000), `restore.inboxMaxAttempts` (5), `restore.inboxBatch` (500), `restore.promptGraceMs` (120 000 — how long an open prompt survives a restart before expiring), `restore.soakRuns` (5).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Identity at launch (M1-02 change):** `SessionSupervisor` merges `ORCH_SESSION_ID` and `ORCH_HOST_ID` into the `LaunchPlan.env` returned by the adapter (adapters never set them), then after `new-window` it sets the window user option `@orch_session_id` and the pane title:
  `tmux set-option -w -t @<win> @orch_session_id <sid>` · `tmux select-pane -t %<pane> -T 'orch:<sid>'` · plus `tmux set-environment -t <session> ORCH_SESSION_ID_<win> <sid>` as a third, independent copy. Three carriers because each has a different failure mode (user options are lost if the window is recreated; titles are rewritten by some TUIs; `show-environment` is per tmux-session). Verify `set-option -w @user_option`, `select-pane -T`, `show-environment` and `set-environment -t` semantics against the tmux man page for the pinned version at step start.
- **Enumeration at boot:** a single control-mode command
  `list-panes -a -F '#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_title}\t#{@orch_session_id}\t#{pane_start_command}'`
  (verify each format variable, especially `@user_option` interpolation and `pane_start_command`, against the tmux docs at step start), plus `show-environment -t orchestra` as the fallback carrier. All of it goes through the M1-01 driver owned by the supervisor (D13) — no direct `tmux` spawning elsewhere.
- **Hooks receiver durability:** `/hooks/:provider/:sessionId` now does exactly three things before anything else: Zod-validate the envelope (not the vendor body), `TelemetryInboxPort.put(raw)`, then `fsync` via the SQLite WAL commit. Only then does it hand the record to the parser to compute a hook response within the vendor's deadline. If parsing fails or times out, the receiver still answers with the manifest's safe default (`ask`/`defer`) and the record stays `pending` for replay. Stream-json and app-server readers use the same inbox before parsing.
- **What cannot be saved, honestly:** while the daemon is dead, an agent's hook POST gets a connection refused. Per `03-architecture.md` §8 the CLI then falls back to its own native prompt in the pane; the agent is *not* lost, it is waiting on the PTY. Restore therefore re-derives that prompt from the session log / stream backlog and opens it with transport `send-keys-acked`, which is exactly the documented fallback in D14. The zero-lost guarantee is about **prompt state**, never about answering HTTP while the process is dead.
- **Re-attach per provider (verify at step start):**
  - *Claude Code* — interactive pane: `pty-pane`. The pane process is untouched; the hooks config written at launch still points at `http://127.0.0.1:<port>/hooks/claude/<sid>`, so the daemon must rebind the **same port** (boot fails loudly if the port is taken, rather than drifting to another). Open prompts are re-derived from the session JSONL tail (M5-02 offsets) plus the inbox. (verify hook-config and session-log behaviour against Claude Code docs at step start)
  - *Codex* — if M1-06 runs `codex app-server` as a daemon-owned child process, that transport dies with the daemon: `stdio-child`, `reattach → { status: 'unavailable', resumable: manifest.limits.resume }`. The session is marked `crashed`, its open prompts `cancelled(session_gone)`, and Attention offers "resume thread" using the stored `external_session_id`. If M1-06 instead runs app-server inside a tmux pane behind a relay, the adapter reports `pty-pane`. Which one applies is an M1-06 fact — the step starts by reading that adapter's transport decision, not by assuming one. (verify against Codex docs and the pinned app-server schema at step start)
  - *Antigravity* — `-p --input-format stream-json` over stdio is likewise `stdio-child`; interactive `agy` panes are `pty-pane`. C11 forbids any recovery path that touches the Service backend; recovery is limited to the local binary. (verify against Antigravity docs at step start)
- **Boot order** (daemon lifecycle hook, all inside `features.restore.enabled`): config → DB migrations → event store → `daemon.restarted` event → tmux attach + `ReconcileSessions` → `ReplayTelemetryInbox` (drain to empty or `reconcileTimeoutMs`, whichever first, then continue in background) → `RederiveOpenPrompts` → `VerifyRecordingPipes` (M5-01) → HTTP/WS listeners open. The HTTP port opens **after** reconcile so a UI never sees a half-restored world; `/health` reports `restoring` from a tiny bootstrap listener.
- Metrics (Prometheus, `/metrics`): gauge `restore_lost_prompts`, gauge `telemetry_inbox_backlog{state}`, histogram `restore_duration_ms`, counters `restore_sessions_total{verdict}`, `restore_prompts_recovered_total{reason}`.

### 4.5 API / UI surface
- `GET /restore/last` → `RestoreRun` (+ per-session decisions); `GET /restore/runs?limit=` → history.
- `GET /health` → `{ status: 'ok' | 'restoring' | 'degraded', restore: { running, lostPrompts, backlog } }`.
- `POST /prompts/:id/redeliver` → re-send an answered-but-undelivered answer (explicit user action for `send-keys-acked`, C10 preview first).
- WS `/ws` reconnect protocol: client sends `{ type: 'subscribe', topics: [...], sinceEventId? }`; server replies `{ type: 'snapshot', asOfEventId, state }` then `{ type: 'delta', eventId, event }` in order. A client detecting a gap (`eventId` jump) re-subscribes without `sinceEventId`. Topic `restore` carries `restore.started|completed`.
- Web: global `RestoreBanner` ("Daemon restarted — restored N sessions, M prompts recovered" with a link to the report; auto-dismiss after 30 s, sticky when `lostPrompts > 0` or orphans exist). Session cards/Terminals headers show a `RESTORED` badge (icon + label) for one hour. Attention items recovered by restore show a "recovered after restart" note and, when the transport is `send-keys-acked`, an explicit "re-send answer" button instead of silent delivery. Timeline (M5-04) renders `daemon.restarted` as a marker on the event lane.
- `orch` CLI (minimal here, full in M7-06): `orch restore report [--json]`.

### 4.6 Flow / sequence
```
LAUNCH (M1-02)      env{ORCH_SESSION_ID} + @orch_session_id + pane title 'orch:<sid>'  ──▶ sessions row
RUNTIME             hook POST ─▶ inbox.put(raw) ─▶ commit ─▶ parse ─▶ NormalizedEvent[] ─▶ AgentPrompt(open)
KILL -9             daemon dies; tmux + panes + pipe-pane recorders keep running; agent waits on its own prompt
BOOT
  1 daemon.restarted event
  2 ReconcileSessions: list-panes -a ──▶ reconcile(panes, rows, now) ──▶ decisions
        matched_alive → running|waiting_for_input   pane_missing/dead → crashed (+cancel prompts)
        orphan_pane   → Attention item (never killed) transport_lost → crashed + resumable hint
  3 ReplayTelemetryInbox: claimBatch(500) ──▶ adapter.telemetry.parse ──▶ ingest (idempotent by externalId)
  4 RederiveOpenPrompts: agent_prompts(open) ∪ prompts found in replay ──▶ PromptRecovery[]
        answered & !delivered & ack-based transport ──▶ re-deliver (idempotent)
        answered & send-keys-acked                  ──▶ needs_user_confirmation
        open older than promptGraceMs & session gone ──▶ expired
  5 VerifyRecordingPipes (M5-01) ──▶ re-pipe + recording.gap if needed
  6 restore.completed{restore_lost_prompts} ──▶ metrics ──▶ open HTTP/WS
UI RECONNECT        subscribe{sinceEventId} ──▶ snapshot(asOfEventId) ──▶ delta… ──▶ Attention shows the SAME prompt id
```

## 5. Tasks
- [ ] M1-02 change: inject `ORCH_SESSION_ID`/`ORCH_HOST_ID` into `LaunchPlan.env`; set `@orch_session_id`, pane title and tmux environment after `new-window`; store `external_session_id` when the adapter reports it.
- [ ] `packages/core/src/restore/`: `PaneSnapshot`, `SessionRow`, `reconcile()` pure function, verdict/transition rules, `PromptRecovery` rules (100 % branch coverage).
- [ ] `TelemetryInboxPort` + `RestoreError` union in `packages/core/src/ports/`.
- [ ] Migration `0054_restore` (`telemetry_inbox`, `restore_runs`, session/prompt columns) + `SqliteTelemetryInbox` with single-writer `claimBatch`.
- [ ] Hooks receiver: inbox-before-parse, safe-default response on parse failure/timeout, idempotent `(channel, external_id)`.
- [ ] Stream-json / app-server / session-log readers write to the inbox before parsing (M1-08 pipeline change).
- [ ] Inbox drainer service (background, batched, `maxAttempts`, backlog metric, `telemetry.backlog_replayed` event).
- [ ] Control-mode enumeration in the tmux driver (`list-panes -a -F …`, `show-environment`) exposed as a supervisor message.
- [ ] `ReconcileSessions`, `ReplayTelemetryInbox`, `RederiveOpenPrompts`, `GetRestoreReport` use cases; daemon boot-order wiring + bootstrap `/health` listener.
- [ ] `ReattachSupport` in `packages/sdk`; implement for claude (`pty-pane`), codex and agy (per their M1-05..07 transport facts); contract test `reattach.contract.spec.ts`.
- [ ] Answer re-delivery path with transport idempotency guard + `POST /prompts/:id/redeliver`.
- [ ] Metrics + `restore.*` events + `daemon.restarted` marker consumed by M5-04's event lane.
- [ ] WS `sinceEventId` snapshot+delta protocol, gap detection and re-snapshot on both server and client.
- [ ] Web: `RestoreBanner`, `RESTORED` badges, Attention "recovered after restart" note and "re-send answer" action, restore report drawer.
- [ ] `scripts/restore-soak.sh`: launch N FakeProvider sessions with open prompts, `kill -9`, restart, assert `restore_lost_prompts == 0`, repeat `restore.soakRuns` times; wire into CI (FakeProvider only) and nightly.
- [ ] Package README (`application/restore`) + `PROGRESS.md` row + `RISKS.md` entry for `stdio-child` providers.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-05-01 | unit (fast-check) | `reconcile()` over random pane/row sets incl. recycled pane ids, duplicate `ORCH_SESSION_ID`, missing options | total function, order-independent, never adopts on pane-id match alone; duplicates → one `matched_alive` + one `orphan_pane`, never two adoptions |
| UT-M5-05-02 | unit | prompt recovery rules for every `(previousState × transport × session verdict)` combination | `send-keys-acked` answers are never auto-redelivered; `open` keeps its id; `session_gone` cancels; grace-period expiry works; 100 % branch |
| UT-M5-05-03 | unit | `restore_lost_prompts` computation on hand-built before/after sets | counts only prompts in none of the terminal/open states; zero for all legitimate paths |
| AT-M5-05-01 | adapter contract | `reattach.contract.spec.ts` for claude/codex/agy fixtures | every adapter declares a `ReattachKind`; `stdio-child` adapters return `unavailable` with a `resumable` flag and never throw |
| IT-M5-05-01 | integration (real tmux + FakeProvider) | 5 sessions, 2 with open prompts; `SIGKILL` daemon; restart | all 5 matched; both prompts still `open` with the same ids; `restore_lost_prompts=0`; states correct |
| IT-M5-05-02 | integration | POST 50 hook payloads while the parser is stubbed to throw; restart | all 50 rows in `telemetry_inbox`; after restart all parse and ingest exactly once (no duplicate events by `(channel, externalId)`) |
| IT-M5-05-03 | integration | kill a pane externally (`tmux kill-window`) while the daemon is down | session → `crashed`, prompts `cancelled(session_gone)`, one `restore.session_reconciled` event, no exception |
| IT-M5-05-04 | integration | an unknown pane with `ORCH_SESSION_ID=bogus` present at boot | classified `orphan_pane`, Attention item created, pane still alive afterwards (never killed) |
| IT-M5-05-05 | integration | answered-but-undelivered prompt with an ack-based transport | re-delivered exactly once after restore; `prompt.delivered` then `acknowledged`; a second restore does not re-deliver again |
| IT-M5-05-06 | integration (soak) | `restore-soak.sh` with `soakRuns=5` | `restore_lost_prompts=0` in all 5 runs; `restore_duration_ms` p95 ≤ 5 000 ms with 20 sessions |
| E2E-M5-05-01 | e2e (Playwright + FakeProvider) | UI open with a prompt visible; daemon killed and restarted | banner appears, Attention shows the same prompt id, answering it succeeds; WS re-subscribed with `sinceEventId` and received no duplicate events |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-05-01 | `kill -9` with an open permission prompt on real Claude Code | 1. Start a Claude session in `~/orchestra-scratch/`. 2. Ask it to delete a file so a `PreToolUse` permission prompt opens; note the prompt id. **Do not answer.** 3. `kill -9 $(pgrep -f orchestrad)`. 4. `tmux ls` and check the pane. 5. Restart the daemon; watch `/health`. 6. Open Attention and approve. | tmux session and pane still alive in step 4; within 5 s of restart the same prompt id is `open`; `curl 127.0.0.1:4300/metrics \| grep restore_lost_prompts` prints `0`; approving lets the agent proceed and the tool result appears in the transcript | ⬜ |
| TC-M5-05-02 | Five consecutive kills (resilience) | 1. Repeat TC-01 five times in a row on the same host, varying the moment of the kill (before the prompt, during, after the answer is queued). | `restore_lost_prompts=0` on all five; no duplicate prompts; no duplicate messages in the transcript; `restore_runs` has 5 rows with sane counts | ⬜ |
| TC-M5-05-03 | Hook backlog replay | 1. With a Claude session running a multi-tool task, `kill -9` the daemon mid-task. 2. Wait 30 s while the agent keeps working in the pane. 3. Restart. | After restart the transcript and the event list contain every tool call made during the outage (from the session-log tail and/or inbox), in order, with no gaps and no duplicates; `telemetry.backlog_replayed` event present | ⬜ |
| TC-M5-05-04 | Prompt asked *while* the daemon is down (negative-path honesty) | 1. `kill -9` the daemon. 2. In the pane, drive the agent to a permission prompt (it shows its own native prompt). 3. Restart the daemon. | Session is `waiting_for_input`; an `AgentPrompt` for that request exists in Attention with transport `send-keys-acked` and a "re-derived after restart" note; answering it from the web sends the mapped keystrokes and the agent continues; `restore_lost_prompts` is still `0` | ⬜ |
| TC-M5-05-05 | Codex session restart behaviour | 1. Start a Codex session and let it run. 2. `kill -9` the daemon. 3. Restart. | Outcome matches the adapter's declared `ReattachKind`: `pty-pane` → session `running`/`waiting_for_input` and controllable again; `stdio-child` → session `crashed` with a "resume thread" action in Attention using the stored `external_session_id`, and the reason is shown, not hidden | ⬜ |
| TC-M5-05-06 | Antigravity (opt-in) restart | 1. With ToS acknowledged, run an interactive `agy` pane. 2. `kill -9`; restart. | Interactive pane re-adopted like Claude; a headless stream-json agy run is reported `crashed` with a resume hint; no call touches anything but the local binary (C11) | ⬜ |
| TC-M5-05-07 | Pane killed while the daemon is down (negative) | 1. `kill -9` the daemon. 2. `tmux kill-window -t <window>` for one running session. 3. Restart the daemon. | That session is `crashed` (not `stopped`), its open prompts are `cancelled` with reason `session_gone`, Attention explains it, other sessions are unaffected | ⬜ |
| TC-M5-05-08 | Foreign tmux window is never touched | 1. `tmux new-window -t orchestra -n mine 'bash'` manually. 2. Restart the daemon. | Window `mine` still exists and is untouched; if it carries no `ORCH_SESSION_ID` it is ignored entirely (not even reported); an injected bogus `@orch_session_id` produces an `orphan_pane` Attention item and still no kill | ⬜ |
| TC-M5-05-09 | Port conflict at restart (negative) | 1. Occupy `:4300` with `nc -l 4300`. 2. Start the daemon. | Boot fails fast with a clear error naming the port and the consequence ("agents' hook configs point at this port"); it never silently binds a different port; freeing the port and restarting restores normally | ⬜ |
| TC-M5-05-10 | UI reconnect: snapshot + delta | 1. With Terminals and Attention open, restart the daemon. 2. Watch the network panel. | Client re-subscribes with `sinceEventId`; one `snapshot` then ordered `delta`s; no duplicated Attention rows; terminals re-attach and the pane's live output resumes; banner shows the restore summary | ⬜ |
| TC-M5-05-11 | Recording continuity across restart | 1. Do TC-01 while recording is enabled. 2. After restart, open Timeline (M5-04). | The `.cast` has no gap across the outage (M5-01 TC-05 behaviour), `daemon.restarted` shows as a marker on the event lane, and `VerifyRecordingPipes` logged the pipe as active | ⬜ |
| TC-M5-05-12 | Restore with 20 live sessions (load) | 1. Start 20 FakeProvider sessions plus the 2 real ones. 2. `kill -9`; restart; time it. | Reconcile completes ≤ 5 s; `/health` reports `restoring` then `ok`; memory stays within the 300 MB idle budget; `restore_lost_prompts=0` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M5-05-01 … 12 pass, with TC-01/TC-02 executed on a real Claude Code session (the 1.0 DoD item).
- [ ] `restore_lost_prompts == 0` across ≥ 5 consecutive `kill -9` runs on real CLIs and across the automated soak (IT-06).
- [ ] Every raw telemetry payload is persisted to `telemetry_inbox` before any parsing, and replay is exactly-once by `(channel, external_id)` (IT-02, TC-03).
- [ ] `reconcile()` and the prompt-recovery rules are at 100 % branch coverage and never adopt a pane on pane-id match alone.
- [ ] Panes Orchestra does not own are never killed, modified or resized by restore (TC-08).
- [ ] Every adapter declares a `ReattachKind`; providers whose transport cannot survive a daemon restart report it explicitly with a resume hint — no silent zombie sessions (AT-01, TC-05, TC-06).
- [ ] WS reconnect delivers snapshot + ordered deltas with no duplicates and no missed events (TC-10, E2E-01).
- [ ] Reconcile p95 ≤ 5 s with 20 sessions; HTTP opens only after reconcile; `/health` reports `restoring` in between.
- [ ] No new lint / dependency-cruiser violations; no tmux access outside the supervisor (D13); OpenAPI + metrics documented; README written.

## 8. Risks / open questions
- tmux carrier semantics: window user options (`@orch_session_id`), `pane_title` and `show-environment` all have version-dependent behaviour; `pane_start_command` may be empty for panes created before a tmux restart (verify all of them against the tmux man page for the pinned version at step start). Three independent carriers plus the DB row is the mitigation; if all three are absent the pane is an `orphan_pane`, never a guess.
- Codex `app-server` and Antigravity stdio transports are daemon-owned; whether a restart can re-attach at all depends on M1-06/M1-07's process model (verify against Codex and Antigravity docs at step start). If they cannot, the honest outcome is `crashed` + resume, and the milestone's zero-lost-prompt claim must be stated as "prompts are never lost; sessions on `stdio-child` transports are reported as crashed with a resume path".
- Claude Code hook configs written at launch embed the daemon URL. Changing the port between restarts silently breaks the hook channel — hence fail-fast on port conflict (TC-09). Long-term, a per-session token in the hook URL (M9-01) must be stable across restarts too.
- Prompts asked while the daemon was down arrive only with `send-keys-acked`, the weakest transport (D14). Auto-answer policies must refuse to act on re-derived keystroke prompts without user confirmation; verify this against the M1-11 auto-answer policy defaults.
- Inbox write on the hot path adds one SQLite commit per hook. The load test must confirm hook round-trip stays inside the vendor's hook deadline; if not, batch commits with `PRAGMA synchronous=NORMAL` under WAL and document the (small) durability window.
- `claimBatch` must stay single-writer; with Postgres (M9-05) it becomes `SELECT … FOR UPDATE SKIP LOCKED`. Keep the port free of SQLite-specific semantics.
- A pane that is alive but whose agent has exited (shell prompt left behind) reads as `matched_alive`; `pane_dead` only covers tmux's own notion. Mitigation: cross-check `pane_pid` against the launch pid recorded at start, and treat a mismatch as `matched_dead` — verify `pane_pid` semantics for panes running a shell wrapper.
- Restoring 50+ sessions could exceed the 5 s budget on a cold page cache; reconcile is a single tmux round-trip plus one DB query by design, but the prompt re-derivation reads session logs — bound it by `reconcileTimeoutMs` and finish in the background.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
