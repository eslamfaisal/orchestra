# Step M9-05 — Postgres + S3 drivers

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M0-05 |
| Estimated effort | 3 days |
| Packages touched | `apps/daemon` (`src/infrastructure/persistence/{sqlite,postgres,migrations}`, `src/infrastructure/search`, `src/infrastructure/recorder/stores`, `src/interface/config`), `apps/cli` (`orch storage`), `packages/core` (ports only — `SearchPort`, `RecordingStore` unchanged), `deploy/compose` |
| Risk | High (the storage seam is under every feature built in M0–M8) |
| Owner | |

## 1. Goal
Setting `storage.driver: postgres` and `storage.recordings.driver: s3` in `config.yaml` makes the daemon run against Postgres 16 and an S3-compatible object store with no other change and no feature loss: separate versioned migration histories implement the same logical schema on each dialect, every repository contract suite passes on both, full-text search works through a `SearchPort` backed by FTS5 on SQLite and `tsvector` on Postgres, and asciicast recordings are uploaded with multipart and replayed through presigned URLs. `orch storage migrate --from sqlite --to postgres --recordings fs:s3` moves an existing single-user installation across with equal row counts per table and a still-verifiable audit chain. SQLite remains the default and the only requirement for solo use.

## 2. Why
- D8 states enterprise is "**a driver swap**". This step is where that claim is either proven or exposed; the README's exit criterion 4 (Postgres parity) is the proof.
- D9 / `03-architecture.md` §4: repositories are ports implemented in `infrastructure/`; if a dialect difference leaks into `application/` or `core/`, the architecture rule has been violated and `dependency-cruiser` should have caught it — this step is the stress test.
- M9-06 cannot ship a container with a PVC-only story: a pod restart must not lose the database, and recordings grow past any sane PVC. Postgres + S3 is the prerequisite.
- M9-03's append-only enforcement is stronger on Postgres (`REVOKE UPDATE, DELETE`) than on SQLite (triggers); activating the Postgres variant here upgrades a real security control.
- G5 ("total recall") must survive the move: history, search and replay are the features most likely to break silently on a dialect swap, so they get dedicated parity tests.
- M10 freezes the 1.0 storage contract; discovering a dialect incompatibility after that would mean a breaking migration.

## 3. Scope
### In scope
- `PostgresDialect` wiring for Kysely (`pg` pool), `storage.driver: sqlite | postgres` config switch, DI-selected `DatabaseProvider` (strategy, no `switch` outside the factory).
- Dialect-specific migration histories with explicit logical-schema mapping; shared helpers only where SQL semantics match.
- Migration **parity** test: every migration runs on both engines under Testcontainers, and the resulting schema is compared structurally.
- Repository/port contract suites (M0-05's shared spec factories) executed against Postgres, in addition to SQLite and in-memory.
- `SearchPort` Postgres implementation: `tsvector` columns + GIN indexes + `websearch_to_tsquery`, with the same `SearchQuery`/`SearchHit` contract and the same query-builder rules as M5-03.
- `S3RecordingStore` implementing M5-01's `RecordingStore`: multipart upload of closed segments, presigned GET for replay, `stat`, `remove`, `usage`; local staging while a segment is still being written.
- Audit append-only enforcement on Postgres (trigger + `REVOKE`), activating the variant staged in M9-03.
- `orch storage migrate` (SQLite → Postgres, fs → S3), `orch storage check`, `orch storage vacuum-recordings`.
- Connection pooling, statement timeouts, health/readiness signals, and a `deploy/compose/team.yaml` with Postgres 16 + MinIO.
- Backup guidance in `docs/deployment/storage.md` (pg_dump/PITR, bucket versioning, restore drill).
### Out of scope (deferred to …)
- Kubernetes packaging of Postgres/MinIO — M9-06 (this step ships docker-compose only).
- Row-level security / per-tenant isolation in Postgres — evaluated here, deferred to M10 backlog; RBAC (M9-01) stays the authorisation layer.
- MySQL or any third dialect — not planned for 1.0.
- Read replicas, sharding, or a separate analytics store — not planned for 1.0.
- Migrating *back* (Postgres → SQLite) — one-way tool only; document the `pg_dump` escape hatch.
- Encrypting columns at rest (`pgcrypto`) — M9-09 decides; this step only ensures the columns are wide enough for ciphertext.
- Object-store lifecycle rules and retention — M5-06 owns retention; this step exposes `usage()` so the sweeper works against S3.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain types. Two rules are asserted by tests rather than code:
- **Port purity:** `packages/core` and `apps/daemon/src/application` contain zero dialect-specific identifiers (`sqlite`, `pg`, `tsvector`, `MATCH`, `fts_`). Enforced by an architecture test plus `dependency-cruiser`.
- **Behavioural parity:** for every port, the same contract spec must pass on every implementation. Divergence is a bug in the adapter, never an accepted difference — except for the two documented ones below (`SearchHit.rank` scale and case/collation), which are encoded in the spec as tolerances.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/infrastructure/persistence/dialect.ts
export interface DialectHelpers {
  readonly id: 'sqlite' | 'postgres';
  jsonColumn(b: ColumnDefinitionBuilder): ColumnDefinitionBuilder;      // TEXT + json_valid CHECK | JSONB
  timestampColumn(b: ColumnDefinitionBuilder): ColumnDefinitionBuilder; // TEXT ISO-8601 on both (no timestamptz — one wire format)
  upsert<T>(qb: InsertQueryBuilder<T>, conflict: readonly string[]): InsertQueryBuilder<T>;
  partialIndex(name: string, table: string, cols: string[], whereSql: string): RawBuilder<unknown>;
  appendOnlyTrigger(table: string, flagKey: string): RawBuilder<unknown>[];   // triggers (sqlite) | trigger fn + REVOKE (pg)
  ftsSetup(spec: FtsSpec): RawBuilder<unknown>[];                             // FTS5 virtual table | tsvector column + GIN
  now(): RawBuilder<string>;
}

// apps/daemon/src/infrastructure/persistence/database.provider.ts
export interface DatabaseProvider {                    // DI strategy keyed by storage.driver
  readonly dialect: DialectHelpers;
  db(): Kysely<Database>;
  health(): Promise<Result<{ ok: boolean; latencyMs: number; poolInUse: number; poolIdle: number }, StoreError>>;
  withTx<T>(fn: (trx: Kysely<Database>) => Promise<Result<T, StoreError>>): Promise<Result<T, StoreError>>;
  close(): Promise<void>;
}

// apps/daemon/src/infrastructure/recorder/stores/s3-recording-store.ts  (implements M5-01 RecordingStore)
export interface ObjectStorePort {
  putMultipart(key: string, body: ReadableStream<Uint8Array>, o: { contentType: string; partSizeBytes: number }): Promise<Result<{ etag: string; bytes: number }, StoreError>>;
  presignGet(key: string, ttlSeconds: number, o?: { range?: ByteRange }): Promise<Result<string, StoreError>>;
  getRange(key: string, range?: ByteRange): Promise<Result<ReadableStream<Uint8Array>, StoreError>>;
  head(key: string): Promise<Result<{ bytes: number }, StoreError>>;
  delete(key: string): Promise<Result<void, StoreError>>;
  listUsage(prefix: string): Promise<Result<{ totalBytes: number; objects: number }, StoreError>>;
}
export type StoreError = {
  code: 'Unreachable' | 'AuthFailed' | 'NotFound' | 'Conflict' | 'Timeout' | 'QuotaExceeded' | 'EgressBlocked' | 'Io';
  message: string; retryable: boolean;
};

// apps/daemon/src/application/storage/ — one use case per class
export class MigrateStorage   { execute(o: MigrateSpec, actor: Actor): Promise<Result<MigrateReport, StoreError>>; }
export class CheckStorage     { execute(): Promise<Result<StorageCheck, StoreError>>; }   // used by /health/ready
export interface MigrateSpec  { from: 'sqlite'; to: 'postgres'; recordings?: 'fs:s3' | 'keep'; batchSize?: number; dryRun: boolean; resumeFrom?: string }
export interface MigrateReport { tables: Array<{ table: string; source: number; target: number; ok: boolean }>; recordings: { moved: number; bytes: number }; auditChain: 'ok' | 'broken'; durationMs: number }
```

### 4.3 Data / schema changes
- Preserve all shipped SQLite migrations and checksums. Add a separately versioned Postgres baseline with explicit mapping to the current logical schema, followed by append-only Postgres migrations. New logical schema changes provide migrations for each supported dialect. No baseline re-emit or applied-ID shim rewrites SQLite history.
- Postgres specifics introduced:
  - JSON columns become `jsonb` (Kysely maps to the same TS types); the `json_valid()` CHECK is replaced by the type itself.
  - `0092_audit_chain`'s SQLite triggers get their Postgres twin: a `BEFORE UPDATE OR DELETE` trigger function reading `current_setting('orchestra.audit_maintenance', true)` plus `REVOKE UPDATE, DELETE ON audit_log FROM orchestra_app`. The migration runs as the owner role; the daemon connects as `orchestra_app`.
  - `events` immutability (M0-05's `events_immutable` trigger) gets the same treatment.
  - `0095_postgres_fts`: for each M5-03 FTS target, a `search_docs (doc_id text pk, kind text, session_id text, mission_id text, provider_id text, ts text, body text, tsv tsvector generated always as (to_tsvector('simple', body)) stored)` table with a `GIN (tsv)` index, maintained by the same triggers that maintain `fts_*` on SQLite. `simple` (not `english`) is chosen so identifiers and paths are not stemmed, matching M5-03's `unicode61 tokenchars '_-./'` intent as closely as the dialect allows.
- Config:

| Key | Type | Default | Notes |
|---|---|---|---|
| `storage.driver` | `sqlite \| postgres` | `sqlite` | |
| `storage.postgres.url` | string (env) | — | `ORCH_PG_URL`; secrets never in `config.yaml` |
| `storage.postgres.poolMin/Max` | number | `2` / `10` | max must be ≥ `sessions.maxConcurrent` + 4 |
| `storage.postgres.statementTimeoutMs` | number | `15000` | set per connection |
| `storage.postgres.ssl` | `require \| prefer \| disable` | `require` | `disable` allowed only for loopback hosts |
| `storage.recordings.driver` | `fs \| s3` | `fs` | |
| `storage.recordings.s3` | `{ endpoint, region, bucket, prefix, accessKeyEnv, secretKeyEnv, forcePathStyle, presignTtlSeconds }` | — | MinIO needs `forcePathStyle: true` |
| `storage.recordings.s3.partSizeBytes` | number | `8388608` | 8 MB multipart parts |
| `storage.recordings.localStageDir` | string | `~/.orchestra/recordings-stage` | active segments before upload |

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Pooling:** one `pg.Pool` per daemon; `application_name=orchestrad`, `statement_timeout`, `idle_in_transaction_session_timeout: 30s`. Long streaming reads (audit export, `readSince` paging) use a dedicated connection with a cursor rather than the request pool. Pool exhaustion surfaces as `StoreError{code:'Timeout', retryable:true}` and a `status-blocked` Health card, never as an unhandled rejection.
- **Transactions:** `withTx` is the only transaction entry point; `READ COMMITTED` on both engines. SQLite keeps WAL + `busy_timeout: 5000`. The M9-03 audit `seq` assignment uses `SELECT max(seq) … FOR UPDATE`-equivalent semantics: on Postgres an advisory lock (`pg_advisory_xact_lock(hashtext('audit_seq'))`), on SQLite the write lock is already exclusive.
- **Recordings:** the recorder (M5-01) always writes the *active* segment to `localStageDir` — an in-flight asciicast stream cannot be a multipart upload without buffering the whole thing, and a crash mid-upload would lose the tail. On segment close (`rotated`/`closed`) an `UploadRecordingSegment` job multipart-uploads it under `<prefix>/<sessionId>/<segment>.cast`, verifies `head()` bytes against the local size, records `recordings.sha256`, then deletes the local file. Failed uploads retry with backoff and leave the local file in place; `usage()` reports staged + uploaded bytes so M5-01's budgets still hold.
- **Replay:** `GET /recordings/:id/cast` returns a 302 to a presigned URL (default TTL 300 s) when the driver is `s3` and the client is a browser; `Range` is forwarded in the presign. `orch replay` and any non-browser client get a streamed proxy through `getRange` instead, so a CLI never needs bucket credentials.
- **Egress:** S3 and Postgres hosts are registered in the `infrastructure/egress` allowlist from config at boot (same module as M9-02/M9-03). The boot assertion that no configured host matches a vendor domain applies here too (C2).
- **Testcontainers:** `postgres:16-alpine` and `minio/minio` for integration and parity suites. CI runs them on Linux; the dev machine runs them under Docker Desktop. No real cloud credentials in CI (C9).
- No tmux or git changes; worktrees stay on the local filesystem (they must — `git worktree` needs a real FS; this is called out for M9-06's PVC sizing).

### 4.5 API / UI surface
- `GET /health` gains `storage: { driver, ok, latencyMs, poolInUse, poolIdle }` and `recordings: { driver, ok, pendingUploads }`. `GET /health/ready` (added properly in M9-06) fails when the DB is unreachable or migrations are pending.
- Settings → About/Storage (read-only panel): driver, server version, schema version, pool stats, recordings driver + pending uploads + total bytes. No credentials are ever rendered.
- Health screen (M6-07) gains a "Storage" card with the same data and a "Run storage check" action.
- CLI:
  - `orch storage check` → prints driver, connectivity, schema version, pending migrations, recordings driver, pending uploads; exit 0/5.
  - `orch storage migrate --from sqlite --to postgres [--recordings fs:s3] [--dry-run] [--batch-size N] [--resume]` → per-table progress bars, final table of row counts, `audit chain: ok|broken`, exit 0/6.
  - `orch storage vacuum-recordings` → removes staged files whose upload is confirmed and reports orphans in the bucket.
- No new permissions are introduced; storage routes require `user.manage` (Admin) except `/health`.

### 4.6 Flow / sequence
```
boot: config.storage.driver → DatabaseProvider strategy → migrations.runAll(dialect)
      pending migrations? ⇒ run (single-instance lock, M0-04) ⇒ else assert schema version
      health/ready green only after migrations + a successful SELECT 1

orch storage migrate (dry-run first)
  1 open source (sqlite, read-only) and target (postgres); assert target schema == source schema version
  2 for each table in topological order (hosts → providers → sessions → … → events → audit_log):
       stream rows in batches of N by primary key
       transform JSON columns (TEXT → jsonb), keep ids and timestamps byte-identical
       insert with upsert-on-conflict-do-nothing (idempotent ⇒ --resume is safe)
       count source vs target ⇒ mismatch aborts with the table name
  3 audit_log last, in seq order, with the maintenance flag OFF (inserts are legal; updates are not)
  4 verifyChain on the target ⇒ must be ok
  5 recordings fs:s3 ⇒ for each non-purged recording: multipart upload, head() size check, sha256, update row
  6 write MigrateReport; emit audit 'storage.migrated'

session recording lifecycle with s3
  orch-rec writes localStageDir/<sid>/<seg>.cast  → rotate/close
  → UploadRecordingSegment: putMultipart → head() bytes match? → save sha256 → unlink local
  → failure: retry (1s,2s,4s…5m); after 15 min raise Attention 'platform.recording_upload_stuck'
  replay: GET /recordings/:id/cast → browser ⇒ 302 presignGet(ttl 300s, Range)
                                   → CLI/proxy ⇒ stream getRange
```

### 4.7 Review reconciliation contract (2026-09-15)
Repository contracts run on both clean databases and upgrades from the previous supported version. Migration transfer compares counts plus stable row/content hashes and verifies audit chains. Search contracts cover filtering, required relevant hits, pagination and documented tokenization; ranking may differ and scores are not cross-engine comparable. Test duplicate ingestion and concurrent claims under both transaction models. A driver configuration switch alone never constitutes a successful migration.

## 5. Tasks
- [ ] Write ADR-016 with separate dialect histories, logical version mapping, backup/restore and migration rollback boundaries; reconcile DECISIONS before implementation.
- [ ] `DialectHelpers` interface + `SqliteDialectHelpers` + `PostgresDialectHelpers`; refactor migrations `0001`…`0093` to use them; keep the SQLite-applied-list shim.
- [ ] `DatabaseProvider` strategy (`SqliteDatabaseProvider`, `PostgresDatabaseProvider`) with pool config, `withTx`, `health`, graceful `close`; DI registration keyed by `storage.driver`.
- [ ] Migration parity test harness: run the full list on SQLite and on Postgres (Testcontainers), then compare normalised schemas (tables, columns, nullability, indices, triggers) and assert the documented deltas only.
- [ ] Run every existing repository/port contract spec (M0-05 factories, plus prompt/mission/review/recording/audit/gate repos) against Postgres in CI.
- [ ] Postgres audit + events immutability (trigger function, `REVOKE`, `orchestra_app` role) and the advisory-lock `seq` assignment; re-run M9-03's IT-M9-03-01 on Postgres.
- [ ] `0095_postgres_fts`: `search_docs` + `tsvector` + GIN; `PostgresSearch` implementing `SearchPort`; shared search contract spec (same queries, same deep links) run on both engines.
- [ ] `ObjectStorePort` + `S3ObjectStore` (AWS SDK v3 client through the egress module) + `S3RecordingStore` implementing M5-01's `RecordingStore`; staging dir, `UploadRecordingSegment` job with retry and Attention item.
- [ ] Presigned replay path (302 for browsers, proxy stream for CLI), `Range` support, TTL config; asciinema-player verified against a presigned URL.
- [ ] `MigrateStorage` use case + `orch storage migrate` (batching, resume, dry-run, per-table counts, audit-chain verification) and `orch storage check`, `orch storage vacuum-recordings`.
- [ ] Config schema additions + boot assertions (ssl, pool sizing vs `sessions.maxConcurrent`, non-vendor hosts, `forcePathStyle` hint for MinIO).
- [ ] `deploy/compose/team.yaml`: Postgres 16, MinIO (+ bucket bootstrap), shared with M9-02's Dex service.
- [ ] Health/Settings storage panels; Health "Storage" card.
- [ ] Load check: 10 000 events + 200 messages/min on Postgres; compare p95 ingest and search latency with SQLite and record both in the log.
- [ ] Docs `docs/deployment/storage.md`: sizing, pooling, `pg_dump`/PITR backup and a restore drill, bucket policy (private, versioned), migration runbook, known dialect deltas.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-05-01 | unit | `DialectHelpers.upsert`/`partialIndex`/`jsonColumn` emit valid SQL per dialect (snapshot) | snapshots stable; no raw dialect SQL outside the helpers (grep test) |
| UT-M9-05-02 | unit | `MigrateSpec` validation and table ordering (topological, audit last) | invalid specs rejected; order deterministic |
| AT-M9-05-01 | application | `MigrateStorage` dry-run on a seeded DB | zero writes to the target, report lists per-table source counts |
| AT-M9-05-02 | application | `MigrateStorage` interrupted after table 5 and resumed | resume inserts no duplicates (conflict-do-nothing), final counts equal |
| IT-M9-05-01 | integration | migration parity: full list on SQLite and Postgres (Testcontainers), normalised schema diff | only the documented deltas (jsonb, tsvector, trigger syntax) |
| IT-M9-05-02 | integration | every repository contract spec against Postgres | identical behaviour to SQLite and in-memory |
| IT-M9-05-03 | integration | `SearchPort` contract on both engines with the same corpus (identifiers, paths, Arabic text, `-term`, `"phrase"`, `prefix*`) | same hit sets and deep links; rank order equal for the top 10 |
| IT-M9-05-04 | integration | audit immutability on Postgres: `UPDATE`/`DELETE` as `orchestra_app` | both refused (privilege + trigger); `orch audit verify` still ok |
| IT-M9-05-05 | integration | `S3RecordingStore` against MinIO: 120 MB recording multipart upload, `head` size check, presigned `Range` GET | bytes match, sha256 matches, ranged replay returns the right slice |
| IT-M9-05-06 | integration | recordings upload with MinIO stopped for 60 s mid-run | segment stays staged, retries, uploads after recovery, no data loss, Attention item raised and cleared |
| E2E-M9-05-01 | e2e | Playwright against Postgres + MinIO with FakeProvider: start session, answer a prompt, search history, replay the recording | all green; replay loads through a presigned URL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-05-01 | Migrate a real installation | 1. Use your M8 SQLite DB (copy it first). 2. `docker compose -f deploy/compose/team.yaml up -d postgres minio`. 3. `orch storage migrate --from sqlite --to postgres --recordings fs:s3 --dry-run` then for real. 4. Switch config to postgres+s3 and start the daemon. | Per-table counts are equal for every table; final line prints `audit chain: ok`; the daemon boots with no pending migrations; History, Timeline and Replay show the pre-migration sessions with working recordings. | ⬜ |
| TC-M9-05-02 | Search parity by hand | 1. On SQLite, search History for an identifier (`SessionSupervisor`), a path (`src/infrastructure/tmux/driver.ts`), an Arabic phrase, `-excluded`, and `"exact phrase"`. Record the top 10 for each. 2. Repeat on Postgres with the migrated DB. | The same documents appear in the top 10 for each query, with the same deep links; any difference is written into the step log as a documented delta, not silently accepted. | ⬜ |
| TC-M9-05-03 | Negative: tampering and privileges on Postgres | 1. `psql $ORCH_PG_URL -c "update audit_log set action='x' where seq=5"` as `orchestra_app`. 2. Same for `delete from events where id=(select id from events limit 1)`. 3. `orch audit verify`. | Both statements fail on privileges (and would fail on the trigger); `orch audit verify` reports `ok`; the attempts appear in the Postgres log for the reviewer. | ⬜ |
| TC-M9-05-04 | Negative: bad credentials / unreachable store | 1. Point `storage.recordings.s3.accessKeyEnv` at a wrong key and start a session. 2. Set `storage.postgres.url` to a wrong password and restart the daemon. | (1) the session still records locally, the upload retries, Attention shows `platform.recording_upload_stuck`, nothing is lost; (2) the daemon exits non-zero at boot with a clear `AuthFailed` message and no partially-migrated schema. | ⬜ |
| TC-M9-05-05 | Resilience: database failover mid-session | 1. Run a FakeProvider session with an open prompt on Postgres. 2. `docker restart` the Postgres container (or `pg_ctl restart`). 3. Watch the UI and the daemon logs for 2 minutes. 4. Answer the prompt after recovery. | In-flight queries fail with a retryable `StoreError`; the daemon does **not** exit; `/health` reports `storage.ok: false` then recovers within 30 s; the pane keeps running (tmux is independent of the DB); after recovery the prompt is still open and answering works; no duplicate events (idempotent ingestion held). | ⬜ |
| TC-M9-05-06 | Pool exhaustion under load | 1. Set `poolMax: 4`. 2. Start 10 concurrent FakeProvider sessions and a history search loop. | Requests queue and complete (or fail with a readable `Timeout`), the daemon stays responsive, Health shows `poolInUse == poolMax`, and the boot assertion warns that `poolMax` is below `sessions.maxConcurrent + 4`. | ⬜ |
| TC-M9-05-07 | Backup and restore drill | 1. `pg_dump -Fc` the database and note the bucket contents. 2. Drop the database and the bucket prefix. 3. Restore the dump, re-point the bucket. 4. `orch storage check` and `orch audit verify`; open a replay. | Restore completes with no manual schema fixes; storage check reports the same schema version; the audit chain verifies; the replay plays. Write the wall-clock time of the drill in the step log. | ⬜ |
| TC-M9-05-08 | SQLite is untouched | 1. Set `storage.driver: sqlite`, `recordings.driver: fs`. 2. Run the full M0–M8 E2E suite and the M5 replay demo. | Everything behaves as before the step; no Docker required; `orch storage check` reports `sqlite` with zero pending migrations. | ⬜ |

### 6.3 Review regression scenarios
- [ ] Shipped SQLite migration hashes remain unchanged.
- [ ] Upgrade and clean install converge to matching logical schema.
- [ ] Concurrent event ingestion and claims preserve uniqueness on both stores.
- [ ] Search relevant-hit coverage passes without identical rank ordering.
- [ ] Backup restoration verifies content hashes and audit integrity.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] `ADR-016-dialect-parity-baseline` merged and linked from `DECISIONS.md` before implementation.
- [ ] The same migration list runs on SQLite and Postgres; the parity test's schema diff shows only the documented deltas.
- [ ] Every repository and port contract spec passes on SQLite, in-memory **and** Postgres in CI (IT-M9-05-02).
- [ ] `SearchPort` returns equivalent results on both engines for the M5-03 query grammar, including identifiers, paths and Arabic text (IT-M9-05-03, TC-M9-05-02).
- [ ] Recordings upload to S3 with multipart, verify their size and sha256, replay through presigned ranged GETs, and never lose a segment when the store is briefly unavailable (IT-M9-05-05/06).
- [ ] Audit and event immutability are enforced on Postgres by privileges *and* triggers (IT-M9-05-04, TC-M9-05-03).
- [ ] `orch storage migrate` moves a real installation with equal per-table row counts, a verifiable audit chain, and a safe `--resume` (TC-M9-05-01).
- [ ] The daemon survives a database restart without exiting and without losing prompts (TC-M9-05-05).
- [ ] `storage.driver: sqlite` behaviour is unchanged: all M0–M8 suites green with no Docker (TC-M9-05-08).
- [ ] All TC-M9-05-* pass and are recorded; no new lint/arch violations; `docs/deployment/storage.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Dialect drift:** verify schema, uniqueness, JSON semantics, generated columns, FTS, transaction isolation and concurrent repository behavior on clean and upgraded databases. Separate histories increase maintenance but preserve deployed migration integrity.
- Search parity is *approximate*, not exact: FTS5 `bm25` and Postgres `ts_rank_cd` produce different scores, and `simple` vs `unicode61` tokenise identifiers slightly differently (underscores, dots). The contract spec must assert set equality and top-10 order, not exact ranks, and the deltas must be documented.
- Arabic search on Postgres with the `simple` configuration does no stemming; SQLite's `remove_diacritics 2` does normalise. This may make Arabic recall differ visibly (verify with TC-M9-05-02 and, if it matters, evaluate `unaccent` + a custom configuration).
- ISO-8601 `text` timestamps on Postgres (chosen for wire compatibility) forgo `timestamptz` indexing benefits and sorting correctness for mixed offsets. All writes are UTC ISO-8601 by convention (`04-domain-model.md`), so lexicographic order is correct — but this should be stated explicitly in the docs and asserted by a test (verify).
- Presigned URLs leak a time-limited capability to anyone who obtains the link, which sidesteps RBAC for the TTL window. 300 s plus `Content-Disposition` is the proposed mitigation; a stricter option is to always proxy. Decide with M9-09's threat model.
- `git worktree` cannot live on S3; worktrees remain local, which constrains M9-06's PVC sizing and means a pod restart still loses uncommitted worktree state. Flagged for M9-06.
- MinIO is not S3: multipart edge cases, `forcePathStyle`, and presign signature versions differ. Test against at least one real S3-compatible service (AWS S3 or R2) by hand before marking done (verify).
- `deploy/` is not in `11-repo-layout.md` (already flagged in the milestone README); this step creates `deploy/compose/`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
