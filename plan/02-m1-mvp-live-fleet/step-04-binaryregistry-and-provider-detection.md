# Step M1-04 — BinaryRegistry & provider detection

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M0-04 (∥ with M1-01/02/03) |
| Estimated effort | 1.5 days |
| Packages touched | `apps/daemon/src/infrastructure/binaries`, `apps/daemon/src/application/providers`, `packages/sdk` (manifest `cliVersionRange`) |
| Risk | Low |
| Owner | |

## 1. Goal
The daemon only ever launches binaries from an explicit allowlist (`tmux`, `git`, `claude`, `codex`, `agy`, `kimi`, `opencode`, `node` for the fake agent, `gh`/`glab` later). At boot and on demand it locates each binary (PATH + configured overrides), verifies it is a regular executable, parses its version, compares it with the adapter manifest's `cliVersionRange`, runs the adapter's quota-free `AuthProbe`, and records the result in the `providers` table — so the Fleet screen can show "installed · version · verified/unverified · logged in · plan" without spending any quota.

## 2. Why
C1 (official binaries only, version verified at boot), C3 (auth status only), D6 (version change is the primary drift trigger for M6), `ENVIRONMENT.md` (broken Codex install must show as a health row, not a crash).

## 3. Scope
### In scope
- `BinaryRegistry`: allowlist (name → {candidates: string[] (absolute path overrides from config), versionArgs: ['--version'], versionRegex, minVersion?}), `resolve(name) → {path, version, sha256?}`; refuses anything not in the allowlist (`BINARY_NOT_ALLOWED`).
- `ProviderDetector` use case: for each registered adapter → resolve binary → compare to `manifest.cliVersionRange` (semver) → `verified | unverified | missing | unsupported` → `AuthProbe` (only if present) → upsert `providers` row → `provider.detected` / `provider.version_changed` / `provider.auth_changed` events.
- Version-change watcher: re-run detection every hour and on `POST /providers/detect`; diff versions → event (consumed by Doctor in M6).
- Config `binaries.<name>.path` override; `providers.<id>.enabled` flag; agy requires `tos_acknowledged_at` (set via M1-07 UI/API) before it is `enabled`.
- Fleet API: `GET /providers` returns rows with all fields; `POST /providers/:id/detect`.
### Out of scope (deferred)
- Doctor checks beyond version/auth → M6-01. Manifest hot reload → M6-03. Canary verification of new versions → M6-05.

## 4. Design
### 4.1 Domain
`ProviderAccount` (core): `{ providerId, cliVersion?, manifestVersion, verification: 'verified'|'unverified'|'missing'|'unsupported'|'disabled', auth: AuthStatus?, tosAcknowledgedAt?, enabled }`.
### 4.2 Interfaces / contracts
```ts
export interface BinaryRegistryPort {
  resolve(name: AllowedBinary): Promise<Result<ResolvedBinary, BinaryError>>;   // {name, path, version, checkedAt}
  allowlist(): AllowedBinary[];
}
export type AllowedBinary = 'tmux'|'git'|'node'|'claude'|'codex'|'agy'|'kimi'|'opencode'|'gh'|'glab';
export type BinaryError = { code:'BINARY_NOT_ALLOWED'|'BINARY_MISSING'|'BINARY_NOT_EXECUTABLE'|'VERSION_PARSE'|'VERSION_UNSUPPORTED'; name: string; detail?: string };

export class DetectProviders { execute(opts?: { only?: ProviderId[] }): Promise<Result<ProviderAccount[], DomainError>> }
```
Version parsing per binary via regex from the manifest (`manifest.versionRegex`, default `/(\d+\.\d+\.\d+)/`). Codex's broken install (ENOENT of vendored binary) surfaces as `BINARY_NOT_EXECUTABLE` with the stderr line.
### 4.3 Data / schema changes
`providers` (baseline) gains `verification`, `binary_path`, `binary_checked_at`, `enabled` via migration `0005_providers_detection.ts`.
### 4.4 Infrastructure
Execution through `ProcessRunner` with a 5 s timeout and allowlisted env; never with a shell. `which`-style lookup implemented in-process (iterate PATH), respecting overrides first.
### 4.5 API / UI surface
`GET /providers`, `POST /providers/detect`, `POST /providers/:id/detect`, `PATCH /providers/:id {enabled}`. WS topic `fleet` gets `provider.*` events.
### 4.6 Flow
`boot → DetectProviders → for each adapter: resolve → semver check → auth probe → upsert → events` ; `hourly → same → diff → version_changed`.

## 5. Tasks
- [ ] Allowlist + config schema (`binaries.*.path`, `providers.*.enabled`).
- [ ] `BinaryRegistry` with PATH lookup, executable check, version exec + parse, caching (5 min).
- [ ] `DetectProviders` use case + events; `ProviderRepository` upsert; migration `0005`.
- [ ] Semver range check against `manifest.cliVersionRange`; statuses.
- [ ] Hourly scheduler (Nest `@Interval`) + manual endpoints.
- [ ] Depcruise/ESLint rule: `child_process`/`ProcessRunner` calls must pass an `AllowedBinary` (custom rule `only-allowlisted-binaries`, RuleTester tests).
- [ ] Fleet DTOs; `fleet` WS topic snapshot includes providers.
- [ ] Tests: fake PATH dirs with stub scripts printing versions; broken stub exiting 127; unsupported version.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M1-04-01 | unit | `resolve('curl')` | `BINARY_NOT_ALLOWED` |
| IT-M1-04-02 | integration | stub `claude` printing `2.1.216 (Claude Code)` | version `2.1.216`, `verified` if in range |
| IT-M1-04-03 | integration | stub exits with ENOENT-like stderr | `BINARY_NOT_EXECUTABLE`, provider `missing`, no throw |
| IT-M1-04-04 | integration | version outside range | `unsupported`, event `provider.detected` with reason |
| IT-M1-04-05 | integration | version changes between two detections | `provider.version_changed` event |
| UT-M1-04-06 | unit (RuleTester) | `runner.exec('curl', …)` | lint error `only-allowlisted-binaries` |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-04-01 | Real machine detection | 1. start daemon 2. `GET /providers` | claude 2.1.216 verified/logged-in; codex `missing` with stderr hint (until reinstalled); agy 1.2.1 `disabled` (ToS not acknowledged); kimi listed but adapter absent → `no adapter` | ⬜ |
| TC-M1-04-02 | Fix Codex | 1. reinstall codex 2. `POST /providers/detect` | codex becomes `verified` (or `unverified` if newer than manifest range) with version | ⬜ |
| TC-M1-04-03 | Path override | 1. set `binaries.claude.path` to a wrong path 2. restart | `missing` with the configured path in detail; fix → ok | ⬜ |
| TC-M1-04-04 | Auth off | 1. `claude /logout` (or simulate) 2. detect | `auth.loggedIn=false`; no token-like fields anywhere in response (grep) | ⬜ |
| TC-M1-04-05 | No quota spent | 1. note provider usage before/after detection | `--version` / status probes only; no session/turn created | ⬜ |

## 7. Acceptance criteria
- [ ] Allowlist enforced at runtime and by lint rule.
- [ ] Detection statuses correct for present/missing/broken/unsupported binaries.
- [ ] Version-change event emitted; hourly + manual detection.
- [ ] Auth status carries no secrets (contract test reused).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Some CLIs print version to stderr or need `version` subcommand — manifest `versionArgs` handles it (verify per CLI at step start).
- Homebrew vs npm installs put binaries in different PATH locations for launchd-started daemons (M7): resolve at boot with a PATH augmented from the user's login shell (config `binaries.pathExtra`).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
