# Step M9-02 — OIDC

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M9-01, M7-04 |
| Estimated effort | 2 days |
| Packages touched | `apps/daemon` (`src/application/auth`, `src/infrastructure/auth/oidc`, `src/infrastructure/egress`, `src/interface/http/auth`, `src/interface/config`), `apps/web` (login/callback/logout, session expiry UX), `apps/cli` (unchanged auth path, docs), `packages/core` (`src/auth/` — claim-mapping rules only) |
| Risk | Medium |
| Owner | |

## 1. Goal
With `auth.mode: team` and an `auth.oidc.*` block configured, opening the daemon in a browser redirects to the organisation's identity provider, and after a successful Authorization Code + PKCE login the user lands on Attention as themselves. The daemon creates (or updates) their `users` row from the ID token's `sub`/`email`/`name`, maps their IdP groups/claims to Orchestra roles (M9-01) on every login, and issues an httpOnly session cookie. Sessions refresh silently while the refresh token is valid, "Sign out" clears the cookie locally and (optionally) redirects to the IdP's end-session endpoint. The `orch` CLI and scripts keep using personal API tokens (M9-01) — no browser needed. Single-user mode (`auth.mode: local`) is untouched.

## 2. Why
- D8/D9: team mode is a config switch over the same daemon; NestJS guards and the `AuthStrategyRegistry` introduced in M9-01 (and the "OIDC-ready auth module" delivered in M7-04) get their third strategy without any change to controllers.
- Persona "team member" (`00-foundations/01-vision-scope.md`) must not have a hand-managed password; the organisation already owns identity lifecycle (joiner/leaver) and Orchestra must follow it, which is exactly what group → role mapping on each login gives.
- C2: OIDC is one of the four explicitly allowed egress targets ("Web Push, OIDC, registries, update check, GitHub/GitLab PR API"). This step is where that egress becomes real, so it must go through one allowlisted module and nothing else.
- C3: the daemon still never touches vendor credential stores. The OIDC tokens are Orchestra's own user tokens, never a vendor's, and they are never forwarded to any provider CLI (asserted by a test).
- C10: audited login/logout/denied-login rows give the audit chain (M9-03) a real subject identity instead of `local-admin`.
- M9-03, M9-04 and M9-07 all need a stable `userId` that survives across browsers and hosts.

## 3. Scope
### In scope
- `openid-client` v6 based `OidcClient` in `apps/daemon/src/infrastructure/auth/oidc/`, discovery via `.well-known/openid-configuration`, JWKS caching and rotation.
- Authorization Code flow with **PKCE (S256)**, `state` and `nonce`, `response_mode=query`, no implicit/hybrid support.
- Session cookie strategy (`cookie-session`) registered in the M9-01 `AuthStrategyRegistry`; server-side session records in `auth_sessions`.
- Claim → role mapping config (`auth.oidc.roleMapping`) with a pure `mapClaimsToRoles` rule in `packages/core`.
- Silent refresh using the refresh token; absolute and idle session lifetimes; revocation on logout and on user deactivation.
- Logout: local session delete + optional RP-initiated logout (`end_session_endpoint`).
- `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/session` routes (public, rate-limited); web login screen and expiry handling.
- `infrastructure/egress/` allowlist module: the only place `fetch` is allowed to reach a configured non-vendor host (IdP, and later SIEM/S3/OTLP).
- Config schema additions + `orch auth test-oidc` diagnostic command.
- Docs `docs/deployment/oidc.md` with Dex, Keycloak, Okta, Entra ID and Google Workspace examples.
### Out of scope (deferred to …)
- SAML, LDAP, SCIM provisioning — not planned for 1.0; note in `ROADMAP.md` if a team asks.
- Device Authorization Grant for the CLI (`orch login` in a browser) — deferred to M10 backlog; API tokens (M9-01) cover the CLI.
- mTLS / client-certificate auth, and IdP-signed machine tokens for automations — deferred to M9-07 (automations run as their owner).
- Per-workspace / multi-tenant IdPs (one issuer per daemon here) — deferred to M10 backlog.
- Custom roles beyond the four built-ins — M9-01 already declared this out of scope.
- Encrypting the refresh token at rest — decided in M9-09 (`pgcrypto`/SQLCipher choice); this step stores a SHA-256 handle plus the ciphertext column it will fill.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `ExternalIdentity { issuer, subject }` value object; `users.external_subject` (added in M9-01) is `issuer|subject` so a re-pointed IdP cannot silently take over an account.
- `AuthSession { id, userId, issuedAt, idleExpiresAt, absoluteExpiresAt, refreshTokenRef?, ip, userAgentHash, revokedAt? }` — a server-side record; the cookie carries only an opaque id.
- Pure rule `mapClaimsToRoles(claims, mapping) → Result<RoleName[], ClaimMappingError>` (`packages/core/src/auth/claim-mapping.ts`, 100 % branch):
  - Mapping entries are evaluated in order; each is `{ claim, match: 'equals'|'contains'|'startsWith', value, role }` against a string or string-array claim.
  - All matching entries contribute; the union of roles is returned (M9-01 authorises by explicit grants, never by rank).
  - No match ⇒ `mapping.defaultRole` if set, else `Err(NoRoleForUser)` → login refused with an audited reason (fail closed).
  - `admin` is only assignable when `mapping.allowAdminFromIdp: true` (default `false`) — otherwise an Admin must be promoted locally, so a misconfigured IdP group cannot mint Admins.
- Rule: a user whose `status = deactivated` is refused at callback even with a valid token (`Err(UserDeactivated)`), and all their `auth_sessions` are revoked.
- Rule: roles are recomputed on every login **and** on every refresh; a user removed from a group loses the role at the next refresh (≤ `auth.session.idleTtl`), not at token expiry.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/auth/claim-mapping.ts (pure)
export interface RoleMappingEntry { claim: string; match: 'equals' | 'contains' | 'startsWith'; value: string; role: RoleName }
export interface RoleMapping { entries: RoleMappingEntry[]; defaultRole?: RoleName; allowAdminFromIdp: boolean }
export type ClaimMappingError = { code: 'NoRoleForUser'; claims: string[] } | { code: 'AdminFromIdpBlocked'; entryIndex: number };
export function mapClaimsToRoles(claims: Readonly<Record<string, unknown>>, mapping: RoleMapping): Result<RoleName[], ClaimMappingError>;

// packages/core/src/auth/ports.ts (additions to M9-01)
export interface AuthSessionRepository {
  create(s: AuthSession): Promise<Result<void, RepoError>>;
  findById(id: string): Promise<Result<AuthSession, NotFound>>;
  touch(id: string, idleExpiresAt: Iso8601): Promise<Result<void, RepoError>>;
  revoke(id: string, reason: string): Promise<Result<void, RepoError>>;
  revokeAllForUser(userId: string, reason: string): Promise<Result<number, RepoError>>;
}

// apps/daemon/src/infrastructure/auth/oidc/oidc-client.port.ts
export interface OidcPort {
  discover(): Promise<Result<OidcMetadata, OidcError>>;
  authorizationUrl(i: { state: string; nonce: string; codeChallenge: string }): Result<string, OidcError>;
  exchangeCode(i: { code: string; codeVerifier: string; expectedNonce: string }): Promise<Result<OidcTokens, OidcError>>;
  refresh(refreshToken: string): Promise<Result<OidcTokens, OidcError>>;
  endSessionUrl(idTokenHint: string): Result<string | null, OidcError>;
}
export interface OidcTokens { claims: Record<string, unknown>; idToken: string; accessToken?: string; refreshToken?: string; expiresAt: Iso8601 }
export type OidcError = {
  code: 'DiscoveryFailed' | 'IssuerMismatch' | 'BadState' | 'BadNonce' | 'CodeExchangeFailed'
      | 'SignatureInvalid' | 'TokenExpired' | 'AudienceMismatch' | 'RefreshFailed' | 'EgressBlocked';
  message: string;
};
```
Use cases (one class each, `apps/daemon/src/application/auth/`): `BeginOidcLogin`, `CompleteOidcLogin`, `RefreshAuthSession`, `EndAuthSession`, `ResolveActorFromCookie` (used by the `cookie-session` strategy), `TestOidcConfig`.

### 4.3 Data / schema changes
Migration `0091_oidc_sessions` (Postgres-compatible types; extends `04-domain-model.md` §4 team-mode tables — **not** in the doc, flag for update):
- `auth_sessions (id text pk, user_id text not null, created_at text, idle_expires_at text, absolute_expires_at text, refresh_token_enc text null, refresh_token_sha256 text null, id_token_sha256 text null, ip text, user_agent_hash text, revoked_at text null, revoked_reason text null)`; index `(user_id)`, `(idle_expires_at)`.
- `auth_login_attempts (id text pk, ts text, issuer text, subject text null, email text null, outcome text, reason text null, ip text)` — feeds rate limiting and the audit chain; retention policy `30d` registered with M5-06's sweeper.
- `users`: `external_issuer text null` added next to M9-01's `external_subject`; unique `(external_issuer, external_subject)`.
- New events: `auth.login_succeeded`, `auth.login_failed`, `auth.logout`, `auth.session_refreshed`, `auth.roles_changed` (payload `{userId, before[], after[], source:'idp'}`) — extension of the `audit.*`/`provider.*` catalog in `04-domain-model.md` §3.
- Config (Zod, `apps/daemon/src/interface/config/schema.ts`):

| Key | Type | Default | Notes |
|---|---|---|---|
| `auth.mode` | `local \| team` | `local` | M9-01 introduced it |
| `auth.oidc.issuer` | url | — | required when `mode: team` and `auth.oidc.enabled` |
| `auth.oidc.clientId` | string | — | |
| `auth.oidc.clientSecret` | string (env only) | — | `ORCH_OIDC_CLIENT_SECRET`; never from `config.yaml` (standards §Config) |
| `auth.oidc.redirectUri` | url | `${server.publicUrl}/auth/callback` | must be https unless host is localhost |
| `auth.oidc.scopes` | string[] | `['openid','profile','email','groups','offline_access']` | |
| `auth.oidc.roleMapping` | `RoleMapping` | `{entries:[],allowAdminFromIdp:false}` | |
| `auth.session.idleTtl` | duration | `8h` | |
| `auth.session.absoluteTtl` | duration | `7d` | |
| `auth.session.cookieName` | string | `orch_sid` | |
| `auth.oidc.rpInitiatedLogout` | boolean | `true` | requires `end_session_endpoint` |
| `auth.oidc.clockSkewSeconds` | number | `60` | |

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No tmux/git changes. Network egress: `apps/daemon/src/infrastructure/egress/egress.service.ts` is the single allowlisted `fetch` wrapper (the `no-vendor-endpoints` ESLint rule allowlists this path only). It resolves the target host against the config-derived allowlist (`auth.oidc.issuer` host only for this step), enforces https (except `localhost`/`127.0.0.1` for the Dex dev stack), a 5 s connect / 10 s total timeout, no redirects to a different host, and a 256 KB response cap. Everything else returns `EgressBlocked`.
- `openid-client` is configured with `execute: [allowInsecureRequests]` **only** when the issuer host is loopback (dev), guarded by a boot assertion; production config with an http issuer fails fast at boot (verify the v6 option name against the `openid-client` docs at step start).
- JWKS cached in memory with the library's default cooldown; rotation handled by re-fetch on unknown `kid` (at most once per minute).
- Cookie: `Set-Cookie: orch_sid=<opaque ulid>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<idleTtl>`. `Secure` is dropped only when `server.publicUrl` is `http://localhost*` (dev), which is logged as a warning at boot. `SameSite=Lax` (not `Strict`) so the IdP's top-level redirect back to `/auth/callback` carries the cookie.
- Login transaction cookie `orch_txn` (httpOnly, `SameSite=Lax`, 10 min, signed) holds `{state, nonce, codeVerifier, returnTo}` — never kept in daemon memory, so a restart mid-login still completes.
- Rate limiting: 10 `/auth/login` starts per IP per minute, 20 `/auth/callback` per IP per minute (Fastify rate-limit plugin), exceeded ⇒ 429 + `auth.login_failed{reason:'rate_limited'}`.
- Child processes: the OIDC tokens are never placed in `childEnv()` (M0-04) — an architecture test greps the launcher env allowlist.

### 4.5 API / UI surface
| Route | Auth | Behaviour |
|---|---|---|
| `GET /auth/login?returnTo=` | public | 302 to IdP; sets `orch_txn`; `returnTo` must be a same-origin path (else 400 `BadReturnTo`) |
| `GET /auth/callback?code&state` | public | validates state/nonce/signature/audience → `CompleteOidcLogin` → sets `orch_sid` → 302 to `returnTo` or `/attention` |
| `POST /auth/logout` | cookie | revokes session, clears cookie, returns `{ endSessionUrl? }` |
| `GET /auth/session` | cookie | `{ user, roles, permissions[], expiresAt }` (superset of M9-01's `/me` for cookie clients) |
| `GET /auth/config` | public | `{ mode, oidcEnabled, issuerLabel }` — lets the web app render the right login screen without leaking config |

- Guards: `cookie-session` strategy resolves `Principal` from `orch_sid`, then M9-01's `ResolveActor`/`PermissionGuard` run unchanged. WS `/ws` and `/term` upgrades accept the cookie (same-origin check on `Origin` header; cross-origin upgrade ⇒ 403).
- CSRF: cookie auth is only accepted for `GET`/`HEAD` plus requests carrying `X-Orch-Csrf: <token from /auth/session>`; API-token clients are exempt. `SameSite=Lax` alone is not relied on.
- Web (`apps/web/src/screens/auth/`): `LoginScreen` ("Sign in with <issuerLabel>"), `CallbackScreen` (spinner + error states per `OidcError.code`), a session-expiry banner that re-runs `/auth/login?returnTo=<current path>` without losing unsent form state, and a user menu with "Sign out". 401 on any fetch ⇒ redirect to login once, then show the error (no redirect loop). EN + AR strings, RTL-safe.
- CLI: unchanged (`orch` keeps API tokens). `orch auth test-oidc --config <path>` prints discovery results, mapped roles for a sample claims JSON, and the effective redirect URI.

### 4.6 Flow / sequence
```
browser GET /attention  → 401 (no cookie)  → web redirects to /auth/login?returnTo=/attention
  BeginOidcLogin: state,nonce,codeVerifier → orch_txn cookie → 302 IdP /authorize?...&code_challenge=S256(v)
  IdP authenticates → 302 /auth/callback?code&state
  CompleteOidcLogin:
    verify state == txn.state                          → BadState
    Egress.fetch(token_endpoint, code, code_verifier)  → EgressBlocked | CodeExchangeFailed
    verify iss, aud, exp (±clockSkew), nonce, signature (JWKS) → SignatureInvalid | BadNonce | ...
    users.upsert by (issuer, sub); status=deactivated  → UserDeactivated (audited, 403)
    mapClaimsToRoles(claims, roleMapping)              → NoRoleForUser (audited, 403)
    diff roles → RoleAssignmentRepository.assign/revoke → auth.roles_changed
    AuthSessionRepository.create → Set-Cookie orch_sid  → 302 returnTo
every request: cookie-session → AuthSession (not revoked, idle+absolute ok) → touch(idleExpiresAt) → Actor
idleTtl/2 elapsed and refresh_token present → RefreshAuthSession (background, single-flight per session)
    refresh fails with invalid_grant → revoke session → next request 401 → login
POST /auth/logout → revoke + clear cookie → optional 302 end_session_endpoint?id_token_hint=…
```

## 5. Tasks
- [ ] `packages/core/src/auth/claim-mapping.ts` with `mapClaimsToRoles` + `ClaimMappingError`; table-driven tests to 100 % branch coverage.
- [ ] `infrastructure/egress/egress.service.ts` (config-driven host allowlist, https rule, timeouts, redirect and size caps) + ESLint allowlist entry for this path only.
- [ ] `OidcPort` + `OpenIdClientAdapter` (`openid-client` v6): discovery, PKCE, code exchange, refresh, end-session URL; all results as `Result`.
- [ ] Migration `0091_oidc_sessions` (tables, `users.external_issuer`, indices); Kysely + in-memory `AuthSessionRepository`.
- [ ] Use cases `BeginOidcLogin`, `CompleteOidcLogin`, `RefreshAuthSession`, `EndAuthSession`, `ResolveActorFromCookie`, `TestOidcConfig`.
- [ ] `cookie-session` strategy registered in `AuthStrategyRegistry` (M9-01); CSRF header check; same-origin check for WS/`/term` upgrades.
- [ ] `/auth/*` controller with Zod-validated query/body, rate limiting, signed `orch_txn` cookie.
- [ ] Config schema additions + boot assertions (https issuer in prod, secret from env only, redirect URI same-origin).
- [ ] Role re-sync on login and refresh with `auth.roles_changed` events and audit rows; revoke sessions on `DeactivateUser` (M9-01 use case gains a hook).
- [ ] Web: login screen, callback screen with per-error copy, expiry banner, sign-out menu, EN/AR strings.
- [ ] `orch auth test-oidc` with `--claims <file>` role-mapping preview.
- [ ] `deploy/compose/team.yaml` Dex service + `dex-config.yaml` with `alice`/`bob`/`carol` and the three groups (shared with M9-06).
- [ ] Docs `docs/deployment/oidc.md` (Dex, Keycloak, Okta, Entra ID, Google Workspace; group claim names per IdP; troubleshooting table keyed by `OidcError.code`).
- [ ] Re-run M0–M8 E2E in `auth.mode: local` to prove no regression.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-02-01 | unit | `mapClaimsToRoles` over the matrix: array claim, string claim, no match + default, no match + no default, admin entry with `allowAdminFromIdp:false` | matches spec; `NoRoleForUser` / `AdminFromIdpBlocked`; 100 % branches |
| UT-M9-02-02 | unit | session lifetime rules: idle expiry, absolute expiry, revoked, deactivated user | each yields `Unauthorized` with a distinct reason |
| AT-M9-02-01 | application | `CompleteOidcLogin` with a token whose `nonce` differs from the txn cookie | `Err(BadNonce)`, no user row created, `auth.login_failed` recorded |
| AT-M9-02-02 | application | `CompleteOidcLogin` twice for an existing user whose IdP groups changed leads→viewers | roles revoked/assigned; one `auth.roles_changed` event with before/after |
| IT-M9-02-01 | integration | full login against a Dex container (Testcontainers): `/auth/login` → IdP → `/auth/callback` → `GET /sessions` 200 | cookie set httpOnly+SameSite=Lax; `/auth/session` returns mapped roles |
| IT-M9-02-02 | integration | egress guard: point `auth.oidc.issuer` at an allowed host but let the IdP redirect the token request to another host | `EgressBlocked`; no request leaves to the second host (recorded by a local proxy) |
| IT-M9-02-03 | integration | refresh path: expire the access token, wait past `idleTtl/2`, issue a request | session refreshed once (single-flight), `auth.session_refreshed` emitted, request succeeds |
| IT-M9-02-04 | integration | tokens never reach a child process: start a FakeProvider session while logged in via OIDC | launcher env contains no `orch_sid`/`id_token`/`refresh_token` value (byte-scan of `childEnv()`) |
| E2E-M9-02-01 | e2e | Playwright with Dex: alice (leads group) and bob (viewers group) log in in two contexts; bob's Start-session button disabled, forced call 403 | UI and server agree; audit shows one denied row |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-02-01 | First OIDC login | 1. `docker compose -f deploy/compose/team.yaml up -d dex`. 2. Set `auth.mode: team`, `auth.oidc.issuer: http://localhost:5556/dex`, client id/secret via env. 3. Start daemon, open `http://localhost:4300/missions` in a clean profile. 4. Log in as `alice`. | Browser is redirected to Dex, then back to `/missions` (not `/attention`); `/auth/session` shows `alice` with role `lead`; `users` row has `external_issuer`+`external_subject`; `auth.login_succeeded` in the audit log. | ⬜ |
| TC-M9-02-02 | Group change takes effect | 1. Logged in as `bob` (viewers → Viewer). 2. Move `bob` to `orchestra-leads` in the Dex config and restart Dex. 3. Sign out and sign in again. | Bob's roles change to `lead` without an Admin action; one `auth.roles_changed` event with `before:['viewer'] after:['lead']`. | ⬜ |
| TC-M9-02-03 | Negative: tampered ID token / bad nonce | 1. Start a login, capture the callback URL. 2. Replay the same `code`+`state` in a second browser after the first login completed. 3. Separately, hand-edit the `orch_txn` cookie's nonce and complete a fresh login. | Replay → 400 `CodeExchangeFailed` (IdP rejects used code); edited nonce → 400 `BadNonce`; no cookie issued in either case; two `auth.login_failed` rows with distinct reasons; nothing logged contains the raw token (grep the log file). | ⬜ |
| TC-M9-02-04 | Negative: user with no mapped group | 1. Add a Dex user `dave` in no Orchestra group. 2. Log in as `dave`. | Login refused with a readable page ("Your account is not assigned to an Orchestra role — ask an administrator"); HTTP 403; `auth.login_failed{reason:'NoRoleForUser'}`; no `users` row is left in an authenticated state. | ⬜ |
| TC-M9-02-05 | Logout and back-button | 1. Log in as `alice`. 2. Sign out. 3. Press the browser back button and reload a protected screen. 4. Check Dex's session. | Cookie cleared; protected screen redirects to login; with `rpInitiatedLogout: true` the Dex session is ended too, so re-login asks for credentials again. | ⬜ |
| TC-M9-02-06 | Resilience: daemon restart mid-session and mid-login | 1. Log in as `alice`; open a FakeProvider session with a pending prompt. 2. `kill -9` the daemon and restart it. 3. Reload the UI. 4. Start a new login in a second profile, then restart the daemon *between* the IdP redirect and the callback. | After (2)(3) Alice is still signed in (server-side session survives in the DB) and the prompt is still open (M5-05); the login interrupted in (4) still completes because `orch_txn` lives in the cookie, not in daemon memory. | ⬜ |
| TC-M9-02-07 | IdP unreachable | 1. Stop the Dex container. 2. Reload the UI as a signed-in user. 3. Open a private window and try to log in. | Signed-in user keeps working until `idleTtl` (refresh failures are logged, session not dropped on a single failure); new login shows "Identity provider unreachable" with `DiscoveryFailed`, not a stack trace; daemon stays healthy (`/health` 200). | ⬜ |
| TC-M9-02-08 | Local mode unaffected | 1. Set `auth.mode: local`. 2. Restart the daemon. 3. Use the UI and `orch fleet`. | No redirect; local token works; `/auth/config` reports `oidcEnabled: false`; all M0–M8 E2E suites green. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Authorization Code + PKCE login works end to end against Dex in CI (IT-M9-02-01) and against at least one real IdP by hand (record which in the log).
- [ ] Group/claim → role mapping is a pure, 100 %-branch-covered rule; roles are re-synced on every login and refresh; `allowAdminFromIdp` defaults to `false`.
- [ ] Session cookie is httpOnly + SameSite=Lax (+ Secure outside localhost), carries only an opaque id, and is backed by a revocable server-side record.
- [ ] Every outbound request to the IdP goes through `infrastructure/egress` with an allowlisted host; no other module gains `fetch` access (ESLint + egress test green, C2 intact).
- [ ] OIDC tokens never appear in logs, events, audit payloads, or a child process environment (IT-M9-02-04 plus a log grep in TC-M9-02-03).
- [ ] Failed logins are audited with a reason and rate-limited; deactivated users are refused and their sessions revoked.
- [ ] `auth.mode: local` is byte-for-byte unchanged in behaviour: all M0–M8 E2E suites green.
- [ ] All TC-M9-02-* pass and are recorded.
- [ ] No new lint/arch violations (`dependency-cruiser`, ESLint `no-vendor-endpoints`, `packages/core` still dependency-free).
- [ ] `docs/deployment/oidc.md` written with per-IdP group-claim notes; `PROGRESS.md` updated.

## 8. Risks / open questions
- The group claim name differs per IdP (`groups`, `roles`, `cognito:groups`, Entra ID's `groups` returning object ids rather than names). The mapping config is claim-name agnostic, but the docs must give a per-IdP recipe, and Entra's id-vs-name problem may need a `match: 'equals'` on GUIDs (verify with a real tenant).
- `openid-client` v6 API names used above (`allowInsecureRequests`, discovery helper signatures) are from memory — verify against the installed version's docs on day 1 and adjust the adapter (verify).
- Entra ID and Okta may not return `offline_access` unless configured; without a refresh token the session simply ends at `idleTtl` — acceptable, but the UX banner must not look like an error (verify with the first team user).
- Cookie + `SameSite=Lax` and the WS upgrade: some reverse proxies strip `Origin`; the same-origin check may need a configurable trusted-origins list for Cloudflare Tunnel setups from M7-04 (verify).
- `auth_sessions` and `auth_login_attempts` are not in `04-domain-model.md` §4 — the domain model doc needs an update (not done here), as already flagged by M9-01 for `user_roles`/`api_tokens`.
- Storing a refresh token at all is a liability; the column is added now but left null until M9-09 decides on column encryption. If M9-09 chooses "no encryption", consider dropping refresh support and relying on short sessions (open question for M9-09).
- Clock skew between daemon and IdP in containers (M9-06) can cause `TokenExpired` storms; `clockSkewSeconds` defaults to 60 but NTP guidance belongs in the deployment docs.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
