# Step M1-08 — Telemetry plane & fixture recorder

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-05 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/daemon/src/interface/hooks`, `apps/daemon/src/application/telemetry`, `apps/cli` (`orch fixtures record`), `packages/sdk` (fixture tooling) |
| Risk | Medium |
| Owner | |

## 1. Goal
One telemetry pipeline turns every raw vendor signal into domain state: the hooks receiver (HTTP, idempotent, holds pending responses for decision hooks), the stream/RPC/process sources fed by the supervisor and adapters, the adapter `TelemetryParser`s, a `Normalizer` that maps `NormalizedEvent`s to `DomainEvent`s + prompt drafts + session state transitions, with unknown payloads counted and stored for the Doctor. `orch fixtures record <provider>` captures real payloads (redacted) into the provider's fixture folder with a `RECORDED.md`.

## 2. Why
D4 (structured state from official channels), D14 (prompts as durable objects — the draft comes from here), G5, G6 (unknown-payload counters are the drift signal in M6-02), `10-testing-strategy.md` fixture protocol.

## 3. Scope
### In scope
- `HooksReceiver` controller: `POST /hooks/:provider/:sessionId/:hook` → validate session exists + provider matches → persist raw (`telemetry_inbox` table: id, sessionId, provider, hook, body, receivedAt, processedAt, responseSent) → parse → if the hook expects a decision, register `PendingHookResponse` and hold the HTTP response until answered or deadline → else respond immediately (200 `{}`).
- `TelemetryPipeline` (application): `ingest(raw: RawTelemetry)` → adapter parser → for each `NormalizedEvent`: `Normalizer` → `RecordEvent` + repository updates (`sessions.state`, `conversations/messages` minimal in M1: assistant/user messages only) + `PromptDraft` handed to M1-11's `OpenPrompt` use case.
- Sources wiring: supervisor `ProcessExit` → pipeline; Codex RPC notifications (M1-06) → pipeline; agy stream-json (M1-07) → pipeline; Claude headless stream-json → pipeline.
- Unknown handling: `agent.unknown` → `telemetry.unknown_payload` event + counter metric per provider/version (Doctor signal).
- Redaction at ingestion (same regex set as logging) before persisting raw bodies.
- `orch fixtures record <provider> --scenario <name>`: starts a session in the scratch repo with recording flags, tags all raw payloads with the scenario, on stop writes redacted files into `packages/providers/<id>/fixtures/<cliVersion>/{hooks,stream,rpc,exit}/` and updates `RECORDED.md`; `--review` opens a diff for manual check before commit.
### Out of scope (deferred)
- Full conversation capture (attachments, tool args) → M5-02. Restore replay of `telemetry_inbox` → M5-05 (table created here). Quota windows → M4-01.

## 4. Design
### 4.1 Domain
`Normalizer` rules (pure): `prompt_opened → PromptDraft`, `exit → session.exited`, `message → conversation.message`, `usage → agent.usage`, `rate_limited → quota.rate_limited`, `model_switched → session.model_switched`, `unknown → telemetry.unknown_payload`.
### 4.2 Interfaces / contracts
```ts
export interface PendingHookResponse { key: string /* sessionId:hook:externalId */; respond(body: unknown): void; deadline: string; defaultBody: unknown /* sent on deadline */ }
export class HookResponseRegistry { hold(p: PendingHookResponse): void; resolve(key: string, body: unknown): boolean; expire(now: string): void }
export class TelemetryPipeline { ingest(raw: RawTelemetry): Promise<Result<NormalizedEvent[], DomainError>> }
```
Idempotency key: `(provider, sessionId, externalId)` where adapters derive `externalId` from hook ids / RPC ids / line hashes.
### 4.3 Data / schema changes
Migration `0007_telemetry_inbox.ts`: `telemetry_inbox(id, session_id, provider, hook, body_json (redacted), external_id, received_at, processed_at, response_json, error)` + index on `(session_id, received_at)`.
### 4.4 Infrastructure
Receiver binds on the daemon port (127.0.0.1); hook scripts authenticate with a per-session secret in `ORCH_HOOK_TOKEN` (random, injected at launch; never the user token). Deadline timers in-process; on restart, pending responses are lost (the hook script times out and the CLI falls back to native prompt — acceptable in M1; M5-05 improves).
### 4.5 API / UI surface
`POST /hooks/:provider/:sessionId/:hook`; `GET /sessions/:id/telemetry?unknown=true` (debug); CLI `orch fixtures record|list|verify`.
### 4.6 Flow
```
hook POST → auth(ORCH_HOOK_TOKEN) → inbox insert → parser → events/prompts → (decision hook) hold → answer → respond → inbox.processed
```

## 5. Tasks
- [ ] Migration `0007_telemetry_inbox`; repository.
- [ ] `HooksReceiver` + per-session hook token + idempotency + redaction.
- [ ] `HookResponseRegistry` with deadlines + defaults from manifest prompt protocol.
- [ ] `TelemetryPipeline` + `Normalizer` (pure, unit-tested per rule) + wiring to `RecordEvent`, session transitions, minimal messages.
- [ ] Source wiring for process exits, Codex RPC, agy/claude stream-json.
- [ ] Unknown-payload counter + metric + debug endpoint.
- [ ] `orch fixtures record` (CLI + daemon endpoint `POST /dev/fixtures/start|stop`), redaction pass, `RECORDED.md` template, `orch fixtures verify` (runs contract suite for the folder).
- [ ] Load test: 10k hook posts/min sustained (fake agent) without backlog growth.
- [ ] Docs: telemetry sources table per provider.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| IT-M1-08-01 | integration | POST hook with wrong `ORCH_HOOK_TOKEN` | 401; not stored |
| IT-M1-08-02 | integration | same hook posted twice | one inbox row; one event |
| IT-M1-08-03 | integration | decision hook held, answered via `HookResponseRegistry.resolve` | HTTP response body = answer; latency < 50 ms after resolve |
| IT-M1-08-04 | integration | decision hook deadline | default body sent at deadline; prompt remains open with fallback transport |
| UT-M1-08-05 | unit | Normalizer rules golden | every NormalizedEvent kind maps to expected DomainEvent(s) |
| IT-M1-08-06 | integration | unknown payload | `telemetry.unknown_payload` event + counter increments; raw stored redacted |
| IT-M1-08-07 | load | 10k posts/min for 5 min via fake agent | p95 ingest < 20 ms; inbox processed lag < 1 s |
| IT-M1-08-08 | integration | `orch fixtures record fake --scenario hello-prompt` | files written; `orch fixtures verify` passes |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-08-01 | Record Claude fixtures | 1. `orch fixtures record claude --scenario permission` 2. in the pane ask Claude to write a file, allow via API 3. stop | `fixtures/2.1.216/hooks/PreToolUse.json`, `PostToolUse.json`, … written, redacted; `RECORDED.md` updated | ⬜ |
| TC-M1-08-02 | Redaction | 1. during recording paste a fake `sk-ant-xxxx` string into the prompt | fixture files contain `[REDACTED]` not the string | ⬜ |
| TC-M1-08-03 | Unknown payload visible | 1. POST a hook with an unknown name to a live session (with the session's hook token) | `telemetry.unknown_payload` event; `GET /sessions/:id/telemetry?unknown=true` lists it | ⬜ |
| TC-M1-08-04 | Idempotent replays | 1. re-POST a stored inbox body | no duplicate events | ⬜ |
| TC-M1-08-05 | Session token isolation | 1. use session A's hook token against session B's route | 401 | ⬜ |
| TC-M1-08-06 | Verify fixtures | 1. `orch fixtures verify claude` | contract suite runs against the recorded folder; green | ⬜ |

## 7. Acceptance criteria
- [ ] Hooks receiver secure (per-session token), idempotent, redacting, with held decision responses.
- [ ] Pipeline normalises all NormalizedEvent kinds; unknowns tracked.
- [ ] Fixture recorder produces contract-test-ready folders for claude (and codex/agy once M1-06/07 land).
- [ ] Load test target met.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Hook scripts run with a short timeout inside the CLI; holding responses for a user decision must respect the CLI's max hook timeout (verify per CLI; use `deadlineMs` ≤ that) — beyond it we answer `ask/defer` and fall back.
- Recording on real accounts spends quota: keep scenarios minimal; never automate in CI.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
