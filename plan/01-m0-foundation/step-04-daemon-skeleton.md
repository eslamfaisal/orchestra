# Step M0-04 — Daemon skeleton

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-02 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/daemon` |
| Risk | Medium |
| Owner | |

## 1. Goal
`orchestrad` boots as a NestJS (Fastify) process: loads and validates config with Zod, opens/creates `~/.orchestra/orchestra.db` with Kysely migrations, exposes `GET /health`, authenticates every other route with a local bearer token it generates on first run, logs structured JSON via pino with secret redaction, records every mutating call through an audit interceptor, and shuts down cleanly on SIGTERM. Module layout follows Clean Architecture so every later plane is "add a module".

## 2. Why
D1 (headless daemon), D8 (SQLite local-first, driver swap later), D9 (NestJS DI/guards/interceptors), C3/C13 (redaction from the first log line), C10 (audit interceptor exists before any spend/keys action does).

## 3. Scope
### In scope
- Nest app factory with Fastify adapter; `ConfigModule` (Zod schema, sources: defaults ← `~/.orchestra/config.yaml` ← env `ORCH_*` ← CLI flags).
- `StorageModule`: Kysely + better-sqlite3, WAL, `migrations/` with the v1 tables from `04-domain-model.md` §4 (all of them, even those unused until later — one schema baseline; JSON columns as TEXT), migration runner at boot, `orch db migrate/status` scripts.
- `LoggingModule`: pino, pretty in dev, redaction paths, correlation-id middleware (`x-request-id`), child loggers per module.
- `AuthModule` v1: local token strategy (file `~/.orchestra/token`, 0600, generated once), `AuthGuard` global except `/health` and static web.
- `AuditModule`: interceptor on mutating routes → `audit_log` rows (actor, action, target, redacted before/after).
- `HealthModule`: `/health` → `{status, version, dbOk, uptime, hostId}`.
- `HostModule`: registers this host row on boot (`hosts` table).
- `--data-dir` flag / `ORCH_DATA_DIR` env resolving the data directory once at boot; every path (`db`, `token`, `daemon.lock`, `endpoint.json`, `logs/`) derives from it.
- Graceful shutdown hooks; PID file.
- **One daemon owner per data directory** (ADR-020) — the supervisor model only holds if exactly one process owns a data directory's database, tmux namespace and session resources:
  - `<data-dir>/daemon.lock` (default `~/.orchestra/daemon.lock`, mode 0600) holding `{pid, daemonVersion, endpoint, startedAt, hostId}` as JSON, held under an **advisory `flock`** for the process lifetime. The file content is informational; the `flock` is the actual mutex, so a `SIGKILL`ed daemon releases ownership automatically.
  - **Stale-lock detection**: if the `flock` is free but the file exists, the lock is stale — log the recorded pid/version, overwrite it, continue. If the `flock` is held, read the file and refuse to start.
  - **Endpoint discovery**: `<data-dir>/endpoint.json` (`{url, daemonVersion, pid, writtenAt}`) written after `listen()` succeeds and removed on clean shutdown. This is the one place the CLI, the desktop shell (M7-01) and any helper look up where the daemon is — nothing hardcodes `127.0.0.1:4300`, so a port change or a version upgrade cannot leave a helper talking to a dead endpoint.
  - A second daemon on the same data directory **refuses to start** with a clear, actionable error naming the running pid, its version and its endpoint, and exits 3. It never starts on another port, never opens the database read-only, and never "takes over". A version mismatch is not an exception: an upgrading desktop shell must stop the old daemon and start the new one on the *same* data directory (the coordinated upgrade protocol is specified in **M7-01**; M0 only guarantees the invariant it relies on).
  - `--data-dir` (env `ORCH_DATA_DIR`) is the **only** supported way to run two daemons at once — separate directory ⇒ separate database, lock, endpoint file, token and tmux namespace. Sharing a data directory across two processes is unsupported, not merely discouraged.
- Static serving of `apps/web/dist` at `/` (populated in M0-07).
### Out of scope (deferred)
- WS gateway, REST resources → M0-06. Event store repos → M0-05. tmux/PTY → M1. OIDC → M9-02. Postgres → M9-05.

## 4. Design
### 4.1 Domain
None new; uses `@orchestra/core` types.
### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/config/schema.ts
export const ConfigSchema = z.object({
  host: z.object({ name: z.string().default(os.hostname()) }),
  server: z.object({ bind: z.literal('127.0.0.1').default('127.0.0.1'), port: z.number().int().default(4300) }),
  dataDir: z.string().default('~/.orchestra'),   // --data-dir / ORCH_DATA_DIR; every runtime path derives from it
  storage: z.object({ driver: z.enum(['sqlite']).default('sqlite'), sqlitePath: z.string().default('<dataDir>/orchestra.db') }),
  logging: z.object({ level: z.enum(['trace','debug','info','warn','error']).default('info'), pretty: z.boolean().default(false) }),
  features: z.record(z.boolean()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
```
Module map: `AppModule → [ConfigModule, LoggingModule, StorageModule, AuthModule, AuditModule, HealthModule, HostModule, StaticModule]`.
Audit interceptor contract: applies to `POST|PUT|PATCH|DELETE`; writes `{ts, userId:'local', action:`${method} ${route}`, target: params.id?, before?: (from handler metadata), after: redacted(response), ip}`.
### 4.3 Data / schema changes
Migration `0001_baseline.ts`: every table in `04-domain-model.md` §4 except `fts_*` (M5-03) and team-mode tables (`users/roles/permissions/settings_layers` created but empty-use). ULID text PKs, ISO text timestamps, `json_valid()` CHECK on JSON columns, indices on `(session_id)`, `(task_id)`, `(ts)`, `(type)`.
### 4.4 Infrastructure
`<data-dir>` (default `~/.orchestra/`) created with mode 0700; `token` 0600; `orchestrad.pid`; `daemon.lock` 0600 (advisory `flock`, held for the process lifetime); `endpoint.json` 0600 (written after listen, removed on clean shutdown); `logs/orchestrad.log` (rotating via pino transport in prod).

```ts
// apps/daemon/src/infrastructure/runtime/data-dir-lock.ts
export interface DaemonLockInfo { pid: number; daemonVersion: string; endpoint: string; startedAt: string; hostId: string }
export type LockOutcome =
  | { kind: 'acquired' }
  | { kind: 'stale-reclaimed'; previous: DaemonLockInfo }        // file present, flock free
  | { kind: 'held'; owner: DaemonLockInfo };                     // another daemon owns this data dir ⇒ exit 3
export function acquireDataDirLock(dataDir: string): Result<LockOutcome, DomainError>;
```
Env allowlist helper `childEnv()` (used by M1) lives in `infrastructure/process/`.
### 4.5 API / UI surface
- `GET /health` (no auth) → 200 JSON.
- Every other route → `401` without `Authorization: Bearer <token>`.
- `GET /` serves web (placeholder page until M0-07).
### 4.6 Flow
```
main.ts → loadConfig() (fail fast, prints Zod issues) → resolveDataDir() → ensureDirs() → acquireDataDirLock()
        │                                                                              └─ 'held'  → print owner pid/version/endpoint + the `--data-dir` hint → exit 3 (nothing opened)
        └─ 'acquired' | 'stale-reclaimed' → runMigrations() → Nest.create(Fastify) → useGlobalGuards(Auth)
           → useGlobalInterceptors(Audit, RequestId) → listen(127.0.0.1:4300) → writeEndpointFile() → register host row → log ready
SIGTERM → close server → remove endpoint.json → close db → release lock → remove pid
```

## 5. Tasks
- [ ] `apps/daemon` Nest bootstrap with Fastify; `src/{core,application,infrastructure,interface}` folders (`core` re-exports `@orchestra/core`).
- [ ] `ConfigModule` with `ConfigSchema`, layered loading, `orch config show` script prints effective config with sources.
- [ ] `LoggingModule` (pino) + redaction (`req.headers.authorization`, `*.token`, `*.apiKey`, `*.secret`, `*.cookie`) + request-id middleware.
- [ ] `StorageModule`: Kysely instance, `0001_baseline` migration, migration runner + `db:migrate`/`db:status` scripts, `DatabaseHealth` check.
- [ ] `AuthModule`: token generation/rotation service, `AuthGuard`, `@Public()` decorator.
- [ ] `AuditModule`: interceptor + `AuditRepository` (Kysely) + unit tests with a fake repo.
- [ ] `HealthModule`, `HostModule` (upsert host row on boot).
- [ ] Static serving + placeholder `index.html`.
- [ ] Graceful shutdown, PID file, `daemon.lock` (advisory flock + stale detection) and `endpoint.json` discovery file; exit codes documented (3 = data directory already owned).
- [ ] `pnpm --filter orchestrad dev` (tsx watch) and `start` (built); `Dockerfile` skipped until M9-06.
- [ ] Unit tests: config precedence, redaction, guard, interceptor; integration: boot on a temp `HOME`, health 200, migrations applied.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-04-01 | unit | config precedence env > file > default | effective values + sources correct |
| UT-M0-04-02 | unit | invalid config (port string) | process exits 1 with Zod issue list; no partial boot |
| UT-M0-04-03 | unit | logger redaction with a fake token in payload | output contains `[Redacted]` not the token |
| UT-M0-04-04 | unit | AuthGuard: missing/wrong/right token | 401/401/200 |
| UT-M0-04-05 | unit | audit interceptor on POST | one `audit_log` row with redacted after-image |
| IT-M0-04-06 | integration | boot with temp HOME | `~/.orchestra` 0700, token 0600, db created, `/health` 200, all baseline tables exist |
| IT-M0-04-07 | integration | second instance on the **same** `--data-dir` | refuses with "already running (pid N, version V, endpoint U)", exit 3; db untouched, `endpoint.json` still points at the first daemon |
| IT-M0-04-09 | integration | second instance on a **different** `--data-dir` | both run; separate db, token, lock and endpoint files; neither sees the other's host row |
| IT-M0-04-10 | integration | stale lock: write a `daemon.lock` for a dead pid with no flock held, then boot | boots normally, logs `stale-reclaimed` with the previous pid/version, overwrites the file |
| IT-M0-04-11 | integration | `SIGKILL` the daemon, then boot again | flock released by the OS ⇒ boot succeeds; no manual cleanup needed |
| UT-M0-04-12 | unit | second instance whose `daemonVersion` differs from the lock owner's | still refused (exit 3) — a version mismatch never authorises a second owner; the error names M7-01's upgrade protocol |
| IT-M0-04-08 | integration | SIGTERM during request | in-flight completes, db closed, pid removed |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expects | Status |
|---|---|---|---|---|
| TC-M0-04-01 | First boot | 1. remove `~/.orchestra` 2. `pnpm --filter orchestrad start` 3. `curl localhost:4300/health` | dir/token/db created with right perms (`ls -la`), health JSON with version and `dbOk:true` | ⬜ |
| TC-M0-04-02 | Auth | 1. `curl -i localhost:4300/api/anything` 2. repeat with `Authorization: Bearer $(cat ~/.orchestra/token)` | 401 then 404 (route missing but auth passed) | ⬜ |
| TC-M0-04-03 | Bad config fails fast | 1. `ORCH_SERVER_PORT=abc pnpm start` | exits non-zero, prints `server.port: Expected number` | ⬜ |
| TC-M0-04-04 | Redaction | 1. set log level debug 2. call any route with header `Authorization: Bearer SECRET123` | log shows `authorization: "[Redacted]"`, never `SECRET123` | ⬜ |
| TC-M0-04-05 | Bind address | 1. `lsof -i :4300` | bound to `127.0.0.1` only, not `*` | ⬜ |
| TC-M0-04-06 | Migrations idempotent | 1. restart daemon twice 2. `orch db status` | all migrations "applied", none re-run | ⬜ |
| TC-M0-04-07 | One owner per data directory | 1. start the daemon 2. in a second shell start it again with no flags 3. `cat ~/.orchestra/endpoint.json` 4. start a third with `--data-dir /tmp/orch-b` 5. `kill -9` the first, then start it again | 2: exits 3, message names the running pid, version and endpoint and suggests `--data-dir`; 3: endpoint of the first daemon, matching `lsof -i`; 4: starts fine on its own port with its own db/token/lock; 5: boots, logs the stale lock it reclaimed, no manual cleanup | ⬜ |

## 7. Acceptance criteria
- [ ] Daemon boots on a clean machine with one command; `/health` 200.
- [ ] Baseline migration creates every v1 table; `db:status` clean.
- [ ] Global auth guard + local token; only `/health` and `/` public.
- [ ] Audit interceptor writes rows for mutating calls with redaction.
- [ ] Logs are JSON with request ids and redaction; secrets never appear (test proven).
- [ ] Binds 127.0.0.1 only; graceful shutdown.
- [ ] Exactly one daemon can own a data directory (ADR-020): advisory `flock` on `daemon.lock`, stale-lock reclaim, clear exit-3 refusal naming the owner, `--data-dir` as the only supported way to run two, and `endpoint.json` as the single discovery point for CLI/desktop helpers.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- better-sqlite3 prebuilt for Node 22 arm64: verify at install; fallback build needs Xcode CLT.
- Baseline migration is large; keep it generated from one schema file and reviewed once — never edited after M0 ships (add migrations instead).
- OTel semconv pin (DECISIONS "open"): add the dependency now but no exporter until M9-08.
- Advisory `flock` is per-OS: it works on macOS/Linux and across processes on the same host, but **not across an NFS/SMB mount**. A data directory on a network share is unsupported — detect and warn at boot; a hard guarantee there would need a different mechanism.
- This step only establishes the *invariant* (one owner per data directory). The **coordinated upgrade protocol** — how a desktop shell stops an older daemon and starts a newer one on the same data directory without orphaning helpers — is M7-01's problem; M7-01 must not solve it by starting a second daemon on another port (ADR-020).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
