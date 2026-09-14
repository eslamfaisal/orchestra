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
- Graceful shutdown hooks; PID file; single-instance lock.
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
  storage: z.object({ driver: z.enum(['sqlite']).default('sqlite'), sqlitePath: z.string().default('~/.orchestra/orchestra.db') }),
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
`~/.orchestra/` created with mode 0700; `token` 0600; `orchestrad.pid`; `logs/orchestrad.log` (rotating via pino transport in prod).
Env allowlist helper `childEnv()` (used by M1) lives in `infrastructure/process/`.
### 4.5 API / UI surface
- `GET /health` (no auth) → 200 JSON.
- Every other route → `401` without `Authorization: Bearer <token>`.
- `GET /` serves web (placeholder page until M0-07).
### 4.6 Flow
```
main.ts → loadConfig() (fail fast, prints Zod issues) → ensureDirs() → runMigrations() → Nest.create(Fastify) → useGlobalGuards(Auth) → useGlobalInterceptors(Audit, RequestId) → listen(127.0.0.1:4300) → register host row → log ready
SIGTERM → close server → close db → remove pid
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
- [ ] Graceful shutdown, PID + single-instance lock, exit codes documented.
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
| IT-M0-04-07 | integration | second instance start | refuses with "already running (pid N)" exit 3 |
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

## 7. Acceptance criteria
- [ ] Daemon boots on a clean machine with one command; `/health` 200.
- [ ] Baseline migration creates every v1 table; `db:status` clean.
- [ ] Global auth guard + local token; only `/health` and `/` public.
- [ ] Audit interceptor writes rows for mutating calls with redaction.
- [ ] Logs are JSON with request ids and redaction; secrets never appear (test proven).
- [ ] Binds 127.0.0.1 only; single-instance lock; graceful shutdown.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- better-sqlite3 prebuilt for Node 22 arm64: verify at install; fallback build needs Xcode CLT.
- Baseline migration is large; keep it generated from one schema file and reviewed once — never edited after M0 ships (add migrations instead).
- OTel semconv pin (DECISIONS "open"): add the dependency now but no exporter until M9-08.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
