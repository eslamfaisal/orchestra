# Step M0-05 — Event store & repositories

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-04 |
| Estimated effort | 1.5 days |
| Packages touched | `apps/daemon` (infrastructure/persistence, application), `packages/core` (ports only if gaps found) |
| Risk | Medium |
| Owner | |

## 1. Goal
The daemon has an append-only `EventStore` (SQLite) with idempotent ingestion, an in-process `EventBus` that fans events out to subscribers (WS gateway in M0-06, projections later), and Kysely repositories for `Session`, `Task`, `Mission`, `AgentPrompt`, `Host`, `Provider` implementing the core ports — each with an in-memory twin used by application tests. A `RecordEvent` use case is the single write path for domain events.

## 2. Why
G5 (total recall starts with an append-only log), `03-architecture.md` §6 (idempotent ingestion), D8 (repos are the seam for the Postgres swap), `10-testing-strategy.md` (application tests use in-memory repos).

## 3. Scope
### In scope
- `SqliteEventStore` (append, readSince(cursor), byCorrelation, count) with the four-part idempotency key from `04-domain-model.md` §3: unique index on **`(source_provider_id, source_provider_session_id, source_channel, source_external_id)`** where `source_external_id` is not null. A vendor `externalId` is only unique inside one provider session — two Claude sessions can both emit `msg_1` — so `(channel, externalId)` alone would silently drop a real event.
- `source_seq`: a monotonic per-source cursor (JSONL line number, stream sequence, RPC notification counter) stored when the source exposes one. It is used for **ordering and gap detection within one source**, never for identity and never as the paging cursor.
- `InProcessEventBus` (sync publish, topic filters by `type` prefix and correlation ids, backpressure-safe: subscribers are invoked outside the DB transaction).
- Repositories (Kysely + InMemory): `SessionRepository`, `TaskRepository`, `MissionRepository`, `PromptRepository`, `HostRepository`, `ProviderRepository`.
- Application: `RecordEvent` use case (validate payload by `eventSchema`, append, publish), `Projector` base (rebuild read models from events — used by M5-05 restore).
- Transaction helper `withTx()`.
### Out of scope (deferred)
- FTS (M5-03), retention/purge (M5-06), Postgres (M9-05), raw hook inbox table (M5-05 — but leave `events.source_json` rich enough).

## 4. Design
### 4.1 Domain
`DomainEvent` from core.

Two different sequences, deliberately kept apart:
- **`readSince(cursor)` cursor = the store's own `events.id`** (ULID, time-ordered, assigned by us on append). It is global across providers and monotonic in insertion order, which is what paging and WS catch-up need.
- **`source.sourceSeq` = the *source's* sequence**, assigned by the vendor stream. It is per-source, may restart at 0 for a new session, may have gaps, and may arrive out of order relative to other sources. Never page by it, never compare it across sources, never treat it as identity. Its only jobs are ordering one source's events and detecting that we missed something (M1-08 / M5-05 replay).
### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/events/record-event.usecase.ts
@Injectable() export class RecordEvent {
  constructor(@Inject(EVENT_STORE) private store: EventStore, @Inject(EVENT_BUS) private bus: EventBus, private clock: Clock, private ids: IdGenerator) {}
  async execute(input: Omit<DomainEvent,'id'|'ts'>): Promise<Result<DomainEvent, DomainError>> {
    const parsed = eventSchema[input.type]?.safeParse(input.payload); if (!parsed?.success) return err({code:'VALIDATION', …});
    const event = { ...input, id: this.ids.next(), ts: this.clock.now() };
    const r = await this.store.append(event); if (r.isErr()) return r;   // duplicate on the 4-part key ⇒ ok(existing), not published again
    this.bus.publish(event); return ok(event);
  }
}
// infrastructure/persistence/sqlite/event-store.sqlite.ts — table `events` per 04-domain-model.md
// infrastructure/persistence/memory/*.memory.ts — Map-backed twins, same tests run against both (shared spec factory)
```
### 4.3 Data / schema changes
Migration `0002_events_idempotency.ts`, all columns extracted from `source_json` as generated columns:
- `source_provider_id`, `source_provider_session_id`, `source_channel`, `source_external_id`, `source_seq`.
- Unique partial index `events(source_provider_id, source_provider_session_id, source_channel, source_external_id) WHERE source_external_id IS NOT NULL`.
- Non-unique index `events(source_provider_id, source_provider_session_id, source_seq)` for per-source ordering and gap detection.

SQLite treats `NULL`s as distinct in a unique index, so a row missing `provider_id` or `provider_session_id` is never deduplicated against anything. That is the intended semantics: a missing key part means *"we cannot tell whether this is a duplicate"*, and appending twice is strictly safer than dropping a real event. `RecordEvent` logs a `telemetry.unknown_payload`-adjacent warning when a payload carries an `externalId` but no provider session id, so incomplete adapter plumbing is visible rather than silent.
### 4.4 Infrastructure
Kysely `Database` type generated from the migration (`kysely-codegen` or hand-maintained `db-types.ts`).
### 4.5 API / UI surface
None (M0-06 exposes `GET /api/events`).
### 4.6 Flow
`use case → RecordEvent → store.append (tx) → bus.publish → subscribers (WS, projections)`. Publish happens after commit.

## 5. Tasks
- [ ] `db-types.ts` for all baseline tables; helper `jsonCol<T>()` with Zod parse on read.
- [ ] `SqliteEventStore` + migration `0002`; `InMemoryEventStore`.
- [ ] Shared spec factory `eventStoreContract(makeStore)` run against both.
- [ ] `InProcessEventBus` with filters + unsubscribe + error isolation (a throwing subscriber cannot break publish).
- [ ] Repositories (6) Kysely + InMemory + shared contract specs.
- [ ] `RecordEvent` use case with validation + idempotency on the four-part key (`provider_id, provider_session_id, channel, external_id`); `Projector` base class.
- [ ] DI tokens (`EVENT_STORE`, `EVENT_BUS`, `*_REPOSITORY`) in `PersistenceModule`; `TestingModule` helper wiring the in-memory set.
- [ ] Seed script `orch dev seed` inserting a host + fake provider row.
- [ ] Docs: "how to add an event / a repository".

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-05-01 | unit | `RecordEvent` with invalid payload | `VALIDATION` error, nothing appended |
| UT-M0-05-02 | unit | `RecordEvent` twice with the same `(providerId, providerSessionId, channel, externalId)` | second returns ok(existing), store count 1, bus published once |
| UT-M0-05-07 | unit | **two provider sessions reuse the same `externalId`**: same `providerId` + `channel` + `externalId`, different `providerSessionId` | **both rows kept** (count 2), both published — the regression test for the old `(channel, externalId)` key |
| UT-M0-05-08 | unit | same `externalId` + same session id from **different providers** | both rows kept |
| UT-M0-05-09 | unit | event with an `externalId` but no `providerSessionId`, appended twice | both rows kept (NULL never matches), warning logged naming the adapter and channel |
| UT-M0-05-10 | unit | `readSince(cursor)` over events whose `source_seq` values overlap and go backwards across two sources | paging is by store `id` only and is exact; `source_seq` does not affect order |
| IT-M0-05-03 | integration | event store contract (sqlite + memory) | append/readSince/byCorrelation identical behaviour |
| IT-M0-05-04 | integration | repositories contract (sqlite + memory) | CRUD + query parity |
| UT-M0-05-05 | unit | bus subscriber throws | other subscribers still receive; error logged |
| IT-M0-05-06 | integration | 10k events append + readSince paging | < 2 s, cursor paging exact, ordered by id |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-05-01 | Append-only | 1. `sqlite3 ~/.orchestra/orchestra.db "UPDATE events SET type='x'"` | fails: trigger `events_immutable` raises | ⬜ |
| TC-M0-05-02 | Idempotency is per provider session | 1. `orch dev emit --provider claude --session s1 --external-id abc` twice 2. `orch dev emit --provider claude --session s2 --external-id abc` 3. `orch dev events --since 0` | after 1: one row; after 2: a **second** row (different session) — total 2, both visible | ⬜ |
| TC-M0-05-03 | Restart persistence | 1. emit 5 events 2. restart daemon 3. `orch dev events --since 0` | 5 events listed, same ids | ⬜ |
| TC-M0-05-04 | Seed | 1. `orch dev seed` twice | host + provider rows exist once (upsert) | ⬜ |
| TC-M0-05-05 | Bad JSON in DB | 1. insert a row with invalid `payload_json` via sqlite3 2. read via API | read returns a `VALIDATION` error for that row, others unaffected, no crash | ⬜ |

## 7. Acceptance criteria
- [ ] Event store append-only (trigger-enforced), idempotent on `(provider_id, provider_session_id, channel, external_id)`, cursor paging by the store's own `id`.
- [ ] Two provider sessions reusing one vendor external id keep both rows (UT-M0-05-07 / TC-M0-05-02).
- [ ] Six repositories with SQLite + in-memory implementations passing the same contract specs.
- [ ] `RecordEvent` is the only write path for events (grep proves no other `INSERT INTO events`).
- [ ] Bus isolates subscriber failures.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Generated columns on SQLite need 3.31+ (macOS ships newer; Docker image must too).
- Event payload size: cap at 256 KB, larger goes to `attachments` (rule enforced in `RecordEvent`).
- Adapters that cannot supply a `providerSessionId` early in a session (before the vendor assigns one) will emit un-deduplicatable events for those first few payloads. Acceptable for M0; M1-08 must set the session id as soon as it is known and backfill is explicitly **not** attempted (the event log is append-only).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
