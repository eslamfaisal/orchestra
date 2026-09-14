# Step M7-04 — Remote access & auth

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M0-04, M0-06, M0-08 |
| Estimated effort | 1.5 days |
| Packages touched | `apps/daemon` (`src/interface/http/auth`, `src/application/auth`, `src/infrastructure/auth`, config schema), `apps/web` (sign-in / re-pair screen, Settings → Remote access), `apps/cli` (`orch token …`), `docs/deployment/remote-access.md`, `SECURITY.md` |
| Risk | High (this is the step that can expose a machine that runs arbitrary code) |
| Owner | |

## 1. Goal
The fleet becomes reachable from outside the machine **without the daemon ever leaving `127.0.0.1`**. This step ships: an auth module refactored behind a pluggable `AuthStrategy` interface (local token today, OIDC dropped in at M9-02 with no call-site changes), token rotation with a grace window (`orch token rotate`), rate limiting and lockout on the auth surface, strict origin/CORS rules that admit a tunnel hostname without admitting the whole internet, and two tested, written-down recipes — **Tailscale** (including Serve and, with warnings, Funnel) and **Cloudflare Tunnel** — plus the TLS termination and secure-context guidance the PWA (M7-03) and multi-host (M7-05) both depend on.

## 2. Why
- **03-architecture.md §7** is unambiguous: "Daemon binds `127.0.0.1` only. Remote access = Tailscale / Cloudflare Tunnel in front (M7-04)." Source plan §14 repeats it. This step implements that boundary rather than negotiating with it.
- **D1/G1**: the PWA and the multi-host UI are worthless if they cannot reach the daemon; every other M7 step assumes this one.
- **C3**: "Auth only inside official login flows; tokens never seen/stored/forwarded" applies to *vendor* credentials; Orchestra's own device token is a different asset, and this step is where its lifecycle (issue, rotate, revoke, expire) becomes real instead of "a file generated once".
- **C10**: every mutating call is already audited (M0-04); remote access makes the `actor` and source address of that audit meaningful, so the audit record gains the device identity established here.
- **G4/G1**: a prompt answered from the phone travels this path; its latency and reliability are this step's responsibility.
- **R9**: an AI coding daemon with shell access is a high-value target. Defaults must fail closed: no listening on `0.0.0.0`, no wildcard CORS, no token in a query string that lands in a proxy log, and a documented, fast revocation.

## 3. Scope
### In scope
- `AuthStrategy` port + registry (DI map, per 09-engineering-standards "strategies, not switches"); `LocalTokenStrategy` implemented; `OidcStrategy` registered as a stub that returns `not-configured`.
- Multi-token model: the single `~/.orchestra/token` becomes a set of named device tokens in a new `access_tokens` table, with the legacy file kept as the bootstrap/admin token for CLI compatibility.
- `orch token list|create|revoke|rotate|show` (CLI surface finalised in M7-06; the daemon endpoints and one-shot commands land here).
- Rotation with a configurable grace window: the previous token stays valid for `graceSeconds` (default 0 for `rotate --now`, 300 for `rotate`), then hard-fails; every 401 caused by rotation carries `code: TOKEN_ROTATED` so clients can show "re-pair" instead of "server error".
- Rate limiting + lockout on `/api/v1/auth/*`, `/api/v1/pair/*` and on any request with a bad credential: token-bucket per source address, exponential lockout, `429` with `Retry-After`, audited.
- Origin / CORS policy: `remote.allowedOrigins` config (exact hostnames, no wildcards), `Origin` checked on both HTTP and the WS upgrade, `Sec-WebSocket-Protocol`-based token passing preferred over `?token=` for `/ws` and `/term` where the client supports it (with `?token=` kept for the CLI and documented as a lower-tier option).
- Security headers on the served web app: `Strict-Transport-Security` (when behind TLS), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Frame-Options: DENY`, and a CSP that permits only the daemon origin plus `wss:` to itself.
- Trusted-proxy handling: `remote.trustedProxyHeader` (off by default) so `X-Forwarded-For` is only honoured when the operator opts in, keeping rate limiting and audit addresses honest.
- `docs/deployment/remote-access.md`: Tailscale (tailnet + `tailscale serve` for HTTPS on a `*.ts.net` name; **Funnel** covered with an explicit "this publishes to the internet" warning and a hardening checklist), Cloudflare Tunnel (`cloudflared` config, Access policy strongly recommended), and a "do not do this" section (port forwarding, `--host 0.0.0.0`, reverse proxy without auth).
- An automated test asserting the daemon never binds a non-loopback interface, in CI.
### Out of scope (deferred to …)
- OIDC login, session cookies, group→role mapping — **M9-02** (this step only fixes the seam).
- RBAC / per-user permissions — **M9-01**; until then every valid token is fully privileged and the docs say so.
- Immutable, hash-chained audit and SIEM export — **M9-03**.
- Shipping or supervising a tunnel binary (`tailscaled`, `cloudflared`) from inside Orchestra — never; they are the user's own tools, installed and run by the user.
- mTLS / client certificates — not planned before 1.0.
- Multi-host registry and cross-host auth — **M7-05** (it consumes the token model defined here).
- Encryption at rest for the token table — **M9-09**.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
```ts
// packages/core/src/auth/access-token.ts
export interface AccessToken {
  id: string;                 // ULID, also the token's public prefix
  label: string;              // "iPhone", "laptop CLI", "bootstrap"
  hash: string;               // argon2id of the secret; the secret itself is never stored
  scope: 'admin';             // only value until M9-01
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;         // optional TTL
  revokedAt?: string;
  supersededBy?: string;      // set during rotation
  graceUntil?: string;        // valid but deprecated until this instant
}
export type AuthResult =
  | { ok: true; tokenId: string; label: string; strategy: 'local-token' | 'oidc' }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'rotated' | 'rate-limited' };
```
Rules (pure, 100 % branch coverage — these are security rules, so the coverage requirement of 10-testing-strategy.md applies):
- A token string is `orch_<tokenId>_<48 random base64url chars>`; the id prefix makes lookup O(1) without a full-table scan and makes accidental pastes traceable without revealing the secret.
- Verification is constant-time on the hash comparison; an unknown id performs a dummy hash so timing does not distinguish "unknown id" from "wrong secret".
- `revokedAt` set ⇒ always invalid. `expiresAt` in the past ⇒ invalid. `graceUntil` in the future ⇒ valid but the response carries `Warning: token-rotated`. `graceUntil` in the past ⇒ `rotated` (a distinguishable 401 so the UI can say "re-pair", not "something went wrong").
- Rotation never deletes: the old row is marked `supersededBy` + `graceUntil`, so the audit trail explains every 401 that follows.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/auth/auth-strategy.port.ts
export interface AuthStrategy {
  readonly id: 'local-token' | 'oidc';
  readonly kind: 'bearer' | 'session';
  /** Extract + verify credentials from an inbound request or WS upgrade. */
  authenticate(ctx: AuthContext): Promise<Result<AuthResult, DomainError>>;
  /** Routes this strategy needs mounted (login, callback, logout). Empty for local-token. */
  routes?(): AuthRoute[];
  /** Human-readable configuration state, surfaced by `orch doctor` and Settings. */
  describe(): { configured: boolean; detail: string };
}
export interface AuthContext {
  header?: string;             // Authorization
  wsProtocols?: string[];      // Sec-WebSocket-Protocol values
  query?: Record<string, string>;
  origin?: string;
  remoteAddress: string;       // post-trusted-proxy resolution
}
```
```ts
// REST (all under /api/v1)
// GET    /auth/state            → { strategy, configured, tokenLabel, graceWarning? }
// GET    /auth/tokens           → AccessToken[] (no hashes, no secrets)
// POST   /auth/tokens           { label, expiresInDays? } → 201 { token: '<shown once>', id }
// DELETE /auth/tokens/:id       → 204
// POST   /auth/tokens/rotate    { graceSeconds? } → 200 { token: '<shown once>', id, graceUntil }
// 401 body: { error: { code: 'UNAUTHENTICATED' | 'TOKEN_ROTATED' | 'TOKEN_REVOKED' | 'TOKEN_EXPIRED', message } }
// 429 body: { error: { code: 'RATE_LIMITED', message } } + Retry-After
```
WS credential passing, in preference order:
1. `Sec-WebSocket-Protocol: orchestra.bearer.<token>` (browsers can set subprotocols; the daemon echoes the accepted subprotocol) — keeps the secret out of the URL.
2. First-message `{ type: 'auth', token }` (already in the M0-06 schema).
3. `?token=` — supported for `orch` and `curl`, **logged as a warning**, and documented as unsuitable behind proxies that log query strings.
`/term` (M1-09) uses the same order; its 4401 close code is retained.

### 4.3 Data / schema changes
New migration `00NN_access_tokens.ts` (Postgres-compatible):
```
access_tokens(
  id text primary key, label text not null, hash text not null, scope text not null default 'admin',
  created_at text not null, last_used_at text, expires_at text, revoked_at text,
  superseded_by text, grace_until text
)
auth_attempts(                            -- rate limiting + lockout, pruned by TTL
  id text primary key, ts text not null, remote_address text not null,
  token_id text, outcome text not null    -- ok | unknown | revoked | expired | rotated | malformed
)
```
Boot migration: if `~/.orchestra/token` exists and `access_tokens` is empty, import it as the `bootstrap` row (hashing the existing secret) so nothing that worked in M0–M6 breaks. New events: `auth.token_created`, `auth.token_revoked`, `auth.token_rotated`, `auth.rate_limited` (under the existing `audit.*` discipline — actor, before/after redacted).

### 4.4 Infrastructure (network, tunnels, TLS)
**Bind invariant.** The Fastify listen call is `{ host: '127.0.0.1', port }` with no config key that can change it. `remote.bindAddress` deliberately does not exist. An integration test boots the daemon and asserts `lsof`/`netstat` shows no non-loopback listener; a second test asserts the string `0.0.0.0` appears nowhere in `apps/daemon/src` outside comments.

**Recipe A — Tailscale (recommended default).**
```
tailscale up                                  # both devices on the same tailnet
tailscale serve --bg --https=443 127.0.0.1:4300
# → https://<machine>.<tailnet>.ts.net  (valid cert, secure context, tailnet-only)
```
Properties: WireGuard-encrypted, device-authenticated by the tailnet, never reachable from the public internet, TLS certificate issued for the `ts.net` name (which satisfies the PWA's secure-context and service-worker requirements). `remote.allowedOrigins` gets that exact hostname. ACLs can restrict which tailnet devices reach port 443.
**Funnel** (`tailscale funnel`) publishes the same service to the public internet; the doc covers it under a boxed warning with a mandatory checklist: a dedicated non-bootstrap token, a short `expiresInDays`, `remote.allowedOrigins` locked to the funnel hostname, rate limits left at defaults, and the reminder that anyone with the token can run code on the machine.

**Recipe B — Cloudflare Tunnel.**
```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: orchestra.example.com
    service: http://127.0.0.1:4300
    originRequest: { noTLSVerify: false, connectTimeout: 10s }
  - service: http_status:404
```
Strongly recommended addition: a **Cloudflare Access** application in front of the hostname (email OTP or IdP), so the Orchestra token is a second factor rather than the only one. The doc shows the Access policy and notes that Access injects `Cf-Access-Jwt-Assertion`, which M9-02's OIDC strategy can later validate. WebSockets must be enabled on the zone (they are by default) — "(verify)". `remote.trustedProxyHeader: 'cf-connecting-ip'` is the supported opt-in here.

**Anti-recipes** (explicitly documented as unsupported): router port-forwarding to 4300; `ssh -R` to a VPS without auth in front; any reverse proxy configured with `proxy_pass` and no credential check; sharing one token across people (C4's spirit: one identity per human, and M9-01 makes it enforceable).

**TLS termination** is always at the tunnel, never in the daemon: the daemon has no certificate configuration and no HTTPS listener. The doc states the consequence — the loopback hop is plaintext, which is acceptable because it never leaves the host, and anything that changes that (binding a LAN address) is out of contract.

**Rate limiting** is an in-process token bucket keyed by resolved remote address: 10 auth failures per minute, then a lockout doubling from 30 s to a 15 min cap; successful auth resets the bucket. `/api/v1/pair/*` gets a stricter bucket (5/min). Buckets are also written to `auth_attempts` so `orch doctor` and the Health screen can show "N failed auth attempts in the last hour" — an early signal of an exposed instance.

### 4.5 API / UI surface
- Routes as listed in §4.2; `GET /health` stays public (M0-04) but now returns only `{status, version}` when the request has no valid credential — no host name, no session counts, nothing an unauthenticated scanner can inventory.
- Web: a **Sign in / Re-pair** screen shown on `TOKEN_ROTATED`/`TOKEN_REVOKED`/`TOKEN_EXPIRED` (token field + QR-scan hint), and Settings → **Remote access**: current strategy, device-token list (label, created, last used, expiry, Revoke), **Create token**, **Rotate bootstrap token**, "Pair a device" QR (M7-03), allowed origins, recent failed-auth count, and a copy-ready snippet for each recipe.
- CLI (endpoints here, full command surface in M7-06): `orch token show|list|create --label <l> [--expires-in-days n]|revoke <id>|rotate [--now|--grace <s>]`.
- `orch doctor` gains `auth.strategy`, `auth.token_expiry` (warn < 7 days), `auth.bind_address` (fail if anything but loopback), `auth.failed_attempts` (warn over threshold).

### 4.6 Flow / sequence
```
REQUEST AUTH
 inbound HTTP/WS → resolve remoteAddress (trustedProxyHeader only if configured)
 → rate-limit bucket check ──over limit──▶ 429 + Retry-After + audit auth.rate_limited
 → origin check (HTTP Origin / WS upgrade Origin) against remote.allowedOrigins
        mismatch ▶ 403 ORIGIN_NOT_ALLOWED (loopback origins always allowed)
 → AuthStrategyRegistry.active().authenticate(ctx)
        ok      ▶ attach {tokenId,label} to the request context (audit actor) → handler
        rotated ▶ 401 TOKEN_ROTATED    (client shows "re-pair")
        other   ▶ 401 UNAUTHENTICATED  + auth_attempts row

ROTATION
 orch token rotate --grace 300
 → POST /auth/tokens/rotate → new row created, old row gets supersededBy + graceUntil(now+300s)
 → new secret printed ONCE to stdout (and written to ~/.orchestra/token when rotating bootstrap)
 → old token keeps working for 300 s with a `Warning` header; UIs show a banner "token rotated — update this device"
 → after graceUntil: 401 TOKEN_ROTATED; the phone shows the re-pair screen (TC-M7-03-08)
```

## 5. Tasks
- [ ] Extract the M0-04 `AuthGuard` into `AuthStrategy` + `AuthStrategyRegistry`; move the existing token check into `LocalTokenStrategy`; register an `OidcStrategy` stub returning `not-configured`; no behaviour change for existing callers (regression suite from M0-04 must stay green untouched).
- [ ] Migration `00NN_access_tokens` + `auth_attempts`; bootstrap import of `~/.orchestra/token`.
- [ ] Token format, argon2id hashing, constant-time verification with dummy-hash on unknown id; rules module with 100 % branch coverage.
- [ ] Token CRUD + rotation endpoints with grace handling and one-time secret display; `Warning` header during grace.
- [ ] Distinguishable 401 codes (`TOKEN_ROTATED` / `TOKEN_REVOKED` / `TOKEN_EXPIRED` / `UNAUTHENTICATED`) mapped through the M0-06 error envelope.
- [ ] Rate limiter + lockout + `auth_attempts` persistence + pruning job; `429` with `Retry-After`.
- [ ] Origin/CORS policy for HTTP and the WS upgrade; `remote.allowedOrigins` config with a startup validation that rejects `*`.
- [ ] `Sec-WebSocket-Protocol` credential path for `/ws` and `/term`; keep `?token=` with a warning log; update the M1-09 client.
- [ ] Security headers + CSP for the served web app; HSTS only when `remote.publicOrigin` is https.
- [ ] Trusted-proxy handling (off by default) and its effect on rate limiting and audit addresses.
- [ ] Unauthenticated `/health` response reduction.
- [ ] `orch token …` commands (thin, finalised in M7-06) + `orch doctor` auth checks.
- [ ] Web: Sign in / Re-pair screen; Settings → Remote access pane (EN/AR).
- [ ] Bind-invariant tests (runtime listener assertion + source scan) wired into CI.
- [ ] `docs/deployment/remote-access.md` (Tailscale, Tailscale Serve, Funnel + warning box, Cloudflare Tunnel + Access, anti-recipes, TLS rationale, incident procedure "I think my token leaked"); link it from `SECURITY.md`.
- [ ] Run both recipes end-to-end on the dev machine and record the exact commands and outputs in `evidence/`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-04-01 | unit | token rules matrix: valid / revoked / expired / in-grace / past-grace / unknown-id / malformed | exactly the `AuthResult.reason` values in §4.1; 100 % branch coverage on the rules module |
| UT-M7-04-02 | unit | timing: verification of an unknown token id vs a known id with a wrong secret (1 000 samples) | mean durations within 10 %; no early return before the dummy hash |
| UT-M7-04-03 | unit | rate limiter: 10 failures then a success, then 11 failures | lockout after the 10th, reset by the success, doubling backoff capped at 15 min |
| UT-M7-04-04 | unit | origin policy: exact match, subdomain, wildcard config, loopback, missing Origin | wildcard rejected at config load; subdomain not matched; loopback always allowed; missing Origin allowed for non-browser clients only when no `Sec-Fetch-Mode: cors` is present |
| IT-M7-04-05 | integration | **bind invariant**: boot the daemon, enumerate listeners | only `127.0.0.1:<port>`; a second assertion scans `apps/daemon/src` for non-loopback bind strings |
| IT-M7-04-06 | integration | rotation with `graceSeconds: 2`: request with the old token at t+0 and t+3 | 200 with `Warning: token-rotated`, then 401 `TOKEN_ROTATED`; both audited |
| IT-M7-04-07 | integration | WS upgrade with the token in `Sec-WebSocket-Protocol`, in the first message, in `?token=`, and absent | first three connect (the third logs a warning); the fourth closes 4401 |
| IT-M7-04-08 | integration | revoked token on an **already open** WS connection | the connection is closed within one heartbeat (15 s) with 4401; a reconnect is refused |
| IT-M7-04-09 | integration | unauthenticated `GET /health` and `GET /api/v1/hosts/me` | health returns `{status,version}` only; the API route returns 401 with no host details in the body |
| E2E-M7-04-10 | e2e | UI flow: rotate the token in one tab while another tab is open | the second tab shows the re-pair screen within one request cycle, keeps cached data, and recovers after the new token is entered |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-04-01 | Tailscale Serve recipe | 1. Follow `docs/deployment/remote-access.md` §Tailscale exactly 2. Open `https://<machine>.<tailnet>.ts.net` from the phone on LTE | Page loads over valid TLS; sign-in works; terminals stream; the doc needed no undocumented extra step (fix the doc if it did) | ⬜ |
| TC-M7-04-02 | Cloudflare Tunnel recipe | 1. Follow the Cloudflare section incl. the Access policy 2. Open the hostname from a device outside the tailnet | Access challenges first, then Orchestra's sign-in; WS and `/term` both work through the tunnel; `orch fleet --host https://<hostname>` works with the token | ⬜ |
| TC-M7-04-03 | Bind invariant under a tunnel | 1. With both tunnels running, run `lsof -nP -iTCP -sTCP:LISTEN \| grep -i orchestrad` 2. From another LAN device, try `http://<mac-lan-ip>:4300` | Only `127.0.0.1:4300` listed; the LAN attempt is refused (connection refused, not a 401) | ⬜ |
| TC-M7-04-04 | Token rotation round-trip | 1. `orch token rotate --grace 300` 2. Use the old token immediately 3. Wait 5 min, use it again 4. Update the phone and the CLI | Old token works during grace with a warning; fails afterwards with `TOKEN_ROTATED`; both devices recover after re-pairing; `auth.token_rotated` in the audit log | ⬜ |
| TC-M7-04-05 | Immediate revocation | 1. `orch token create --label temp` 2. Use it from the phone 3. `orch token revoke <id>` while a `/ws` and a `/term` connection are open | Both sockets close within 15 s; the next HTTP call is 401 `TOKEN_REVOKED`; the Mac's own session is unaffected | ⬜ |
| TC-M7-04-06 | **Negative — expired token** | 1. `orch token create --label short --expires-in-days 0` (expires immediately) 2. Use it | 401 `TOKEN_EXPIRED` with a distinct message; the UI offers re-pair rather than a generic error; Settings shows the token as expired | ⬜ |
| TC-M7-04-07 | **Negative — brute force** | 1. `for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer orch_bad_$i" https://<host>/api/v1/hosts/me; done` | 401s until the limit, then 429 with `Retry-After`; lockout visible in Settings → Remote access "failed attempts"; legitimate requests from the Mac (loopback) are unaffected | ⬜ |
| TC-M7-04-08 | **Negative — wrong origin** | 1. From a page on another origin, `fetch('https://<host>/api/v1/hosts/me', {credentials:'include'})` 2. Attempt a `/ws` upgrade with a forged Origin | Both rejected (403 `ORIGIN_NOT_ALLOWED` / upgrade refused); the rejection is audited with the offending origin | ⬜ |
| TC-M7-04-09 | **Negative — token in a proxy log** | 1. Connect the PWA and inspect the Cloudflare/`tailscale serve` access logs | No `?token=` in any logged request line from the browser (the subprotocol path is used); if `?token=` appears for a CLI call, the daemon logged the warning | ⬜ |
| TC-M7-04-10 | **Resilience — tunnel drops** | 1. With the phone connected, stop `cloudflared` / `tailscale serve` 2. Wait 30 s 3. Restart it | The phone shows offline state and keeps cached data (M7-03); on restart the WS reconnects with `sinceEventId` and no prompt is lost; no re-pairing required | ⬜ |
| TC-M7-04-11 | **Resilience — daemon restart with remote clients** | 1. Phone and desktop connected over the tunnel 2. `kill -9` the daemon, restart it | Both clients reconnect and re-authenticate with the same tokens; `auth_attempts` shows no failures; restore banner appears | ⬜ |
| TC-M7-04-12 | Doctor signals | 1. Create a token expiring in 3 days 2. Generate 15 failed auth attempts 3. `orch doctor` | `auth.token_expiry: warn` naming the token; `auth.failed_attempts: warn` with the count and window; `auth.bind_address: pass` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `AuthStrategy` port + registry in place; `LocalTokenStrategy` is the only active strategy; the OIDC stub proves the seam without shipping behaviour (M9-02 must not need to touch call sites).
- [ ] Named device tokens with create / list / revoke / rotate (with grace), argon2id hashes, one-time secret display, and distinguishable 401 codes.
- [ ] The daemon binds loopback only, proven at runtime and by source scan in CI (IT-M7-04-05); no config key exists that could change it.
- [ ] Rate limiting + lockout on the auth surface, persisted and surfaced in `orch doctor` and Settings.
- [ ] Origin/CORS rules admit exactly the configured tunnel hostnames plus loopback; wildcards are rejected at config load.
- [ ] WS credentials can be passed without putting the token in the URL, and the M1-09 client uses that path.
- [ ] Both recipes (Tailscale Serve, Cloudflare Tunnel) executed end-to-end by following only the written doc; the doc was corrected wherever it was insufficient (TC-01/02).
- [ ] `SECURITY.md` links the remote-access doc and states the single-user/full-privilege limitation until M9-01, plus the "my token leaked" procedure.
- [ ] All TC pass; no new lint/dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- This is the step most likely to produce a real-world incident. The mitigation is defaults that fail closed and documentation that names the dangerous paths explicitly rather than omitting them; Funnel in particular is documented **with** a warning rather than left out, because users will find it anyway.
- Until M9-01, every token is fully privileged — a read-only token for the phone would be a genuinely better default but requires the permission model. Recorded as an open question; if M9 slips, consider a minimal `scope: 'answer-only'` as a follow-up step.
- `Sec-WebSocket-Protocol` as a credential channel is a common pattern but not a standard one; browser and proxy behaviour must be confirmed through both tunnels — "(verify)". The first-message auth path stays as the fallback.
- Cloudflare Access injects its own JWT; validating it is deferred to M9-02, so today Access and Orchestra auth are independent layers. Document that revoking Access does not revoke the Orchestra token.
- Tailscale Serve certificate provisioning requires HTTPS to be enabled on the tailnet; if it is not, the PWA loses its secure context and M7-03's service worker will not register — call this out at the top of the Tailscale section "(verify current tailnet settings)".
- The in-process rate limiter is per-daemon and resets on restart; a determined attacker can reset it by crashing the daemon. Acceptable at this scale; M9-09 revisits with persistent counters.
- Trusted-proxy handling is a classic spoofing footgun (`X-Forwarded-For` from an untrusted source). Default off, and the config key documents that enabling it without a real proxy in front makes rate limiting bypassable.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
