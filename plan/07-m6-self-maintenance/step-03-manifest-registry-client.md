# Step M6-03 — Manifest registry client

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M2-03, M0-04, M0-08 |
| Estimated effort | 2 days |
| Packages touched | `packages/sdk`, `packages/core`, `apps/daemon`, `apps/cli`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy` |
| Risk | High |
| Owner | |

## 1. Goal
After this step the daemon can fetch Capability Manifests from a **Manifest Registry** independently of the app release: it downloads a signed index and signed per-provider manifests over HTTPS from exactly one configured host, verifies the ed25519 signature against keys pinned in the SDK, checks that the payload's `provider` matches the path it came from and that its `cliVersionRange` satisfies the installed CLI version, writes it to `~/.orchestra/manifests-cache/`, and hot-swaps it into the running plugin host **without restarting the daemon or disturbing running sessions**. A bad, tampered, mis-targeted or unsatisfiable manifest is rejected and the previous one keeps running; `orch registry rollback <provider>` returns to the last-known-good; with no network the daemon starts and runs entirely from cache. This step also closes **ADR-006**.

## 2. Why
- D6 — "Manifests, model catalog, plugins and app update independently" (`00-source-plan-v0.2.md` §10.1: manifests hot-reload in seconds, a separate channel from plugin code). Without it, ladder step 2 (M6-04) has nothing to fetch.
- D5/G7 — a manifest is data; a third-party provider can ship manifest updates without a core PR.
- C2 — the only new egress is the configured registry URL. Vendor endpoints stay forbidden; the `no-vendor-endpoints` ESLint rule and the M0-08 egress test are extended, not relaxed.
- C1/C8 — a manifest is what tells the launcher which flags are legal; an unsigned or unverified manifest could smuggle argv. Signature verification is a **security control**, not a convenience (`07-compliance-rules.md`, supply-chain section).
- R1 — hot manifest replacement is the cheapest possible response to a vendor change; R9 — pinned keys + no TOFU keeps the registry from becoming a supply-chain hole.
- M10-01 depends on the `ManifestOverrideApplier` port defined here; M6-05 reuses the `EgressPolicy` port.

## 3. Scope
### In scope
- **ADR-006 resolution** (§4.1) and the ADR file + `DECISIONS.md` row update.
- `SignedEnvelope` format, `TrustedKeySet` pinned in `packages/sdk`, key-rotation rules.
- Pure `ManifestResolver` (which manifest version wins for an installed CLI version) and `EnvelopeValidator` in `packages/core` / `packages/sdk`.
- `RegistryClient` (HTTP, conditional GET, timeouts, size caps), `ManifestCacheStore` (fs layout, atomic writes, last-known-good history), `ManifestRegistry` hot-swap, `ManifestOverrideApplier` port + implementation.
- `EgressPolicy` port + allowlist enforcement at the HTTP-client boundary.
- Doctor check `manifest.signature` (registered into M6-01's check map).
- Offline behaviour, rollback, `provider.manifest_reloaded` / `provider.manifest_rolled_back` events.
- HTTP + CLI surface; a local fixture registry (`pnpm registry:serve`) with a test key pair for CI and demos.
### Out of scope (deferred to …)
- Deciding *when* to fetch because of a drift case — deferred to M6-04 (`RegistryFix` strategy calls this step's use cases).
- Provider **plugin code** (npm packages) updates and the full plugin/skill/playbook registry — deferred to M10-03; this step handles manifests (+ the catalog data feed reused by M6-06) only.
- Release-feed polling and canary verification — deferred to M6-05.
- Sigstore/cosign verification of *release* artifacts (app, npm provenance) — deferred to M7-02 / M10-08; only the decision is recorded here.
- Publishing/maintaining the public registry itself — deferred to M10-03.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
Value objects (pure, `packages/core/src/maintenance/`): `ManifestRef` (`{providerId, manifestVersion, source}`), `ManifestSource`, `CacheState`, and the domain service `ManifestResolver` (§4.2) whose only rule set is: *the active manifest for a provider is the highest non-yanked `manifestVersion` whose `cliVersionRange` satisfies the installed CLI version and whose `minEngine` satisfies the daemon version; an unknown installed version resolves to nothing rather than to a guess.* Trust is not a domain concept — it is an invariant of the envelope format below: **an unverified manifest never becomes a `ManifestRef`.**

#### ADR-006 decision (resolved in this step)
**Decision: minisign-compatible ed25519 detached signatures for hot artifacts (manifests, catalog data, index); Sigstore/cosign for release artifacts (app bundles, npm provenance, container images). Recorded as `plan/adr/ADR-006-signing-scheme.md`, status Accepted.**

| Option | Verify path | Offline | Key handling | Verdict |
|---|---|---|---|---|
| minisign / ed25519 detached | ~40 lines over Node `crypto.verify('ed25519')`, zero runtime deps, < 1 ms | fully offline | public keys pinned in the SDK; rotation via a signed key set | **chosen for hot artifacts** — the daemon must verify a manifest in milliseconds, possibly offline, at boot |
| Sigstore / cosign (keyless, Fulcio + Rekor) | needs OIDC identity policy + transparency-log lookup, heavier client | needs the log (or a bundled offline bundle) | no long-lived keys — the real advantage | **chosen for releases** — releases are rare, human-approved, and benefit from transparency logs (M7-02, M10-08) |
| Both on hot artifacts | double verification cost and two failure modes on the boot path | — | — | rejected: complexity with no added guarantee for a file we also hash-pin in an index |

Consequences: a compromised registry key forges manifests until rotation, so (a) keys are pinned in the SDK and shipped with the app — **no trust-on-first-use, ever**; (b) rotation requires a new SDK release signed by the release key set (Sigstore), which is the human-approved path; (c) the index is signed *and* carries a sha256 per manifest, so a swapped file fails the hash check even before signature verification; (d) a manifest can never grant new egress or new binaries — those come from the allowlist and `EgressPolicy`, which manifests cannot edit (C1, C12).

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/registry/envelope.ts
export interface SignedEnvelope<T> {
  payload: T;                                   // canonical JSON (RFC 8785-style key ordering) is what is signed
  meta: { kind: 'manifest' | 'index' | 'catalog'; provider?: ProviderId; version: string;
          publishedAt: string; sha256: string; minEngine: string };   // minEngine = daemon semver range
  sig: { scheme: 'ed25519'; keyId: string; signature: string /* base64 */ };
}
export interface RegistryIndex {
  registryVersion: string; generatedAt: string;
  providers: Record<ProviderId, { manifests: { manifestVersion: string; cliVersionRange: string;
    path: string; sha256: string; minEngine: string; yanked?: boolean }[] }>;
}
// packages/sdk/src/registry/trusted-keys.ts   — pinned, no TOFU
export const TRUSTED_KEYS: readonly { keyId: string; publicKey: string; validFrom: string; validTo: string | null; role: 'manifest' | 'catalog' }[];

// packages/sdk/src/registry/verify.ts  (pure; 100 % branch)
export type VerifyError =
  | { code: 'UnknownKeyId'; keyId: string } | { code: 'KeyExpired'; keyId: string }
  | { code: 'SignatureInvalid' } | { code: 'HashMismatch'; expected: string; actual: string }
  | { code: 'ProviderMismatch'; expected: ProviderId; got: ProviderId }
  | { code: 'EngineIncompatible'; minEngine: string } | { code: 'MalformedEnvelope'; detail: string };
export declare function verifyEnvelope<T>(raw: unknown, schema: ZodType<T>, ctx:
  { keys: typeof TRUSTED_KEYS; now: string; expectProvider?: ProviderId; expectSha256?: string; daemonVersion: string }
): Result<SignedEnvelope<T>, VerifyError>;

// packages/core/src/maintenance/manifest-resolver.ts  (pure; 100 % branch)
export interface ResolverInput { installedCliVersion: string | null; active: ManifestRef | null;
  candidates: readonly { manifestVersion: string; cliVersionRange: string; yanked?: boolean; minEngine: string }[];
  daemonVersion: string; }
export type ResolverOutcome =
  | { action: 'keep' } | { action: 'upgrade'; to: string; reason: ResolveReason }
  | { action: 'rollback'; to: string; reason: ResolveReason } | { action: 'none'; reason: ResolveReason };
export declare function resolveManifest(i: ResolverInput): ResolverOutcome;
// Rules: highest semver manifestVersion whose cliVersionRange satisfies installedCliVersion AND whose
// minEngine satisfies daemonVersion AND not yanked. Unknown installed version ⇒ 'none' (never guess).
// Active version yanked ⇒ 'rollback' to the highest non-yanked satisfying candidate.

// apps/daemon/src/application/ports/registry.ports.ts
export interface EgressPolicy { assertAllowed(url: URL, reason: EgressReason): Result<void, EgressDenied>; allowedHosts(): readonly string[]; }
export type EgressReason = 'registry' | 'release-feed' | 'pr-api' | 'update-check';
export interface RegistryClientPort {
  fetchIndex(etag?: string): Promise<Result<{ status: 'ok'; envelope: SignedEnvelope<RegistryIndex>; etag?: string } | { status: 'not-modified' }, RegistryError>>;
  fetchManifest(path: string, expectSha256: string): Promise<Result<SignedEnvelope<CapabilityManifest>, RegistryError>>;
}
export type RegistryError = { code: 'Unreachable'; detail: string } | { code: 'HttpStatus'; status: number }
  | { code: 'TooLarge'; bytes: number } | { code: 'Timeout' } | { code: 'Verify'; err: VerifyError } | EgressDenied;
export interface ManifestCacheStore {
  read(p: ProviderId, v: string): Promise<Result<SignedEnvelope<CapabilityManifest>, CacheError>>;
  write(e: SignedEnvelope<CapabilityManifest>): Promise<Result<void, CacheError>>;   // atomic: tmp + rename
  state(): Promise<Result<CacheState, CacheError>>; setState(s: CacheState): Promise<Result<void, CacheError>>;
}
export interface CacheState { active: Record<ProviderId, string>; lastKnownGood: Record<ProviderId, string[]>;  // newest first, max 5
  indexEtag?: string; lastRefreshAt?: string; }
export interface ManifestOverrideApplier {     // also used by M10-01
  apply(p: ProviderId, m: CapabilityManifest, source: ManifestSource): Promise<Result<void, ApplyError>>;
  rollback(p: ProviderId): Promise<Result<{ to: string }, ApplyError>>;
  activeRef(p: ProviderId): ManifestRef;
}
export type ManifestSource = { kind: 'bundled' | 'registry' | 'local-override' | 'proposal'; version: string; id?: string };
```
Use cases (`apps/daemon/src/application/maintenance/`): `RefreshRegistry` (index → per-provider resolve → fetch → verify → cache → apply), `ApplyManifest`, `RollbackManifest`, `GetRegistryStatus`. All `Result`, no throws.

### 4.3 Data / schema changes
- No new table. `providers.manifest_version` (exists, `04-domain-model.md` §4) is updated on every successful apply; add columns `manifest_source TEXT NOT NULL DEFAULT 'bundled'` and `manifest_verified_at TEXT` via migration `NNN-m6-03-manifest-source`.
- New events (Zod-registered): `provider.manifest_reloaded` `{providerId, from, to, source, sha256, reason}`, `provider.manifest_rolled_back` `{providerId, from, to, reason}`, `provider.manifest_rejected` `{providerId, candidate, error: VerifyError|RegistryError}`. `audit.*` rows for manual refresh/rollback (actor = user).
- Config `maintenance.registry` (Zod, fail-fast): `{ enabled: false, url: 'https://registry.orchestra.dev', refreshIntervalMs: 21600000, timeoutMs: 10000, maxBytes: 1048576, autoApply: true, allowPrerelease: false }`. `url` must be `https:` (except `http://127.0.0.1:*` when `features.devTools`), single host; changing it is an audited settings mutation.
- Cache layout (0700 dir, 0600 files):
```
~/.orchestra/manifests-cache/
  index.json                      (signed envelope as fetched)
  state.json                      (CacheState)
  <provider>/<manifestVersion>.json    (signed envelope)
```

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/registry/http-registry.client.ts` — the **only** new outbound HTTP module. `undici` with: `EgressPolicy.assertAllowed` before every request, explicit `Accept: application/json`, `If-None-Match`, 10 s timeout, 1 MB `maxBytes` (stream aborted past the cap), max 2 redirects and only same-host, no cookies, no auth headers ever. It is the module the `no-vendor-endpoints` ESLint rule allowlists; the M0-08 egress test asserts that with `maintenance.registry.enabled: false` the daemon opens **zero** outbound connections.
- `EgressPolicyImpl` builds its host allowlist from: the configured registry URL (reason `registry`) + hosts extracted from *verified* manifests' `updateSources` (reason `release-feed`, consumed by M6-05) + the existing PR-API host (M3-06). Anything else → `EgressDenied` and an `audit` row. Manifests can add a feed host but nothing else; a manifest may never introduce a `registry` host.
- `ManifestCacheStoreFs` — atomic write (`.tmp` + `fsync` + `rename`), sha256 verified after write, corrupt file ⇒ quarantined to `<version>.json.bad` and treated as missing.
- `ManifestRegistry` (plugin host, `infrastructure/plugins/`) holds one immutable `CapabilityManifest` per provider behind an atomic swap. **Session pinning:** a `Session` records `manifestVersion` at launch and keeps reading the pinned instance until it ends; only new sessions see the new manifest. `PaneController`/`Launcher` read the manifest through the session's pinned ref, so a hot swap never changes the flags of a running agent (C8).
- Boot order: load bundled manifests → read cache `state.json` → apply cached active per provider (verify again on load; a cache entry that no longer verifies is ignored and `bundled` wins) → if `enabled`, schedule the first refresh at boot + 60 s, then `refreshIntervalMs` ± 10 % jitter.
- Offline / unreachable: `RegistryError.Unreachable|Timeout` is a **warn**, never a fail — no case, no user prompt; `GetRegistryStatus` reports `lastRefreshAt` and `offline: true`; Doctor check `manifest.signature` verifies the *active* manifest from cache and passes offline.
- Doctor check `manifest.signature` (`apps/daemon/src/infrastructure/maintenance/checks/manifest-signature.check.ts`): `pass` when the active manifest is bundled or verifies against the pinned keys; `warn` when the active manifest is bundled while the registry advertises a newer satisfying version; `fail` when a cached active manifest fails verification (`driftHint: 'manifest-stale'`).
- Fixture registry: `packages/sdk/src/registry/fixtures/` (index + manifests for `fake`, signed with a test key whose id is in `TRUSTED_KEYS` with `role: 'manifest'` and a `dev-only` marker rejected unless `features.devTools`), served by `pnpm registry:serve` (static file server on 127.0.0.1, dev dependency only).

### 4.5 API / UI surface
- `GET /api/registry/status` → `{ enabled, url, offline, lastRefreshAt, providers: [{providerId, active: {version, source, verifiedAt}, available?: {version, cliVersionRange}, lastKnownGood: string[] }] }`.
- `POST /api/registry/refresh` `{providers?}` (`Idempotency-Key`, audited) → 202 + per-provider outcome; `POST /api/registry/providers/:id/rollback` (audited, returns the version it landed on); `GET /api/providers/:id/manifest?version=` → the manifest payload + verification status.
- WS topic `health.registry`: `{event:'refreshed'|'applied'|'rejected'|'rolled_back', providerId, from, to, error?}`.
- CLI: `orch registry status [--json]`, `orch registry refresh [--provider id]`, `orch registry rollback <provider>`, `orch registry verify <file>` (offline verification of a downloaded envelope, exit 0/2).
- No new screen; the Registry panel is part of the Health screen in M6-07. The Fleet provider row (M1-10) shows `manifest vX (registry|bundled)`.

### 4.6 Flow / sequence
```
timer | POST /api/registry/refresh | RegistryFix (M6-04)
 → RefreshRegistry
    1 EgressPolicy.assertAllowed(registryUrl,'registry')
    2 client.fetchIndex(etag) → not-modified? stop : verifyEnvelope(index, keys, daemonVersion)
    3 per provider: resolveManifest({installedCliVersion, active, candidates, daemonVersion})
         keep|none → skip
    4 client.fetchManifest(path, expectSha256) → verifyEnvelope(…, expectProvider)
    5 manifestSchema.parse(payload)  (M2-03 Zod)  → cache.write (atomic)
    6 autoApply ? ManifestOverrideApplier.apply : record as 'available'
    7 ManifestRegistry.swap → cache.setState(active, lastKnownGood += previous)
      → emit provider.manifest_reloaded → ws health.registry
    any failure → emit provider.manifest_rejected, keep active, no state change
rollback: state.lastKnownGood[provider][0] → verify from cache → swap → provider.manifest_rolled_back
```

## 5. Tasks
- [ ] Write `plan/adr/ADR-006-signing-scheme.md` from §4.1; set the `DECISIONS.md` row to Accepted with today's date.
- [ ] `packages/sdk/src/registry/`: `SignedEnvelope`, `RegistryIndex` Zod schemas, canonical-JSON serializer, `TRUSTED_KEYS` (prod key placeholder + dev key).
- [ ] `verifyEnvelope()` over `node:crypto` ed25519 + sha256; all `VerifyError` branches; fast-check fuzz that it never throws.
- [ ] `resolveManifest()` in `packages/core` with the semver/yank/engine rules; golden table; 100 % branch.
- [ ] `EgressPolicy` port + `EgressPolicyImpl` (registry host + verified `updateSources` hosts); `EgressDenied` audit row.
- [ ] `HttpRegistryClient` (undici, conditional GET, timeout, size cap, redirect + cookie policy); ESLint allowlist entry.
- [ ] `ManifestCacheStoreFs` (atomic write, permissions, quarantine of corrupt files, `CacheState` with `lastKnownGood` max 5).
- [ ] `ManifestRegistry` hot swap + **session manifest pinning** (`sessions.manifest_version` read path through the pinned ref).
- [ ] `ManifestOverrideApplier` implementation (apply / rollback / activeRef) — the port M10-01 consumes.
- [ ] Use cases `RefreshRegistry`, `ApplyManifest`, `RollbackManifest`, `GetRegistryStatus`.
- [ ] Migration `manifest_source` / `manifest_verified_at`; event registration for the three `provider.manifest_*` events.
- [ ] Doctor check `manifest.signature` registered into M6-01's DI check map.
- [ ] Refresh scheduler (boot + 60 s, interval with jitter, single-flight mutex, offline backoff).
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS topic `health.registry`.
- [ ] `apps/cli/src/commands/registry.ts`: `status`, `refresh`, `rollback`, `verify`.
- [ ] Fixture registry under `packages/sdk/src/registry/fixtures/` + `pnpm registry:serve` + a tamper fixture and a yanked-version fixture.
- [ ] Extend the M0-08 egress test: zero connections when disabled; only the registry host when enabled; denied host fails the build.
- [ ] `packages/sdk/README.md`: envelope format, how to sign a manifest, key rotation procedure.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-03-01 | unit | `verifyEnvelope` matrix: valid, wrong key id, expired key, flipped byte, wrong sha256, wrong provider, `minEngine` too high, malformed JSON | one distinct `VerifyError.code` per row; never throws; 100 % branch |
| UT-M6-03-02 | unit | `resolveManifest`: installed 1.2.3 vs candidates 1.0/1.2/2.0, yanked active, unknown installed version, prerelease with `allowPrerelease` off | `upgrade`/`keep`/`rollback`/`none` exactly per the rule table |
| UT-M6-03-03 | unit | canonical JSON: key order and unicode escaping stable across two serializations | byte-identical; signature verifies after a round-trip through `JSON.parse` |
| UT-M6-03-04 | unit (fast-check) | `verifyEnvelope` over random buffers and randomly mutated valid envelopes | always `Result.err`, never throws, never returns ok for a mutated payload |
| UT-M6-03-05 | unit | `EgressPolicy.assertAllowed` for registry host, feed host from a verified manifest, vendor API host, IP literal, `http:` in prod | allow / allow / deny / deny / deny |
| AT-M6-03-01 | application | `RefreshRegistry` where provider A upgrades and provider B's candidate fails verification | A applied + `manifest_reloaded`; B unchanged + `manifest_rejected`; one refresh, two outcomes |
| AT-M6-03-02 | application | `RollbackManifest` with 3 entries in `lastKnownGood` | lands on `[0]`, state shifts, `manifest_rolled_back` emitted, active re-verified |
| IT-M6-03-01 | integration | fixture registry end-to-end: serve → refresh → cache files on disk → restart daemon | cached manifest active after restart without network; file modes 0600 |
| IT-M6-03-02 | integration | tampered manifest (byte flipped after signing) served by the fixture registry | rejected with `SignatureInvalid`; cache untouched; active manifest unchanged; `.bad` quarantine not created (nothing was written) |
| IT-M6-03-03 | integration | hot swap while a FakeProvider session runs | running session keeps its pinned manifest version; a session started after the swap uses the new one |
| IT-M6-03-04 | integration | egress: daemon configured with registry disabled, full E2E suite | zero outbound sockets (M0-08 harness) |
| E2E-M6-03-01 | e2e | `orch registry refresh` → `orch registry status --json` → `orch registry rollback fake` | status shows registry source then rollback to the previous version; exit codes 0 |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-03-01 | Signed manifest fetch + hot reload, no restart | 1. `pnpm registry:serve`. 2. Set `maintenance.registry.url` to it, `enabled: true`. 3. Publish `fake@1.1.0`. 4. `orch registry refresh --provider fake`. 5. `orch registry status`. | Active manifest becomes 1.1.0, `source: registry`; daemon PID unchanged; `provider.manifest_reloaded` event present; elapsed refresh→applied < 5 s | ⬜ |
| TC-M6-03-02 | Running session is undisturbed | 1. Start a FakeProvider session. 2. Publish and refresh a manifest that renames a command. 3. Send the old command to the running pane; then start a new session and send it. | Running pane still accepts the old command (pinned version); the new session rejects it as unknown; no pane restart, no dropped output | ⬜ |
| TC-M6-03-03 | **Negative: tampered signature** | 1. Edit `fake/1.2.0.json` in the fixture registry without re-signing. 2. `orch registry refresh`. 3. `orch registry status --json`. | Refused with `SignatureInvalid`; exit 2; active manifest and cache unchanged; `provider.manifest_rejected` event; nothing written under `manifests-cache/fake/` | ⬜ |
| TC-M6-03-04 | **Negative: provider/path mismatch & hash mismatch** | 1. Serve a correctly signed `claude` manifest at the `fake` path. 2. Refresh. 3. Serve a manifest whose index sha256 does not match. 4. Refresh. | `ProviderMismatch` then `HashMismatch`; both rejected; two `provider.manifest_rejected` events; active unchanged | ⬜ |
| TC-M6-03-05 | **Negative: egress outside the allowlist** | 1. Set `maintenance.registry.url` to `https://api.anthropic.com`. 2. Restart the daemon. | Config validation or `EgressDenied` blocks it before any socket opens; error names the allowlist; `audit` row written; daemon still boots with bundled manifests | ⬜ |
| TC-M6-03-06 | Offline boot and offline operation | 1. Refresh successfully. 2. Stop the fixture registry; disable the network. 3. Restart the daemon. 4. `orch doctor --check manifest.signature`; `orch registry status`. | Daemon boots from cache with the registry version active; check `pass`; status shows `offline: true` and `lastRefreshAt`; no repeated error spam (backoff visible in logs) | ⬜ |
| TC-M6-03-07 | Rollback to last-known-good | 1. Apply 1.1.0 then 1.2.0. 2. `orch registry rollback fake`. 3. `orch registry status --json`. | Active back to 1.1.0, verified from cache; `provider.manifest_rolled_back`; a second rollback lands on the bundled manifest and says so | ⬜ |
| TC-M6-03-08 | Yanked + engine-incompatible candidates | 1. Mark the active version `yanked: true` and publish a candidate with `minEngine` above the daemon version. 2. Refresh. | Resolver rolls back off the yanked version and skips the incompatible candidate with `EngineIncompatible` in the status; no crash | ⬜ |
| TC-M6-03-09 | Resilience: truncated / oversized response | 1. Configure the fixture server to send a 5 MB body, then to cut the connection mid-body. 2. Refresh each time. | `TooLarge` then `Unreachable`; both are warns; active unchanged; no partial file in the cache (only `.tmp` cleanup) | ⬜ |
| TC-M6-03-10 | **Remediation timing input** (SLO) | 1. With `fake@1.1.0` already cached, call `POST /api/registry/providers/fake/apply` (cache-only path) 10 times, timing each. | p95 apply-from-cache < 2 000 ms (leaves headroom inside the 10 s ladder-1 budget of M6-04); record the numbers in the log | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-03-01 … 10 pass and are recorded with build hash and date.
- [ ] ADR-006 written, linked from `DECISIONS.md` (status Accepted) and from M6-04's "Why".
- [ ] `verifyEnvelope` and `resolveManifest` have 100 % branch coverage; fuzz tests green.
- [ ] A tampered, mis-targeted, yanked or engine-incompatible manifest is **never** applied (TC-03, TC-04, TC-08) and always leaves the active manifest untouched.
- [ ] Hot reload applies a cached manifest in < 2 s p95 and never restarts the daemon or a running session (TC-01, TC-02, TC-10).
- [ ] Offline boot and offline steady state work from cache with no errors surfaced to the user (TC-06).
- [ ] M0-08 egress test extended and green: zero egress when disabled, registry host only when enabled, any other host fails the build (C2).
- [ ] `ManifestOverrideApplier` and `EgressPolicy` ports are exported and documented for M6-04, M6-05 and M10-01.
- [ ] No new lint/dependency-cruiser violations; the HTTP client is the only module outside the allowlist exemption list.
- [ ] `packages/sdk/README.md` documents the envelope, signing and key-rotation procedure; `PROGRESS.md` row updated.

## 8. Risks / open questions
- **Key custody.** The production manifest signing key does not exist yet; ship with the dev key marked `dev-only` (refused unless `features.devTools`) and `maintenance.registry.enabled: false` by default until M10-03 stands up the real registry. Rotation is an SDK release — document it before the first public manifest.
- A registry that serves stale-but-valid manifests can pin users to an old version; the index carries `generatedAt` and the status surface shows its age. A freshness maximum (reject an index older than N days) is deferred to M10-03 with the real registry SLA.
- `minEngine` semantics must be agreed with M10-03's plugin engine-compat field so manifests and plugins do not use two different range dialects — flagged for the M10-03 step log.
- Canonical JSON: Node has no built-in RFC 8785; the serializer is ours and therefore part of the security boundary. It is fuzz-tested and must never be "optimised" without re-signing every fixture.
- `updateSources` hosts come from *verified* manifests, so a compromised signing key could also widen the feed allowlist — bounded by (a) feeds being read-only GETs with a size cap, (b) `EgressReason` separation, (c) no `registry` host ever coming from a manifest.
- Whether any vendor publishes machine-readable manifests we could mirror is unknown and irrelevant here — **we never fetch from vendor hosts** (C2); the registry is ours.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
