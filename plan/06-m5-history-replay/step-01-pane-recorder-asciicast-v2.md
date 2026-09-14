# Step M5-01 — Pane recorder (asciicast v2)

| Field | Value |
|---|---|
| Milestone | M5 — History, recording, replay |
| Status | ⬜ Not started |
| Depends on | M1-02, M1-01, M0-05 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `apps/daemon` (`src/application`, `src/infrastructure/recorder`, `src/interface/http`), `apps/web`, `packages/sdk` (FakeProvider scenario) |
| Risk | Medium |
| Owner | |

## 1. Goal
Every tmux pane that hosts an agent is recorded to an **asciicast v2** file under `~/.orchestra/recordings/<sessionId>/` from the moment the session launches until it stops, with secrets scrubbed **before** bytes touch disk, files rotated by size, and per-session plus global disk budgets enforced. The recording survives a daemon crash because the capture pipe is owned by tmux, not by the daemon. The user sees a `REC` badge and file size in the Terminals pane header and can download the raw `.cast` from the session page. This step also resolves ADR-004.

## 2. Why
- G5 "total recall": a replayable terminal recording is the ground truth that M5-04 links chat, events and diffs to.
- D2 (tmux substrate): the recording must outlive the daemon exactly like the pane does; the choice of capture source decides that (ADR-004).
- C13: "secrets never stored; scrubbed from recordings at capture time" — this step is the enforcement point named in `07-compliance-rules.md`.
- C7: PTY bytes go to recording + xterm only; the recorder must never parse them for state.
- D8: recordings are user-owned files; the `RecordingPort` abstraction lets M9-05 swap the store for S3 without touching use cases.

## 3. Scope
### In scope
- ADR-004 decision written to `plan/adr/ADR-004-recording-source.md` (status Accepted) and linked from `DECISIONS.md`.
- `RecordingSource` strategies: `pipe-pane` (default) and `control-mode` (flag `features.history.recorderSource`).
- Recorder helper process `orch-rec` (spawned by tmux via `pipe-pane`) that timestamps, redacts, rotates and writes asciicast v2.
- Streaming secret redactor in `packages/core/src/redaction/` (rule list + chunk-boundary carry-over).
- `recordings` table extended; `RecordingPort` + `FsRecordingStore`.
- Per-session and global byte budgets; `recording.budget_exceeded` Attention item.
- Boot/periodic self-check that every running session's pane is still piped; gap markers.
- HTTP endpoints to list/stream recordings; Terminals header `REC` badge.
- FakeProvider scenario `recording-secrets.yaml` that prints every fixture secret shape.
### Out of scope (deferred to …)
- Replay UI, scrubber, linking to chat/events — deferred to M5-04.
- Manual redaction of an existing recording, TTL purge — deferred to M5-06.
- S3 `RecordingStore` — deferred to M9-05.
- Recording keyboard input (`"i"` events) — never (input can contain pasted secrets; output redaction is the only path).
- Recording panes not owned by Orchestra (user's own tmux windows) — never.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Recording` (child of `Session`): `{ id, sessionId, paneId, segment, path, format: 'asciicast-v2', bytes, startedAt, endedAt?, state, redactionRulesVersion, source }`.
- `RecordingState`: `recording → closed | rotated | failed | purged`. Rotation closes segment *n* (`rotated`) and opens *n+1* (`recording`).
- `RedactionRule` value object: `{ id, pattern (RegExp source, flags), replacement, maxLen }`. `maxLen` bounds the carry-over buffer.
- Rules (pure, in `packages/core`): a recording may only be created for a session in `launching|running|waiting_for_input`; a session has at most one `recording` segment at a time; `bytes` of all segments of a session ≤ `maxBytesPerSession`; sum over non-purged recordings ≤ `maxTotalBytes` else new recordings are refused with `RecordingBudgetExceeded`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/ports/recording-port.ts
export interface RecordingSource {                       // how bytes are captured (DI strategy keyed by id)
  readonly id: 'pipe-pane' | 'control-mode';
  start(cmd: StartRecordingCommand): Promise<Result<RecordingHandle, RecordingError>>;
  stop(handle: RecordingHandle): Promise<Result<void, RecordingError>>;
  isActive(handle: RecordingHandle): Promise<Result<boolean, RecordingError>>;   // pane still piped?
}
export interface RecordingStore {                        // where files live (fs now, S3 in M9-05)
  open(recordingId: RecordingId, range?: ByteRange): Promise<Result<ReadableStream<Uint8Array>, RecordingError>>;
  stat(recordingId: RecordingId): Promise<Result<{ bytes: number }, RecordingError>>;
  remove(recordingId: RecordingId): Promise<Result<void, RecordingError>>;
  usage(): Promise<Result<{ totalBytes: number }, RecordingError>>;
}
export interface RecordingRepository {
  save(r: Recording): Promise<Result<void, RepoError>>;
  bySession(id: SessionId): Promise<Result<Recording[], RepoError>>;
  activeSegment(id: SessionId): Promise<Result<Recording | null, RepoError>>;
}
export interface StartRecordingCommand { sessionId: SessionId; paneId: PaneRef; cols: number; rows: number; dir: string; segment: number; rulesPath: string; maxBytesPerSegment: number; }
export interface RecordingHandle { recordingId: RecordingId; sessionId: SessionId; paneId: PaneRef; sourceId: RecordingSource['id']; }
export type RecordingError = { code: 'RecordingBudgetExceeded' | 'PaneNotFound' | 'PipeFailed' | 'StoreIo' | 'NotRecording'; message: string };

// packages/core/src/redaction/redactor.ts  (pure; also used by M5-02 tool args and M5-06 export)
export interface Redactor { push(chunk: string): string; flush(): string; readonly rulesVersion: string; }
export function createStreamingRedactor(rules: RedactionRule[], carryBytes?: number): Redactor;

// asciicast v2 writer (infrastructure)
export interface AsciicastWriter { header(h: { width: number; height: number; timestamp: number; title?: string; env?: Record<string,string> }): void; output(tSec: number, data: string): void; marker(tSec: number, label: string): void; resize(tSec: number, cols: number, rows: number): void; close(): Promise<void>; }
```
Use cases (one class each, `apps/daemon/src/application/recording/`): `StartRecording`, `StopRecording`, `RotateRecordingSegment`, `VerifyRecordingPipes` (boot + interval), `ListRecordings`, `StreamRecording`. `SessionSupervisor` (M1-02) calls `StartRecording` after `launched` and `StopRecording` on `stopping`; it never touches files itself.

### 4.3 Data / schema changes
Migration `0050_recordings_v2` (extends `recordings` from `04-domain-model.md` §4):
`recordings` add `pane_id text`, `segment integer not null default 0`, `state text not null default 'recording'`, `source text not null`, `redaction_rules_version text not null`, `cols integer`, `rows integer`, `sha256 text null` (filled on close), `purged_at text null`; unique `(session_id, segment)`; index `(state)`.
New events (extension of the `session.*` namespace in `04-domain-model.md` §3): `recording.started`, `recording.rotated`, `recording.stopped`, `recording.gap` (payload `{fromTs, toTs, reason}`), `recording.budget_exceeded`. Config (Zod): `features.history.recorder: boolean` (default `false` until M5 acceptance), `features.history.recorderSource: 'pipe-pane'|'control-mode'` (default `pipe-pane`), `history.recordings.dir`, `maxBytesPerSegment` (50 MB), `maxBytesPerSession` (500 MB), `maxTotalBytes` (5 GB), `redaction.extraRulesFile?`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
**ADR-004 resolution (recommendation, to be recorded as Accepted):**

| | `pipe-pane` → helper process (default) | control-mode `%output` (flag) |
|---|---|---|
| Survives daemon death | yes — tmux owns the pipe | no — gap until re-attach; scrollback snapshot only |
| Timestamp accuracy | helper stamps on receipt (sub-ms) | daemon stamps after control-mode parse |
| Redaction before disk | helper redacts in-process | daemon redacts in-process |
| Extra processes | one `node orch-rec.js` per pane | none |
| Failure modes | pipe silently dropped (needs `#{pane_pipe}` check) | parser backpressure affects terminals too |
| Container / M9-06 | needs `node` visible to tmux server | works with only the daemon |

Default = `pipe-pane`; `control-mode` stays as a supported fallback (containers, hosts where tmux cannot see `node`). Both write through the same `AsciicastWriter` and `Redactor`.

- Start: `tmux pipe-pane -o -t %<pane> 'node <daemonDir>/orch-rec.js --out <dir>/<seg>.cast --rules <rulesPath> --cols C --rows R --max-bytes N --session <sid> --segment <seg>'`. `-o` makes the call idempotent (no second pipe if one exists) — verify `-o`/`-I`/`-O` semantics against the tmux man page at step start.
- Verify: `tmux display-message -p -t %<pane> '#{pane_pipe}'` → `1` (verify the `pane_pipe` format variable exists in tmux ≥ 3.3 at step start). Run at boot, after every reconcile (M5-05), and every 30 s; if `0` for a running session → re-issue `pipe-pane`, write `recording.gap`.
- Helper `orch-rec` (`apps/daemon/src/infrastructure/recorder/pipe-pane/orch-rec.ts`, bundled to a single file at build): reads stdin, `Redactor.push`, `AsciicastWriter.output(now - t0)`, rotates at `--max-bytes` by closing and opening `<seg+1>.cast` (writes a `.rotated` sentinel the daemon watches via `fs.watch` on the session dir). Creates files `0600`, dirs `0700`. Never inherits the daemon env; only argv. Exit codes: `0` on pane close, `3` on budget cap (writes marker `orch:cap-reached` first).
- Redactor carry-over: hold back ≤ 256 bytes (max `RedactionRule.maxLen`) between chunks; flush on 200 ms idle. Built-in rules (ids): `aws-access-key`, `aws-secret-key`, `github-token` (`gh[pousr]_`, `github_pat_`), `openai-key` (`sk-`), `anthropic-key` (`sk-ant-`), `google-api-key` (`AIza`), `slack-token` (`xox[abprs]-`), `jwt`, `pem-private-key`, `bearer-header`, `basic-auth-url`, `generic-kv` (`(api[_-]?key|secret|token|password)\s*[=:]\s*\S{8,}`). Replacement is `[REDACTED:<ruleId>]`. Rules file is JSON, Zod-validated, versioned by content hash (`redactionRulesVersion`).
- `control-mode` source: `TmuxControlDriver` (M1-01) already emits decoded `%output` per pane; `ControlModeRecordingSource` subscribes, redacts, writes. On (re)attach it writes `recording.gap` and a `capture-pane -p -e -S -` snapshot as a single output event labelled with marker `orch:snapshot`.
- Store: `FsRecordingStore` under `history.recordings.dir` (default `~/.orchestra/recordings/`), one directory per session, `NNN.cast` segments; `usage()` via cached directory scan refreshed on every close/rotate.

### 4.5 API / UI surface
- `GET /sessions/:id/recordings` → `Recording[]` (Zod response schema).
- `GET /recordings/:id` → metadata; `GET /recordings/:id/cast` → `application/x-asciicast` stream, honours `Range`; auth = local token (M0-04).
- WS `/ws` topic `recording.<sessionId>`: `started|rotated|stopped|gap|budget_exceeded`.
- Terminals pane header (M1-09): `REC 12.4 MB` badge (`status-recording` token, icon + text, never colour-only); tooltip lists segments; click → session page recordings list with download links. Header shows `REC paused` + reason when budget exceeded.
- Attention item kind `platform.recording_budget` with actions "open retention settings" (M5-06) / "dismiss".

### 4.6 Flow / sequence
```
SessionSupervisor ── session.launched ──▶ StartRecording
   ├─ RecordingRepository.activeSegment == null ✔  budgets ✔
   ├─ RecordingSource('pipe-pane').start(cmd)  ──▶ tmux pipe-pane -o … orch-rec
   ├─ save Recording{state: recording}; emit recording.started
   └─ (fs.watch) .rotated sentinel ──▶ RotateRecordingSegment ──▶ close seg n, save seg n+1, emit recording.rotated
SessionSupervisor ── session.stopping ──▶ StopRecording ──▶ tmux pipe-pane -t %pane (no cmd = close) ; sha256 ; state closed
Boot / every 30 s ── VerifyRecordingPipes ──▶ for each running session: #{pane_pipe}==1 ? ok : re-issue + recording.gap
```

## 5. Tasks
- [ ] Write `plan/adr/ADR-004-recording-source.md` (Accepted: pipe-pane default, control-mode behind flag) and update `DECISIONS.md` row.
- [ ] `packages/core/src/redaction/`: `RedactionRule`, built-in rules, `createStreamingRedactor` with carry-over; 100 % branch coverage.
- [ ] `packages/core/src/recording/`: `Recording` entity, state transitions, budget rules, `RecordingError` union.
- [ ] Ports `RecordingSource`, `RecordingStore`, `RecordingRepository` in `packages/core/src/ports/`.
- [ ] Migration `0050_recordings_v2` + Kysely repository `SqliteRecordingRepository`.
- [ ] `AsciicastWriter` (header, `o`, `m`, `r` events; verify `m`/`r` event support in the asciicast v2 spec at step start).
- [ ] `orch-rec` helper: argv Zod schema, stdin pump, redactor, writer, rotation, sentinel, exit codes; bundle step in `apps/daemon` build.
- [ ] `PipePaneRecordingSource` (start/stop/isActive via tmux driver messages to `SessionSupervisor` — no direct tmux calls outside the supervisor, D13).
- [ ] `ControlModeRecordingSource` behind `features.history.recorderSource`.
- [ ] Use cases `StartRecording`, `StopRecording`, `RotateRecordingSegment`, `VerifyRecordingPipes`, `ListRecordings`, `StreamRecording`; wire into `SessionSupervisor` lifecycle.
- [ ] `FsRecordingStore` with `0600/0700` permissions and `usage()` cache.
- [ ] HTTP controller + WS topic + OpenAPI entries; Zod schemas for responses.
- [ ] Terminals header `REC` badge + session page recordings list (`apps/web`).
- [ ] FakeProvider scenario `recording-secrets.yaml` printing every rule's sample secret; `packages/sdk` fixture list of secret samples shared with contract tests.
- [ ] Nightly load job: 50 FakeProvider panes recording for 10 min; assert memory budgets and no `recording.gap`.
- [ ] Package README for `infrastructure/recorder`; `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M5-01-01 | unit | every built-in rule against its positive/negative samples | positives replaced with `[REDACTED:<id>]`; negatives untouched; 100 % branch |
| UT-M5-01-02 | unit (fast-check) | secret split at every byte boundary across two `push()` calls | secret never appears in concatenated output; non-secret bytes preserved in order |
| UT-M5-01-03 | unit | `Recording` state machine and budget rules | illegal transitions → `Err`; per-session and global caps enforced |
| UT-M5-01-04 | unit | `AsciicastWriter` output | first line valid v2 header; each event `[number,"o"|"m"|"r",string]`; times monotonic |
| IT-M5-01-01 | integration (real tmux, Linux CI) | start FakeProvider session with recorder on; stop | `000.cast` exists, parses, contains scenario output, `recordings.state='closed'`, `sha256` set |
| IT-M5-01-02 | integration | `recording-secrets.yaml` scenario | `grep` of every sample secret over the session dir returns nothing |
| IT-M5-01-03 | integration | `maxBytesPerSegment=64KB`, scenario prints 300 KB | ≥ 4 segments, `recording.rotated` events, segment times continuous |
| IT-M5-01-04 | integration | kill the daemon process (SIGKILL) while pane prints; restart | no bytes missing between pre-kill and post-restart output in the cast; `VerifyRecordingPipes` finds pipe active |
| IT-M5-01-05 | integration | `maxTotalBytes` reached | new session starts but `recording.budget_exceeded` emitted; no file created; Attention item present |
| E2E-M5-01-01 | e2e (Playwright + FakeProvider) | Terminals header | `REC` badge with size appears within 2 s of launch; download link returns `application/x-asciicast` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M5-01-01 | Real Claude Code session is recorded | 1. Enable `features.history.recorder`. 2. Start Claude Code session from Fleet in `~/orchestra-scratch/`. 3. Type `ls` in the pane. 4. Stop session. | `~/.orchestra/recordings/<sid>/000.cast` exists, mode `0600`; `asciinema play` (or M5-04 player) shows the `ls` output; `recordings` row `state='closed'`, `bytes` matches file size | ⬜ |
| TC-M5-01-02 | Codex session recorded | 1. Start Codex session. 2. Run a short task. 3. Stop. | Same as TC-01 for the Codex pane; `source='pipe-pane'` | ⬜ |
| TC-M5-01-03 | Capture-time redaction (C13) | 1. In a running pane: `echo AKIAIOSFODNN7EXAMPLE`, `echo ghp_0123456789abcdefghijklmnopqrstuvwxyz0123`, `echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc`. 2. `grep -rc 'AKIA\|ghp_\|eyJ' ~/.orchestra/recordings/<sid>/` | All counts `0`; `grep -c REDACTED` ≥ 3; the terminal in the browser still shows the real values (xterm path is not redacted) | ⬜ |
| TC-M5-01-04 | Rotation by size | 1. Set `maxBytesPerSegment=1MB`. 2. In the pane run `yes | head -c 3000000`. | `000.cast`, `001.cast`, `002.cast` present; `recording.rotated` twice in the events list; header badge shows total size | ⬜ |
| TC-M5-01-05 | Daemon `kill -9` does not stop recording (resilience) | 1. Pane running `for i in $(seq 1 60); do echo tick-$i; sleep 1; done`. 2. At tick ~10 `kill -9 $(pgrep -f orchestrad)`. 3. Restart daemon at tick ~25. 4. After tick 60 stop session. | Cast contains `tick-1` … `tick-60` with no gap; one `recording.gap` event is **not** present (pipe never broke); `VerifyRecordingPipes` logs pipe active on boot | ⬜ |
| TC-M5-01-06 | Pipe lost → self-heal | 1. Running session. 2. Manually `tmux pipe-pane -t %<pane>` (closes pipe). 3. Wait 40 s. | Within 30 s `#{pane_pipe}` is `1` again; `recording.gap` event with reason `pipe_missing`; new segment started | ⬜ |
| TC-M5-01-07 | Global budget exceeded (negative) | 1. Set `maxTotalBytes` below current usage. 2. Start a new session. | Session runs; header shows `REC paused (budget)`; Attention item `platform.recording_budget`; no file created; restoring the budget and starting another session records normally | ⬜ |
| TC-M5-01-08 | control-mode source parity | 1. Set `recorderSource=control-mode`. 2. Repeat TC-01. 3. Repeat TC-05. | TC-01 passes identically; TC-05 shows a `recording.gap` event and an `orch:snapshot` marker after restart (documented limitation) | ⬜ |
| TC-M5-01-09 | Recording disabled by default | 1. Fresh config without `features.history.recorder`. 2. Start a session. | No `recordings` row, no directory, no `REC` badge; no error logged | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] ADR-004 Accepted and linked; `DECISIONS.md` updated.
- [ ] All TC-M5-01-01 … 09 pass on real Claude Code and Codex.
- [ ] IT-M5-01-02 and TC-03 prove no fixture secret reaches disk; recording files and dirs are `0600`/`0700`.
- [ ] `kill -9` of the daemon produces zero missing bytes with the default source (TC-05).
- [ ] Rotation and both budgets behave as specified; Attention item appears on global budget breach.
- [ ] `packages/core/src/redaction` and `recording` at 100 % branch coverage; no `node:child_process` or tmux calls outside `apps/daemon/src/infrastructure/**`.
- [ ] Nightly load job green: 50 recording panes, ≤ 40 MB/pane, ≤ 300 MB daemon idle after stop.
- [ ] No new lint / dependency-cruiser violations; OpenAPI updated; package README written.

## 8. Risks / open questions
- tmux `pipe-pane -o` idempotency and `#{pane_pipe}` availability (verify against tmux man page for the pinned version at step start). If `pane_pipe` is missing, fall back to tracking the helper pid via a pidfile the helper writes.
- The helper runs under the tmux server's environment; `node` must be resolvable there. Mitigation: pass the absolute path of the daemon's own `process.execPath` in the pipe command.
- Holding back ≤ 256 bytes for chunk-boundary redaction slightly delays writes; timing in the cast uses receipt time, so replay fidelity is unaffected, but the "REC" size badge lags by one flush.
- asciicast v2 `"m"` (marker) and `"r"` (resize) event types: confirm the player (M5-04) and spec revision support them before relying on markers for gaps (verify against asciinema docs at step start).
- Regex redaction is best-effort (C13 says "scrubbed", not "guaranteed"). Manual redaction (M5-06) closes the gap; document this in `SECURITY.md`.
- Very high-throughput panes (build logs) could exceed helper write speed; measure in the load test and consider `--max-bytes` per second throttling with a `recording.gap` marker rather than back-pressuring the agent.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
