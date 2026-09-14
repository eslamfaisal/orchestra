# 07 — "Official-only" compliance rules (enforced by code)

These are product requirements *and* security controls. They apply to every milestone. A PR that weakens one needs an ADR and CODEOWNERS approval.

| # | Rule | Enforcement (where in plan) |
|---|---|---|
| C1 | Only official binaries, launched per vendor docs | `BinaryRegistry` allowlist (M1-04); version verified at boot; Doctor (M6-01) |
| C2 | Zero direct vendor API calls from Orchestra code | custom ESLint rule `no-vendor-endpoints` + egress test (M0-08). Allowed egress: Web Push, OIDC, registries, update check, GitHub/GitLab PR API with the user's own credentials |
| C3 | Auth only inside official login flows; tokens never seen/stored/forwarded | `AuthProbe` returns status only; contract test asserts no secret-shaped fields; redacting serializer (M0-04) |
| C4 | One account per provider; no rotation/pooling/sharing | non-feature documented in `SECURITY.md` (M0-08); adapters never read credential stores (C3 tests); registry rejects artifacts declaring multi-account features (M10-03) |
| C5 | Rate limits respected | cooling until `resetAt` + backoff; max one retry per task per window (M4-03) |
| C6 | Concurrency within vendor allowances | `manifest.limits.maxConcurrentSessions` enforced by SessionSupervisor (M1-02) |
| C7 | No screen-scraping for state | only structured parsers (`TelemetryParser`); PTY bytes go to recording + xterm only; ESLint bans regex-over-PTY in adapters (M0-08) |
| C8 | Headless via documented flags only | typed argv builders; launcher contract test (M0-03) |
| C9 | CI never touches real accounts | `FakeProvider` + recorded fixtures; CI has no vendor credentials (M0-08) |
| C10 | Every spend/keys action previewed, permissioned, audited | guards + audit interceptor (M0-04) + UI preview (M1-09, M2-06) |
| C11 | **Antigravity**: never proxy/borrow OAuth, never hit the Service backend; adapter opt-in with in-product ToS acknowledgement | adapter flag + `tos_acknowledged_at` (M1-07) |
| C12 | Repair Agent cannot modify auth, ToS rules, allowlist, ESLint rules | path-based guard + CODEOWNERS (M10-01) |
| C13 | Secrets never stored; scrubbed from recordings at capture time | capture-time regex redaction (M5-01), manual redaction (M5-06) |

## Never built
Token proxies · account switchers · quota tricks · private usage readers · vendor-client impersonation · anything that reads vendor credential stores.

## Supply-chain controls (why they matter here)
2026 npm worms specifically target `.claude/` and agent config directories. Therefore: pinned + integrity-checked deps, `pnpm` with `minimumReleaseAge`, npm provenance on our packages, Sigstore-signed releases, SLSA provenance, SBOM, OpenSSF Scorecard ≥ 7 in CI (M0-08, M10-08). The allowlist and ESLint bans are security controls, not style.

## Data handling
- Everything stays on the user's infra. No telemetry leaves the host unless the user opts into anonymised drift/outcome sharing (M10-02).
- Recordings and DB are user-owned files; retention TTL and purge are user-controlled (M5-06).
