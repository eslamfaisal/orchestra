# Step M0-08 — CI & quality gates

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-01 (start), M0-03 (finish) |
| Estimated effort | 2 days |
| Packages touched | `.github/workflows`, `tools/eslint-rules`, repo root docs |
| Risk | Medium (these are security controls) |
| Owner | |

## 1. Goal
Every push and PR runs typecheck, lint (incl. two custom rules that encode compliance), dependency-cruiser, unit/application/contract/integration tests with coverage thresholds, Playwright E2E with FakeProvider, an egress test proving the daemon makes no vendor API calls, `pnpm audit`, SBOM generation and OpenSSF Scorecard. `SECURITY.md`, `CONTRIBUTING.md` (DCO), `CODEOWNERS` are complete. CI has no vendor credentials by construction.

## 2. Why
C2, C7, C9 (enforced by code, not review), `07-compliance-rules.md` supply-chain section (2026 npm worms), G7, `10-testing-strategy.md` CI gates.

## 3. Scope
### In scope
- Workflows: `ci.yml` (matrix Node 22/24, macOS + Ubuntu for tmux later), `e2e.yml`, `scorecard.yml`, `codeql.yml`, `dependency-review.yml`, `release.yml` (semantic-release dry-run until M10-07).
- Custom ESLint rules in `tools/eslint-rules`:
  - `no-vendor-endpoints`: flags string literals / template literals matching vendor API hosts (`api.anthropic.com`, `api.openai.com`, `chatgpt.com/backend-api`, `generativelanguage.googleapis.com`, `*.antigravity.google`, `api.moonshot.*`, `api.deepseek.com`) and any `fetch`/`http.request`/`undici` usage outside `apps/daemon/src/infrastructure/egress/**`.
  - `no-pty-regex-state`: in `packages/providers/**` flags `RegExp` / `.match(` / `.includes(` applied to identifiers named like `output|pty|screen|buffer` (screen-scraping guard); allowlisted in `TelemetryParser` for structured lines only.
- Egress test: run daemon + FakeProvider session under a network sandbox (`--experimental-network-inspection`/`nock` disallowNetConnect + `undici` global dispatcher mock) and assert only allowlisted hosts (`127.0.0.1`, registry placeholder) are contacted.
- Coverage thresholds wired (core 100 % on listed dirs; others ≥ 80 %).
- `pnpm audit --prod` gate, Renovate config (grouped weekly, `minimumReleaseAge`), CycloneDX SBOM artifact, provenance placeholder in `release.yml`.
- Docs: `SECURITY.md` (threat summary, report channel, SLA, non-features: token proxies/account rotation/quota tricks), `CONTRIBUTING.md` (DCO, step workflow from `plan/README.md`), `CODEOWNERS` final.
- Branch protection checklist (required checks list) documented.
### Out of scope (deferred)
- Real signing/provenance/Homebrew → M10-07. Fixture matrix per CLI version → M1-05..07 add jobs. Load tests → M5.

## 4. Design
### 4.1 Domain
n/a
### 4.2 Interfaces / contracts
```js
// tools/eslint-rules/no-vendor-endpoints.js (sketch)
module.exports = { meta: { type: 'problem', docs: { description: 'Orchestra never calls vendor APIs directly (C2)' } },
  create(ctx) { const banned = [/api\.anthropic\.com/, /api\.openai\.com/, /chatgpt\.com\/backend-api/, /generativelanguage\.googleapis\.com/, /antigravity\.google/, /api\.deepseek\.com/, /api\.moonshot/];
    return { Literal(n) { if (typeof n.value === 'string' && banned.some(r => r.test(n.value))) ctx.report({ node: n, message: `vendor endpoint '${n.value}' is banned (C2)` }); },
             CallExpression(n) { /* fetch/http/undici outside infrastructure/egress → report */ } }; } };
```
Required CI checks (branch protection): `typecheck`, `lint`, `depcruise`, `test`, `e2e`, `egress`, `audit`, `scorecard` (informational until M10).
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
GitHub Actions; `permissions: read-all` default; OIDC token only in `release.yml`; no secrets in `ci.yml`. Caches: pnpm store, Playwright browsers.
### 4.5 API / UI surface
None.
### 4.6 Flow
PR → ci.yml (matrix) → e2e.yml → status checks → merge queue (later).

## 5. Tasks
- [ ] `tools/eslint-rules` package with both rules + rule unit tests (RuleTester) incl. negative fixtures.
- [ ] Wire rules into root ESLint config; add `infrastructure/egress/` module with `allowedHosts` list.
- [ ] `ci.yml`: install (frozen lockfile), typecheck, lint, depcruise, test with coverage, upload coverage; matrix Node 22/24 × ubuntu/macos.
- [ ] `e2e.yml`: build web+daemon, Playwright with FakeProvider.
- [ ] Egress test harness (`apps/daemon/test/egress.spec.ts`) + job.
- [ ] `scorecard.yml`, `codeql.yml`, `dependency-review.yml`.
- [ ] `pnpm audit` gate + Renovate config + SBOM (CycloneDX) artifact.
- [ ] `release.yml` skeleton (semantic-release `--dry-run`, provenance placeholder).
- [ ] `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS` final text; PR template with the step-ID checklist.
- [ ] Document required checks + branch protection in `docs/ci.md`; enable on `main`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-08-01 | unit (RuleTester) | `no-vendor-endpoints` on `fetch('https://api.openai.com/v1')` | reported |
| UT-M0-08-02 | unit | `no-vendor-endpoints` on allowed `fetch('https://updates.example.org')` inside `infrastructure/egress` | not reported |
| UT-M0-08-03 | unit | `no-pty-regex-state` on `/Allow\?/.test(ptyOutput)` in providers | reported |
| IT-M0-08-04 | integration | egress test with FakeProvider session | contacted hosts ⊆ allowlist |
| IT-M0-08-05 | integration | egress test with a planted `fetch('https://api.anthropic.com')` (negative, in a throwaway branch) | job fails |
| AT-M0-08-06 | ci | coverage below threshold (planted) | job fails with threshold message |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-08-01 | Green pipeline | 1. open a PR with a trivial change | all required checks green within 15 min | ⬜ |
| TC-M0-08-02 | Vendor call blocked | 1. add `fetch('https://api.openai.com/v1/models')` in a daemon service 2. push | `lint` fails naming C2 rule; `egress` fails too | ⬜ |
| TC-M0-08-03 | Screen-scrape blocked | 1. in a provider package add `if (/Do you want to proceed/.test(output))` 2. push | `lint` fails with `no-pty-regex-state` | ⬜ |
| TC-M0-08-04 | No secrets in CI | 1. inspect workflow files and repo secrets | `ci.yml`/`e2e.yml` reference no secrets; only `release.yml` uses OIDC | ⬜ |
| TC-M0-08-05 | Scorecard | 1. open Security tab / Scorecard action output | report generated; list of findings captured in `docs/ci.md` for M10-08 | ⬜ |
| TC-M0-08-06 | Docs | 1. read SECURITY.md, CONTRIBUTING.md | DCO instructions, report channel, non-features section present | ⬜ |

## 7. Acceptance criteria
- [ ] Required checks enforced on `main`.
- [ ] Both custom ESLint rules with tests and proven negatives.
- [ ] Egress test in CI proves no vendor hosts contacted.
- [ ] Coverage thresholds enforced.
- [ ] Scorecard, CodeQL, dependency review, audit, SBOM jobs present.
- [ ] SECURITY/CONTRIBUTING/CODEOWNERS complete.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- macOS runners are slow/expensive: run tmux integration only on ubuntu + one macOS nightly.
- Network sandboxing in Node for the egress test: if `nock`/undici mocking proves leaky, use an OS-level approach (`unshare -n` on Linux) for the CI job.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
