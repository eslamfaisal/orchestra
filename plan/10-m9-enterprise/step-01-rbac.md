# Step M9-01 — RBAC

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M8-01 |
| Estimated effort | 3 days |
| Packages touched | `packages/core` (`src/auth/`), `apps/daemon` (`src/core/auth`, `src/application/auth`, `src/infrastructure/persistence`, `src/interface/http`, `src/interface/ws`, `src/interface/mcp`), `apps/web` (Settings → Users & roles, permission-aware UI), `apps/cli`, `packages/sdk` (types only) |
| Risk | High (touches every mutating handler) |
| Owner | |

## 1. Goal
After this step the daemon knows *who* is acting and *whether they may*. Four built-in roles (Admin, Lead, Member, Viewer) map to a fixed set of permissions; every mutating HTTP route, WS command and MCP tool is guarded; ownership rules restrict Members to their own sessions and to missions shared with the team; denied attempts are audited. In single-user mode (`auth.mode: local`, the default) the local-token user is an implicit Admin, so every M0–M8 flow behaves exactly as before. An Admin can create users, assign roles and deactivate users from Settings → Users & roles and from `orch users`.

## 2. Why
- Personas "team lead" and "team member" (`01-vision-scope.md`) require limited permissions and audited spend/keys actions.
- D9: NestJS guards/interceptors are the reason the daemon is NestJS; RBAC is their first real use. D8: team mode is a config switch, not a fork.
- C10: every spend/keys action must be permissioned and audited; C12: Repair Agent guardrails later reuse the same permission model.
- `03-architecture.md` §6 lists "RBAC guards (no-op single-user mode until M9)" as cross-cutting.
- Prerequisite for M9-02 (OIDC maps groups → these roles), M9-03 (actor identity in the audit chain), M9-04 (approver roles), M9-07 (automation owner permissions).

## 3. Scope
### In scope
- `users`, `roles`, `permissions`, `user_roles`, `api_tokens` tables and repositories (SQLite now, Postgres-compatible types, M9-05 reuses).
- `AuthorizationPolicy` domain service in `packages/core`, 100 % branch coverage.
- `@RequirePermission()` decorator + `PermissionGuard` on HTTP, `WsCommandGuard` on `/ws` commands, `McpToolGuard` on delegation tools, `TermAttachGuard` on `/term/:paneId`.
- Ownership: `owner_user_id` on `sessions`, `missions`, `tasks`, `worktrees`, `automations` (M9-07 adds its own); `missions.visibility` (`private | team`).
- Event/WS visibility filter per connection (Members only receive events for resources they can view).
- Local mode implicit Admin; personal API tokens for CLI in team mode.
- Settings → Users & roles screen; `orch users list|add|set-role|deactivate|token`.
- Audit of denials (`audit.denied`) through the M0-04 interceptor (chain hardening is M9-03).
### Out of scope (deferred to …)
- OIDC login and group → role mapping — M9-02.
- Custom roles / per-workspace roles — deferred to M10 backlog (not planned; note in `ROADMAP.md` if requested).
- Hash-chained audit and export — M9-03.
- Approval gates and 4-eyes — M9-04.
- Row-level security in Postgres — M9-05 evaluates; not required for parity.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `User { id, email, displayName, status: active|deactivated, createdAt, lastLoginAt? }`.
- `RoleName = 'admin' | 'lead' | 'member' | 'viewer'` (value object already listed in `04-domain-model.md`). Roles are ordered `viewer < member < lead < admin` only for UI display; authorisation is by explicit permission rows, never by rank comparison.
- `Permission = '<resource>.<action>'` string literal union (below). `Scope = 'any' | 'own' | 'shared'`.
- `Actor { kind: 'user' | 'agent' | 'policy' | 'system', userId?, sessionId?, roles: RoleName[] }`. Agents (MCP tools called from a Lead session) act **as the session owner** with `kind: 'agent'`; `policy` (auto-answer) and `system` (automations, retention job) carry the owning user's permissions or `system` role.
- Rule `AuthorizationPolicy.can(actor, permission, resource?) → Result<void, Forbidden>`: allowed when any of the actor's roles grants the permission with scope `any`, or scope `own` and `resource.ownerUserId === actor.userId`, or scope `shared` and `resource.visibility === 'team'`. Missing resource with scope `own|shared` ⇒ `Forbidden` (fail closed).
- Rule: a deactivated user has no roles. Rule: the last active Admin cannot be deactivated or demoted (`LastAdminProtected`).
- Local mode: `LocalAdminActor` singleton with all permissions; `users` table still gets one row `local-admin` so ownership columns are never null.

Permission matrix (built-in roles; `own` = resources with `owner_user_id = actor`, `shared` = missions with `visibility = team` and their sessions/tasks):

| Permission | Viewer | Member | Lead | Admin |
|---|---|---|---|---|
| `session.view` (read-only terminal, chat, events) | shared | own + shared | any | any |
| `session.start` | no | own | any | any |
| `session.stop` | no | own | any | any |
| `session.attach` (keystrokes to `/term`) | no | own | any | any |
| `prompt.answer` | no | own | any | any |
| `task.delegate` | no | own | any | any |
| `plan.approve` | no | own | any | any |
| `task.merge` | no | no | any | any |
| `gate.approve` (M9-04) | no | no | any (not own request when 4-eyes) | any |
| `policy.edit.workspace` | no | no | any | any |
| `policy.edit.org` | no | no | no | any |
| `recording.view` | shared | own + shared | any | any |
| `recording.export` | no | no | any | any |
| `doctor.run` | no | no | any | any |
| `remediation.apply` | no | no | any (ladder 1–2) | any |
| `user.manage` | no | no | no | any |
| `audit.read` | no | no | any | any |
| `audit.export` (M9-03) | no | no | no | any |
| `automation.manage` (M9-07) | no | no | any | any |
| `metrics.read` (M9-08) | no | no | any | any |
| `settings.self.edit` | any | any | any | any |

### 4.2 Interfaces / contracts
```ts
// packages/core/src/auth/permission.ts
export type Permission =
  | 'session.view' | 'session.start' | 'session.stop' | 'session.attach' | 'prompt.answer'
  | 'task.delegate' | 'plan.approve' | 'task.merge' | 'gate.approve'
  | 'policy.edit.workspace' | 'policy.edit.org' | 'recording.view' | 'recording.export'
  | 'doctor.run' | 'remediation.apply' | 'user.manage' | 'audit.read' | 'audit.export'
  | 'automation.manage' | 'metrics.read' | 'settings.self.edit';
export type Scope = 'any' | 'own' | 'shared';
export interface Grant { permission: Permission; scope: Scope }
export interface Actor { kind: 'user'|'agent'|'policy'|'system'; userId: string; roles: RoleName[]; sessionId?: string }
export interface OwnedResource { ownerUserId: string; visibility?: 'private'|'team' }
export type Forbidden = { code: 'FORBIDDEN'; permission: Permission; reason: 'no_grant'|'not_owner'|'not_shared'|'resource_missing' };

export class AuthorizationPolicy {
  constructor(private readonly grants: ReadonlyMap<RoleName, readonly Grant[]>) {}
  can(actor: Actor, permission: Permission, resource?: OwnedResource): Result<void, Forbidden>;
}

// packages/core/src/auth/ports.ts
export interface UserRepository { findById(id): Promise<Result<User, NotFound>>; findByEmail(email): …; save(user): …; list(page): …; }
export interface RoleAssignmentRepository { rolesOf(userId): Promise<RoleName[]>; assign(userId, role, byUserId): …; revoke(…): …; }
export interface ApiTokenRepository { create(userId, name, hash, expiresAt): …; findByHash(hash): …; revoke(id): …; }
export interface ResourceOwnershipPort { ownerOf(kind: 'session'|'mission'|'task'|'recording'|'worktree', id: string): Promise<Result<OwnedResource, NotFound>>; }

// apps/daemon/src/interface/http/auth/require-permission.decorator.ts
export const RequirePermission = (permission: Permission, resource?: { kind: ResourceKind; param: string }) => SetMetadata(PERMISSION_KEY, { permission, resource });
```
Use cases (one class each, `apps/daemon/src/application/auth/`): `CreateUser`, `SetUserRole`, `DeactivateUser`, `ListUsers`, `IssueApiToken`, `RevokeApiToken`, `ResolveActor` (from request principal), `Authorize` (wraps `AuthorizationPolicy` + `ResourceOwnershipPort`; used by all guards).

### 4.3 Data / schema changes
Migration `0090_rbac` (Postgres-compatible types only, ADR-010):
- `users (id text pk, email text unique, display_name text, status text, external_subject text null, created_at text, last_login_at text null)`.
- `roles (id text pk, name text unique, builtin integer)` seeded with the four roles.
- `permissions (id text pk, role_id text fk, permission text, scope text, unique(role_id, permission))` seeded from the matrix.
- `user_roles (user_id text, role_id text, assigned_by text, assigned_at text, pk(user_id, role_id))` — new table, not in `04-domain-model.md` (flag).
- `api_tokens (id text pk, user_id text, name text, token_hash text unique, created_at text, expires_at text null, last_used_at text null, revoked_at text null)` — new table (flag).
- Add `owner_user_id text not null default 'local-admin'` to `sessions`, `missions`, `tasks`, `worktrees`; `missions.visibility text not null default 'team'` (default `team` keeps M3 behaviour visible to everyone; local mode is unaffected).
- Backfill: single row `users.id = 'local-admin'` with role admin.
- Grants are data (rows), not code: `AuthorizationPolicy` is constructed from `permissions` rows at boot and hot-reloaded on change; tests build it from the same seed.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No tmux/git changes. Token hashing: SHA-256 of a 32-byte random token (`IdGenerator`/`Random` port); tokens shown once.
- Local token file (`~/.orchestra/token`, M0-04) continues to authenticate as `local-admin` in local mode; in team mode the file token is disabled unless `auth.allowLocalToken: true` (defaults false; documented as break-glass, audited on every use).
- `AuthStrategyRegistry` (DI map keyed by scheme: `local-token`, `api-token`; M9-02 adds `cookie-session`) — no `switch`.

### 4.5 API / UI surface
- `GET /users`, `POST /users`, `PATCH /users/:id/role`, `POST /users/:id/deactivate`, `POST /users/:id/tokens`, `DELETE /users/:id/tokens/:tokenId` — all `@RequirePermission('user.manage')`, Zod-validated bodies, `Idempotency-Key` honoured.
- `GET /me` → `{ user, roles, permissions[] }` (UI hides controls it cannot use; server remains the authority).
- Every existing mutating route gets a decorator, e.g. `POST /sessions` → `session.start`; `POST /prompts/:id/answer` → `prompt.answer` with `resource: { kind: 'session', param: 'sessionId' }`; `POST /tasks/:id/merge` → `task.merge`.
- WS: each inbound command frame `{ cmd, args }` is mapped to a permission in `WsCommandPermissions` table; denial replies `{ error: 'FORBIDDEN', permission }`. Subscriptions are filtered by `VisibilityFilter` (server-side) so a Member never receives another Member's private session events.
- `/term/:paneId` upgrade: `session.view` for read, `session.attach` for input; read-only connections have input frames dropped and counted.
- MCP tools (`delegate`, `collect`, `ask_user`, `status`): the Lead session's owner is the actor; `delegate` requires `task.delegate` on the mission.
- UI: Settings → Users & roles (list, role dropdown, deactivate, "New API token" dialog showing the token once); a "Forbidden" toast with the permission name; disabled buttons carry a tooltip naming the missing permission (12-ux principle 5).
- CLI: `orch users list|add <email> --role|set-role <id> <role>|deactivate <id>|token <id> --name`.

### 4.6 Flow / sequence
```
HTTP POST /prompts/:id/answer (Bearer api-token)
  → AuthStrategyRegistry.resolve → Principal{userId}
  → ResolveActor → Actor{roles}
  → PermissionGuard: metadata {prompt.answer, resource session:sessionId}
      → ResourceOwnershipPort.ownerOf('session', id) → Authorize.can(...)
      → Err(Forbidden) ⇒ 403 {code:'FORBIDDEN', permission, reason} + audit(outcome=denied)
      → Ok ⇒ controller → AnswerPrompt use case → audit(outcome=allowed)
```
Architecture test: a Vitest spec walks the Nest metadata of every controller method with `@Post/@Patch/@Put/@Delete`, every WS command in `WsCommandPermissions`, and every MCP tool, and fails if any lacks a permission mapping (allowlist file for the few public routes: `/healthz`, `/auth/*`, `/hooks/*` which use their own per-session secret).

## 5. Tasks
- [ ] `packages/core/src/auth/`: `Permission`, `Scope`, `Actor`, `AuthorizationPolicy` with typed `Forbidden`; 100 % branch coverage.
- [ ] Ports: `UserRepository`, `RoleAssignmentRepository`, `ApiTokenRepository`, `ResourceOwnershipPort`.
- [ ] Migration `0090_rbac` (tables, seeds, `owner_user_id` columns, `local-admin` backfill); run on SQLite; keep types Postgres-compatible.
- [ ] Kysely repositories + in-memory repositories for application tests.
- [ ] Use cases `CreateUser`, `SetUserRole` (with `LastAdminProtected`), `DeactivateUser`, `ListUsers`, `IssueApiToken`, `RevokeApiToken`, `ResolveActor`, `Authorize`.
- [ ] `AuthStrategyRegistry` with `local-token` and `api-token` strategies; local-mode implicit Admin; `auth.allowLocalToken` break-glass with audit.
- [ ] `@RequirePermission` decorator + `PermissionGuard`; apply to every mutating HTTP route; `WsCommandPermissions` map + `WsCommandGuard`; `McpToolGuard`; `TermAttachGuard`.
- [ ] `VisibilityFilter` for WS topics and event replay; unit tests for Member/Viewer visibility.
- [ ] Set `owner_user_id` in `StartSession`, `PlanMission`, `DelegateTask`, worktree creation; `visibility` on mission create (default from policy `missions.defaultVisibility`).
- [ ] Audit interceptor: emit `outcome: denied` rows with permission and reason (redacted target).
- [ ] Architecture test "every mutating handler is guarded" + allowlist file; wire into CI.
- [ ] HTTP routes `/users*`, `/me`; OpenAPI updated; Zod schemas.
- [ ] Web: Settings → Users & roles; `useCan(permission)` hook backed by `/me`; forbidden toast; disabled-with-tooltip controls on Attention, Fleet, Review, Health.
- [ ] CLI `orch users …` commands with `--json`.
- [ ] Docs: `docs/deployment/rbac.md` (matrix, ownership, break-glass); package README updates.
- [ ] Run all M0–M8 E2E suites in local mode; fix regressions.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-01-01 | unit | `AuthorizationPolicy.can` over the full matrix × scopes × ownership combos (table-driven) | matches the matrix; 100 % branches |
| UT-M9-01-02 | unit | `SetUserRole` demoting the last Admin | `Err(LastAdminProtected)` |
| UT-M9-01-03 | unit | deactivated user resolves to zero roles | every `can` returns `Forbidden{no_grant}` |
| AT-M9-01-01 | application | `Authorize` with missing resource for scope `own` | `Forbidden{resource_missing}` (fail closed) |
| AT-M9-01-02 | application | `IssueApiToken` then `ResolveActor` from hash; revoked token | ok then `Unauthorized` |
| IT-M9-01-01 | integration | HTTP 403 on `POST /sessions` as Viewer; 201 as Member; audit row `outcome=denied` present | as stated |
| IT-M9-01-02 | integration | WS: Member A subscribed to `sessions.*` does not receive Member B's private session events; receives team-mission session events | filtered correctly |
| IT-M9-01-03 | integration | `/term/:paneId` as Viewer: input frames dropped, output streamed | counter `term_input_dropped_total` increments |
| ARCH-M9-01-01 | architecture | every mutating controller method / WS command / MCP tool has a permission mapping | test fails when a decorator is removed |
| E2E-M9-01-01 | e2e | Playwright: two API-token users; Viewer sees disabled Approve with tooltip; Lead approves | UI + server agree |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-01-01 | Local mode unchanged | 1. `auth.mode: local`. 2. Start daemon with existing SQLite DB from M8. 3. Start a FakeProvider session, answer a prompt, delegate a task from web and `orch`. | Everything works as in M8; `/me` shows `local-admin` with role admin; `sessions.owner_user_id = 'local-admin'`. | ⬜ |
| TC-M9-01-02 | Two users, different permissions | 1. `auth.mode: team`. 2. `orch users add alice --role member`, `orch users add bob --role viewer`, issue tokens. 3. Browser profile A with Alice's token, B with Bob's. 4. A starts a session; B tries Start session and Answer prompt. | A succeeds; B's buttons disabled with tooltip; forcing the call via curl returns 403 `{code:FORBIDDEN, permission:'session.start'}`; Settings → Audit (Admin) shows two denied rows for bob. | ⬜ |
| TC-M9-01-03 | Ownership isolation | 1. Alice (Member) starts a private-mission session. 2. Carol (Member) opens Fleet/Terminals. 3. Carol curls `POST /prompts/<alice-prompt>/answer`. | Carol's Fleet does not list Alice's session; WS receives no events for it; curl → 403 `reason: not_owner`. | ⬜ |
| TC-M9-01-04 | Negative: last Admin protection | 1. As the only Admin, Settings → Users → set own role to Member. | Request rejected with `LastAdminProtected`; role unchanged; audit row denied. | ⬜ |
| TC-M9-01-05 | Role change without re-login | 1. Bob (Viewer) has an open browser. 2. Admin sets Bob → Member. 3. Bob starts a session. | Next request is authorised as Member (roles resolved per request, not cached beyond 5 s). | ⬜ |
| TC-M9-01-06 | Resilience: daemon restart mid-request | 1. Alice starts a long FakeProvider session. 2. `kill -9` daemon, restart. 3. Alice and Bob reconnect. | Session reconciled with the same `owner_user_id`; Bob still cannot attach; no prompt lost (M5-05). | ⬜ |
| TC-M9-01-07 | API token lifecycle | 1. Issue token for Alice via UI (shown once). 2. Use it with `orch fleet`. 3. Revoke. 4. Use again. | Works, then 401 `TOKEN_REVOKED`; both audited. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Permission matrix implemented as data rows and enforced by `AuthorizationPolicy` with 100 % branch coverage.
- [ ] Architecture test proves every mutating HTTP route, WS command and MCP tool is guarded; allowlist file reviewed.
- [ ] Two users with different roles behave per matrix in UI, HTTP, WS and `/term` (TC-M9-01-02/03).
- [ ] Denied attempts produce audit rows with `outcome = denied`, permission and reason.
- [ ] Local mode: all M0–M8 automated E2E suites green with no config change.
- [ ] All TC-M9-01-* pass and are recorded.
- [ ] No new lint/arch violations (`dependency-cruiser`, ESLint, `packages/core` has zero runtime deps).
- [ ] `docs/deployment/rbac.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- Ownership of sessions started by a Lead agent on behalf of a Member (MCP `delegate` inside a shared mission): design says owner = mission owner; verify that Review UI attribution stays readable (verify).
- `missions.visibility` default `team` vs `private`: `team` preserves M3 behaviour; teams that want private-by-default set policy `missions.defaultVisibility` (M8-01 layer).
- Per-request role resolution costs one query; a 5 s in-process cache is proposed — confirm it does not break TC-M9-01-05 expectations.
- `04-domain-model.md` lists only `users, roles, permissions, settings_layers`; this step adds `user_roles` and `api_tokens` — domain model doc needs an update (not done here).
- Whether `Viewer` should see Terminals output at all (recordings may contain code); default is `shared` only; org policy `viewer.terminalOutput: false` could hide it (verify with first team user).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
