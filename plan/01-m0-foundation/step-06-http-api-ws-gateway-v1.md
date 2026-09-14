# Step M0-06 — HTTP API + WS gateway v1

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-05 |
| Estimated effort | 2 days |
| Packages touched | `apps/daemon` (interface/http, interface/ws, application), `packages/sdk` (API DTO types shared with web) |
| Risk | Medium |
| Owner | |

## 1. Goal
The daemon exposes a versioned REST API (`/api/v1`) for hosts, providers, sessions, prompts and events, an OpenAPI document, and a `/ws` JSON WebSocket that clients subscribe to by topic and that delivers a snapshot followed by deltas. A `FakeProvider` session can be created, observed and its prompt answered entirely through this API — the vertical slice the web shell (M0-07) and every later screen build on.

## 2. Why
D1 (one API for three surfaces), `03-architecture.md` §5 (channels), G1 (see and control every agent), C10 (all mutations go through guarded, audited routes).

## 3. Scope
### In scope
- REST (Fastify via Nest controllers) with Zod-validated DTOs: `GET /hosts/me`, `GET /providers`, `GET/POST /sessions`, `POST /sessions/:id/stop`, `GET /prompts?state=open`, `POST /prompts/:id/answer`, `GET /events?since=&types=&sessionId=`, `GET /openapi.json`.
- Use cases: `StartSession` (FakeProvider only in M0; adapter resolved via DI registry), `StopSession`, `ListSessions`, `AnswerPrompt` (M0 version: marks answered + forwards to adapter), `ListEvents`.
- Minimal `ProviderRegistry` (DI map `ProviderId → ProviderAdapter`) with `fake` registered; real ones register in M1.
- Minimal `SessionRunner` for M0: launches the fake agent via `ProcessRunner` (not tmux yet), pipes its telemetry through `TelemetryParser` → `RecordEvent`. Replaced by the tmux `SessionSupervisor` in M1-02 behind the same `SessionRunnerPort`.
- `/ws` gateway: auth via `?token=` or first message; `subscribe {topics:[…]}` → `snapshot` then `event` frames; topics: `sessions`, `prompts`, `events:<sessionId>`, `fleet`; heartbeat/ping; reconnect gets snapshot again; max frame size; per-connection backpressure (drop `agent.output` deltas first).
- Shared DTO types in `packages/sdk/src/api/` (consumed by web + CLI).
- Error envelope `{error:{code, message, details?}}` mapping `DomainError.code` → HTTP status.
### Out of scope (deferred)
- Raw terminal WS `/term` → M1-09. tmux → M1-02. Real providers → M1-05..07. Tasks/missions routes → M2/M3. RBAC → M9-01.

## 4. Design
### 4.1 Domain
Uses core `Session`, `AgentPrompt`, `DomainEvent`. Adds application port:
```ts
export interface SessionRunnerPort { start(session: Session, plan: LaunchPlan): Promise<Result<void, DomainError>>; stop(sessionId: string, opts?: {force?: boolean}): Promise<Result<void, DomainError>>; }
```
### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/api/dto.ts (Zod + inferred types)
export const StartSessionDto = z.object({ provider: z.string(), model: z.string().optional(), repoPath: z.string().optional(),
  scenario: z.string().optional() /* fake only */, headless: z.boolean().default(false) });
export const AnswerPromptDto = z.object({ option: z.string().optional(), text: z.string().optional(), payload: z.unknown().optional() });
export const WsClientMessage = z.discriminatedUnion('type', [ z.object({ type: z.literal('auth'), token: z.string() }),
  z.object({ type: z.literal('subscribe'), topics: z.array(z.string()) }), z.object({ type: z.literal('unsubscribe'), topics: z.array(z.string()) }), z.object({ type: z.literal('ping') }) ]);
export const WsServerMessage = z.discriminatedUnion('type', [ z.object({ type: z.literal('snapshot'), topic: z.string(), data: z.unknown(), cursor: z.string() }),
  z.object({ type: z.literal('event'), topic: z.string(), event: DomainEventSchema }), z.object({ type: z.literal('error'), code: z.string(), message: z.string() }), z.object({ type: z.literal('pong') }) ]);
```
Error mapping: `VALIDATION`→400, `FORBIDDEN`→403, `*_NOT_FOUND`→404, `INVALID_TRANSITION`→409, `CONCURRENCY_LIMIT`/`QUOTA_EXHAUSTED`→429, `PROVIDER_UNAVAILABLE`→503, else 500.
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
`InProcessEventBus` subscriber in the gateway fans events to topic subscribers. Snapshot builders read repositories.
### 4.5 API / UI surface
As listed in scope. OpenAPI generated from Zod (`zod-to-openapi`) and served at `/api/v1/openapi.json`; Swagger UI at `/api/docs` in dev only.
### 4.6 Flow
```
POST /sessions {provider:'fake', scenario:'hello-prompt'}
 → StartSession: Session(requested) → adapter.launcher.interactive() → runner.start() → RecordEvent(session.launched)
 → fake agent POSTs hook → /hooks/fake/:sid (M0 stub inside SessionRunner) → parser → NormalizedEvent(prompt_opened) → PromptRepository.save(open) → RecordEvent(prompt.opened) → bus → ws 'prompts' subscribers
POST /prompts/:id/answer → AnswerPrompt → adapter.pane.answerPrompt (hook-response) → RecordEvent(prompt.answered) → agent continues → exit → session.stopped
```

## 5. Tasks
- [ ] `packages/sdk/src/api/` DTOs + `DomainEventSchema` re-export; publish types for web.
- [ ] `ProviderRegistry` (DI token + `register()`), `SessionRunnerPort`, `ProcessSessionRunner` (M0 only, uses `ProcessRunner` from M0-03).
- [ ] Use cases: `StartSession`, `StopSession`, `ListSessions`, `AnswerPrompt`, `ListEvents` with application tests (in-memory repos + FakeProvider).
- [ ] Controllers: hosts, providers, sessions, prompts, events; Zod validation pipe; error filter with the mapping above.
- [ ] Hook stub endpoint `POST /hooks/:provider/:sessionId` (idempotent by `externalId`) feeding the parser — formalised in M1-08.
- [ ] OpenAPI generation + `/api/docs` (dev).
- [ ] `WsGateway`: auth, subscribe/unsubscribe, snapshot builders per topic, delta fan-out, ping/pong, backpressure policy, max 1 MB frame, connection limits.
- [ ] Rate limit auth failures (5/min/IP) to keep the local token safe from brute force.
- [ ] Integration tests with supertest + `ws` client: full vertical slice with `hello-prompt`.
- [ ] `orch dev emit` script (debug) to push synthetic events.
- [ ] API docs page in `apps/daemon/README.md` with curl examples.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| AT-M0-06-01 | application | `StartSession` with unknown provider | `PROVIDER_UNAVAILABLE` → 503 |
| AT-M0-06-02 | application | `AnswerPrompt` twice | second → `INVALID_TRANSITION` 409; one `prompt.answered` event |
| IT-M0-06-03 | integration | REST vertical slice with FakeProvider `hello-prompt` | 201 session; prompt appears; answer → session stopped exit 0 |
| IT-M0-06-04 | integration | WS subscribe `sessions` then start session | receives `snapshot` then `event session.requested`, `session.launched` in order |
| IT-M0-06-05 | integration | WS without auth | `error AUTH_REQUIRED` then close 4401 |
| IT-M0-06-06 | integration | WS reconnect mid-session | new snapshot reflects current state; no duplicate events after cursor |
| IT-M0-06-07 | integration | 1000 `agent.output` events burst to a slow client | connection survives; output deltas coalesced/dropped per policy; prompt events never dropped |
| UT-M0-06-08 | unit | OpenAPI document validates | `swagger-parser` validate passes |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-06-01 | Vertical slice via curl | 1. start daemon 2. `POST /api/v1/sessions` fake `hello-prompt` 3. `GET /api/v1/prompts?state=open` 4. `POST /api/v1/prompts/<id>/answer {"option":"yes"}` 5. `GET /api/v1/sessions/<id>` | prompt listed with options; after answer session state `stopped`, `exitCode 0` | ⬜ |
| TC-M0-06-02 | WS with websocat | 1. `websocat "ws://127.0.0.1:4300/ws?token=…"` 2. send `{"type":"subscribe","topics":["sessions","prompts"]}` 3. start a session in another terminal | snapshot frames then live events; `ping`→`pong` | ⬜ |
| TC-M0-06-03 | Validation errors | 1. `POST /sessions` with `{"provider": 5}` | 400 with `error.details` listing Zod path `provider` | ⬜ |
| TC-M0-06-04 | Audit trail | 1. after TC-01 run `sqlite3 … "select action,target from audit_log"` | rows for `POST /sessions` and `POST /prompts/:id/answer` | ⬜ |
| TC-M0-06-05 | Swagger | 1. open `/api/docs` in dev | all routes documented with schemas; try-it works with token | ⬜ |
| TC-M0-06-06 | Auth brute-force limit | 1. 10 rapid requests with wrong token | after 5, responses are 429 for a minute | ⬜ |

## 7. Acceptance criteria
- [ ] REST routes listed in scope implemented with Zod DTOs shared via sdk.
- [ ] WS topics with snapshot+delta, auth, heartbeat, backpressure policy documented and tested.
- [ ] Vertical slice (`hello-prompt`) passes via REST and WS in CI.
- [ ] OpenAPI valid and served.
- [ ] Error envelope and status mapping consistent (test table).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Snapshot size for `events:<sessionId>` can grow; cap at last 500 events + cursor for paging.
- Keep the M0 `ProcessSessionRunner` deliberately tiny; it exists only so the API is testable before tmux.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
