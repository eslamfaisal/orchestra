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
| C11 | **Antigravity**: never proxy/borrow OAuth, never hit the Service backend; adapter **gated** (ToS unresolved), not merely opt-in | gate check + adapter flag + `tos_acknowledged_at` (M1-07); see note 2 |
| C12 | Repair Agent cannot modify auth, ToS rules, allowlist, ESLint rules | path-based guard + CODEOWNERS (M10-01) |
| C13 | Secrets never stored; scrubbed from recordings at capture time | capture-time regex redaction (M5-01), manual redaction (M5-06) |

## Notes on C1–C3 (why these rules are shaped the way they are)

**1. Hosting an unmodified vendor binary (C1, C3, C4).** Claude Code's official legal documentation permits an end user to authenticate to an **unmodified** Claude Code binary hosted by another platform, subject to its stated conditions. That is the legal basis for C1's native-binary approach: Orchestra launches the vendor's own binary, unmodified, with the user's own login. It is **not** permission to collect, store or forward the user's credentials (C3), and **not** permission to resell or pool their usage (C4). If a future change made Orchestra modify the binary or mediate the login, C1 would no longer hold and the approach would need a new ADR.

**2. Antigravity is gated, not opt-in (C11).** The published Antigravity terms §6 contains broad third-party-access restrictions, and enterprise access may be governed by different terms. **The documentation does not settle whether Orchestra's exact wrapper is permitted**, and an in-product acknowledgement checkbox does not resolve that question — it records the user's consent, not the vendor's. Therefore ADR-008 (amended) gates the adapter: it may not be built until (a) a written terms resolution is recorded in `DECISIONS.md` and (b) the provider has an evidence-matrix row set (`14-provider-evidence-matrix.md`). Tracked as R17. No step, milestone README, acceptance criterion or test may require the `agy` adapter; phrasing is always "the required adapters (claude, codex) plus any enabled optional adapter".

**3. Reading provider config is not the same as not persisting secrets (C3).** "Never persists or exposes credentials" and "never reads credential bytes" are different guarantees, and only the second one survives contact with a config file: parsing a file that contains an API key reads that key into process memory before any field is dropped. Order of preference, strongest first:
1. **Provider-produced projection** — ask the CLI for what we need (e.g. a `list-models` command) and never open its config at all. This is the required approach for OpenCode (M10-05) and the default for any provider that offers it.
2. **Schema-gated parse** — where a config file genuinely must be read, parse it through a Zod schema that **drops secret-shaped keys at parse time** (`.strip()` plus an explicit deny-list of `token|secret|key|cookie|authorization|password`), so no secret-shaped value is ever bound to a variable, returned from the parser, serialized, or written to a log. Raw file content is never logged at any level, never attached to an error, and never included in a fixture.
3. Never: reading a vendor credential store, or a config file whose only purpose is credentials (banned outright by C4).
The claim in `SECURITY.md` must be worded as "Orchestra never persists or exposes provider credentials", with the residual limitation stated, rather than the stronger claim we cannot make.

## Never built
Token proxies · account switchers · quota tricks · private usage readers · vendor-client impersonation · anything that reads vendor credential stores.

## Supply-chain controls (why they matter here)
2026 npm worms specifically target `.claude/` and agent config directories. Therefore: pinned + integrity-checked deps, `pnpm` with `minimumReleaseAge`, npm provenance on our packages, Sigstore-signed releases, SLSA provenance, SBOM, OpenSSF Scorecard ≥ 7 in CI (M0-08, M10-08). The allowlist and ESLint bans are security controls, not style.

## Data handling
- Everything stays on the user's infra. No telemetry leaves the host unless the user opts into anonymised drift/outcome sharing (M10-02).
- Recordings and DB are user-owned files; retention TTL and purge are user-controlled (M5-06).
