# Step M10-03 — Plugin / skill / playbook registry

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M6-03 (signed envelopes, `TRUSTED_KEYS`, `EgressPolicy`, `HttpRegistryClient`), M8-04 (skill artifact format + trust levels), M8-01 (settings layers), M2-01/M2-02 (taxonomy + model catalog), M3-01 (playbook schema) |
| Estimated effort | 3 days |
| Packages touched | `packages/sdk`, `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `apps/cli`, `docs/`, `.github/workflows` |
| Risk | High (this is the code-loading path; R9) |
| Owner | |

## 1. Goal
After this step Orchestra has one artifact registry for everything the intelligence and provider layers consume: **provider plugins** (`orchestra-provider-*` npm packages with provenance), **skill packs**, **playbook packs**, **policy packs** and **model-catalog** data. A signed index published alongside the manifest index (M6-03) lists every artifact version with its integrity hash, `engines.orchestra` range, SDK range, trust level and repository. `orch plugin install orchestra-provider-kimi` resolves the version, downloads the tarball from the npm registry with scripts disabled, verifies the index signature, the tarball hash, the npm provenance attestation and the engine/SDK compatibility ranges, unpacks it into `~/.orchestra/plugins/`, runs a load-time shape check plus the SDK contract harness against the plugin's own bundled fixtures, and hot-registers the adapter so it appears on Fleet **without restarting the daemon**. `--from github:owner/repo#ref` installs an unsigned artifact at trust level `local` only after an explicit, typed confirmation that names exactly what is being trusted. Any failure — bad signature, wrong hash, incompatible engine, missing provenance where the trust level requires it, refused trust — leaves nothing installed and nothing loaded. `orch plugin update`, `remove`, `list`, `verify` and the author-side `orch plugin check` complete the loop, and a third party can ship a provider with no PR to this repository.

## 2. Why
- **D5 / G7** — "every provider is a plugin"; "≥ 1 third-party plugin without a core PR" is a 1.0 Definition-of-Done line. The SDK has existed since M0-03, but without a distribution and verification path a third-party adapter cannot actually be installed by anyone.
- **D6 / source plan §10.1** — provider plugins are one of the five independent update channels ("npm registry with provenance, semver, engine-compat, hot-reload adapter"). M6-03 built the manifest channel; this step builds the plugin/skill/playbook/policy/catalog channels on the same signing and egress machinery.
- **D7** — taxonomy, model profiles, playbooks and skills are *data*; a registry is how that data updates weekly without an app release.
- **C4** — registry policy is where "one account per provider; no rotation/pooling/sharing" becomes enforceable against third-party code: a plugin that reads vendor credential stores, proxies tokens or rotates accounts is rejected by policy and de-listed.
- **C1/C2/C8** — a plugin cannot widen the binary allowlist or open new egress; those come from `BinaryRegistry` and `EgressPolicy`, which plugins cannot edit. `07-compliance-rules.md` supply-chain section (2026 npm worms targeting agent config dirs) is the reason install runs with `--ignore-scripts` and why trust levels are mandatory rather than advisory.
- **R9** — this is the single highest-value target in the product; the controls here (pinned keys, no TOFU, hash-pinned index, provenance, no install scripts, explicit trust) are the mitigation.

## 3. Scope
### In scope
- `ArtifactKind` model and the package layout + `orchestra.plugin.json` manifest for all five kinds.
- `ArtifactIndex` (signed with the M6-03 envelope, same `TRUSTED_KEYS`), published next to the manifest index.
- Trust levels (`official | verified | community | local`) and the rules that map a verification outcome to a level.
- Compatibility resolution: semver, `engines.orchestra`, `sdkRange`, yank, prerelease opt-in.
- `PluginInstaller`: resolve → fetch (npm registry tarball or GitHub tarball) → verify → unpack → static checks → load → contract smoke → register.
- Hot load/unload of provider adapters, skill packs, playbook packs, policy packs and catalog data through the existing plugin host.
- `orch plugin install|update|remove|list|verify|search|check` and the HTTP/WS surface; Plugins screen in the web UI.
- **ADR-014**: no runtime sandbox for plugin code in v1; signature + trust + review are the gate. Written, accepted, documented.
- Registry publishing tooling (`tools/registry/`): build the index from a source-of-truth YAML, sign it, verify it; `POST /v1/drift-reports` endpoint contract for M10-02 and the k-anonymity policy.
- Registry policy document (what is accepted, what is de-listed, how yanks work).
### Out of scope (deferred to …)
- Hosting/operating the public registry (DNS, CDN, key custody) — operational task tracked in M10-07's launch checklist; this step ships the format, the client, the fixture registry and the publishing tool.
- A runtime sandbox (worker thread / `node:vm` / permission model) for plugin code — ADR-014 defers it to post-1.0 with a written revisit trigger.
- Paid/private registries, mirroring, air-gapped bundles — post-1.0.
- Automatic updates of plugins without user action — `plugins.autoUpdate` exists in config but defaults `false` and is out of scope for verification here beyond honouring the flag.
- Skill *rendering* into provider directories (M8-04) and playbook *execution* (M3-01/M3-02) — unchanged; this step only distributes and validates the artifacts.
- The Plugin Author Guide prose — M10-06 (this step ships `orch plugin check` and the templates the guide walks through).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/registry/{artifact-ref.ts, trust-level.ts, compat.ts, install-plan.ts}` — pure.

- **`TrustLevel`** ordered `official > verified > community > local`. Derivation (pure function, one branch per row, all unit-tested):

| Verification outcome | Level | Install behaviour |
|---|---|---|
| Signed index entry + sha256 match + npm provenance + publisher key ∈ `TRUSTED_KEYS` with `role: 'artifact'` and `scope: 'official'` | `official` | installs silently if `plugins.minTrust ≤ official` |
| Signed index entry + sha256 match + npm provenance + third-party publisher listed in the signed index as `reviewed: true` | `verified` | installs with a one-line notice |
| Signed index entry + sha256 match + npm provenance, `reviewed: false` | `community` | quarantine only; cannot import, run contract tests, or load in v1 |
| No index entry, or GitHub/file source, or missing provenance | `local` | refused unless the user passes `--trust local` **and** types the artifact name to confirm |

- **Rule T1** — trust is decided *before* any code is read, from metadata only; the loader never "upgrades" trust after inspecting code.
- **Rule T2** — `plugins.minTrust` (settings, default `verified`) is a hard floor. An org layer may raise it; a user layer may not lower an org floor (settings-engine precedence, M8-01).
- **Rule C-1 engine compat** — install requires `satisfies(daemonVersion, artifact.engines.orchestra)` **and** `satisfies(sdkVersion, artifact.sdkRange)`. A mismatch is `EngineIncompatible` naming both sides; never a warning.
- **Rule C-2 resolution** — highest non-yanked version satisfying the requested range, the engine range and the SDK range, excluding prereleases unless `plugins.allowPrerelease`. Unknown/no candidate ⇒ `NoSatisfyingVersion` with the list of rejected candidates and why.
- **Rule C-3 one provider id per installed plugin.** Two plugins claiming `providerId: 'kimi'` ⇒ `ProviderIdConflict`; the bundled first-party plugin always wins and the third-party one is refused (a third party extending an existing provider must use a distinct id).
- **Rule C-4 no unload while in use.** Removing or updating a provider plugin with live sessions ⇒ `PluginInUse` listing session ids; `--drain` waits, it never kills a session.
- **Rule C-5 integrity is checked twice**: the index sha256 before unpack, and a recomputed tree hash after unpack; a mismatch quarantines the directory and installs nothing.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/registry/artifact.ts
export type ArtifactKind = 'provider-plugin' | 'skill-pack' | 'playbook-pack' | 'policy-pack' | 'model-catalog';

/** orchestra.plugin.json — at the package root of every artifact, validated by Zod, additionalProperties: false */
export interface ArtifactManifest {
  schemaVersion: 1;
  kind: ArtifactKind;
  id: string;                          // stable id within the kind, e.g. 'kimi', 'clean-arch-flutter'
  name: string;                        // npm package name; providers MUST match /^orchestra-provider-[a-z0-9-]+$/
  version: string;                     // semver, equals package.json#version
  description: string;
  license: string;                     // SPDX id; SDK/protocol side is Apache-2.0 (D10)
  repository: string;                  // https URL — where drift advisories and issues go (M10-02)
  author: { name: string; url?: string };
  engines: { orchestra: string; node?: string };     // orchestra = daemon semver range (REQUIRED)
  sdkRange: string;                    // @orchestra/sdk semver range this artifact compiled against
  entry?: string;                      // provider-plugin only: ESM entry exporting { adapter }
  provides: ProviderProvides | DataProvides;
  declares: {                          // declarative, checked at install; NOT a sandbox (ADR-014)
    egressHosts: string[];             // MUST be [] — plugins may not open egress; non-empty ⇒ refused
    binaries: string[];                // CLI binary names the adapter launches; MUST already be allowlisted (C1)
    writesOutsideWorktree: false;
  };
  driftReports?: boolean;              // default true; false opts this plugin's users out of M10-02 reporting
}
export interface ProviderProvides { providerId: string; manifestPath: string; fixturesDir: string; cliVersionRange: string }
export interface DataProvides { files: string[]; schema: 'taxonomy' | 'model-profile' | 'playbook' | 'policy' | 'skill' }

// packages/sdk/src/registry/artifact-index.ts — signed with the M6-03 SignedEnvelope, kind: 'artifacts'
export interface ArtifactIndex {
  registryVersion: string; generatedAt: string;
  artifacts: Record<string /* name */, {
    kind: ArtifactKind; repository: string; reviewed: boolean; deListed?: { reason: string; at: string };
    versions: { version: string; sha512: string; tarball: string; engines: { orchestra: string };
                sdkRange: string; provenance: boolean; yanked?: boolean; publishedAt: string }[];
  }>;
}

// packages/core/src/registry/compat.ts (pure, 100 % branch)
export type CompatError =
  | { code: 'EngineIncompatible'; artifact: string; requires: string; daemon: string }
  | { code: 'SdkIncompatible'; requires: string; have: string }
  | { code: 'NoSatisfyingVersion'; requested: string; rejected: { version: string; why: string }[] }
  | { code: 'DeListed'; reason: string } | { code: 'ProviderIdConflict'; providerId: string; installed: string };
export declare function resolveArtifactVersion(i: ResolveInput): Result<ResolvedArtifact, CompatError>;
export declare function deriveTrust(v: VerificationFacts, cfg: TrustConfig): TrustLevel | { refused: TrustRefusal };

// apps/daemon/src/application/ports/plugin.ports.ts
export interface ArtifactFetcher {                      // npm registry tarball or GitHub tarball; egress-policed
  fetch(src: ArtifactSource, expect?: { sha512: string }): Promise<Result<{ tarballPath: string; sha512: string; provenance?: ProvenanceAttestation }, FetchError>>;
}
export type ArtifactSource = { kind: 'registry'; name: string; version: string }
  | { kind: 'github'; owner: string; repo: string; ref: string } | { kind: 'path'; dir: string };
export interface PluginStore {                          // ~/.orchestra/plugins
  unpack(tarballPath: string, name: string, version: string): Promise<Result<{ dir: string; treeSha256: string }, StoreError>>;
  remove(name: string, version?: string): Promise<Result<void, StoreError>>;
  list(): Promise<Result<InstalledArtifact[], StoreError>>;
  quarantine(dir: string, reason: string): Promise<void>;
}
export interface PluginHost {                           // hot registration, extends the M6-03 plugin host
  loadProvider(dir: string, m: ArtifactManifest): Promise<Result<ProviderAdapter, LoadError>>;
  unloadProvider(providerId: string): Promise<Result<void, LoadError>>;
  loadData(dir: string, m: ArtifactManifest): Promise<Result<void, LoadError>>;   // skills/playbooks/policies/catalog
}
export type LoadError = { code: 'BadShape'; detail: string } | { code: 'ContractSmokeFailed'; failures: string[] }
  | { code: 'ProviderIdConflict'; providerId: string } | { code: 'ImportThrew'; detail: string };
```
Use cases (`apps/daemon/src/application/registry/`): `RefreshArtifactIndex`, `InstallArtifact`, `UpdateArtifact`, `RemoveArtifact`, `VerifyArtifact`, `ListArtifacts`. All `Result`, one class each, no throws.

### 4.3 Data / schema changes
- New table `installed_artifacts`: `name TEXT PK, kind TEXT, id TEXT, version TEXT, trust TEXT, source_json TEXT, sha512 TEXT, tree_sha256 TEXT, engines_orchestra TEXT, sdk_range TEXT, provider_id TEXT NULL, installed_at TEXT, installed_by TEXT, enabled INTEGER NOT NULL DEFAULT 1`. Migration `NNN-m10-03-installed-artifacts`; Postgres-compatible types only.
- Events: `plugin.index_refreshed`, `plugin.install_started`, `plugin.installed` `{name, version, trust, sha512}`, `plugin.install_refused` `{name, code}`, `plugin.loaded`, `plugin.unloaded`, `plugin.removed`, `plugin.quarantined`. Every install/remove also writes an `audit.*` row with the actor and the trust level.
- Config `plugins` (Zod, fail-fast): `{ enabled: true, minTrust: 'verified', allowCommunity: false, allowPrerelease: false, autoUpdate: false, npmRegistry: 'https://registry.npmjs.org', maxTarballBytes: 20_971_520, installTimeoutMs: 120_000 }`. Changing `npmRegistry` is an audited settings mutation and must be `https:`.
- Store layout (dir 0700, files 0600):
```
~/.orchestra/plugins/
  index.json                      signed ArtifactIndex envelope (as fetched)
  state.json                      { indexEtag, lastRefreshAt }
  <name>/<version>/…              unpacked package (read-only after install)
  <name>/<version>.tree           recorded tree sha256
  quarantine/<name>-<ts>/         failed installs, kept for inspection, TTL 7 d
```

### 4.4 Infrastructure
- **Egress.** Two new `EgressReason`s: `artifact-registry` (the index host, same single host as M6-03) and `artifact-tarball` (the configured npm registry host; `codeload.github.com` + `api.github.com` only when the user explicitly used `--from github:`). Everything goes through M6-03's hardened undici client: timeouts, size cap (`maxTarballBytes`), no cookies, no auth headers, max 2 same-host redirects. `no-vendor-endpoints` still forbids everything else.
- **Fetch.** npm: `GET {npmRegistry}/{name}` for the packument, then the version's `dist.tarball` (must be on the same host) with `dist.integrity` (sha512) checked *and* compared against the index's `sha512`. Provenance: fetch the attestation bundle and verify the Sigstore signature and that the source repo equals `manifest.repository`; if verification tooling is unavailable, provenance counts as absent (trust degrades, install does not silently continue).
- **No install scripts, ever.** The tarball is extracted by our own code (`tar` with path traversal, symlink, absolute-path and device-file rejection); `npm`/`pnpm` are never invoked for plugin installs, so `preinstall`/`postinstall` cannot run. Dependencies: a provider plugin must be self-contained (bundled) apart from `@orchestra/sdk`, which the daemon injects; a plugin with runtime `dependencies` other than peer `@orchestra/sdk` is refused (`UnbundledDependencies`).
- **Static checks before load** (fast, advisory-strength, not a sandbox): the entry file is scanned for `child_process`, `node:vm`, `fs` writes outside a worktree helper, `fetch`/`undici`/`http`, and dynamic `import()` of non-relative paths. Hits are **shown to the user** at install time and recorded in the audit row; for `official`/`verified` they block the install (maintainer bug), community remains quarantined; local execution requires explicit administrator trust for that exact artifact hash. These are detection aids — ADR-014 is explicit that they are not a security boundary.
- **Load.** `import(pathToFileURL(dir/entry))` inside the plugin host; the module must default-export or named-export `{ adapter, manifest }`; the adapter is validated against the SDK shape (all required interface members present, `id` matching `provides.providerId`) and then run through a **contract smoke**: `manifest.contract.spec` plus `auth`, `launcher` and `telemetry` specs against the plugin's own `fixturesDir`. Failure ⇒ `ContractSmokeFailed`, nothing registered, directory quarantined.
- **Hot registration.** On success the adapter is added to the DI provider map atomically; Fleet (M1-10) picks it up over WS; Doctor schedules its checks; the manifest registry (M6-03) begins tracking its `cliVersionRange`. Unload is the reverse and is refused while sessions exist (Rule C-4).
- **Data artifacts** (skills/playbooks/policies/catalog) are validated against their existing Zod schemas (M8-04, M3-01, M2-01, M2-02) before being merged into the catalog layers as a new lowest-precedence-but-above-defaults layer; invalid files are refused as a whole package, never partially.
- **Publishing tooling** `tools/registry/`: `build-index.ts` (reads `registry/artifacts.yaml`, queries the npm packument for hashes and provenance flags, emits `ArtifactIndex`), `sign-index.ts` (ed25519, key from an env-provided file, never in the repo), `verify-index.ts`. CI workflow `registry.yml` runs build + verify on PRs to the registry source and publishes on tag.
- **Fixture registry** (extends M6-03's `pnpm registry:serve`): serves a signed artifact index, a fake npm packument + tarballs, plus tampered / yanked / engine-incompatible / provider-conflicting / unsigned samples, and the `POST /v1/drift-reports` endpoint used by M10-02.

### 4.5 API / UI surface
- `GET /api/plugins` · `GET /api/plugins/available?kind=` · `POST /api/plugins/install {source, name, version?, trust?}` (`Idempotency-Key`, RBAC Admin, audited) → 202 + progress over WS · `POST /api/plugins/:name/update` · `DELETE /api/plugins/:name?drain=true` · `POST /api/plugins/:name/verify` · `POST /api/plugins/index/refresh`.
- WS topic `plugins`: `{event:'progress'|'installed'|'refused'|'loaded'|'removed', name, version, step, trust, error?}`.
- CLI:
  - `orch plugin search <query> [--kind provider-plugin]`
  - `orch plugin install <name>[@range] [--from github:owner/repo#ref|--from ./dir] [--trust local] [--dry-run] [--json]`
  - `orch plugin list [--json]` · `orch plugin update [<name>] [--dry-run]` · `orch plugin remove <name> [--drain]`
  - `orch plugin verify <name>` (re-checks hashes, signature, engine ranges, tree hash; exit 0/2)
  - `orch plugin check [dir]` — **author-side**: validates `orchestra.plugin.json`, runs the full contract harness against the package's fixtures, reports what trust level it would receive and why. This is the command the Plugin Author Guide (M10-06) is built around.
- Web — **Plugins** screen: tabs per `ArtifactKind`; each row shows name, version, trust badge, engine range, repository, and install/update/remove. Install opens a preview drawer listing: source URL, sha512, provenance ✓/✗, engine check, static-check findings, what will be written, and — for `local` — a type-to-confirm field. The `local` dialog states plainly that the code runs with the daemon's privileges (ADR-014).

### 4.6 Flow / sequence
```
orch plugin install orchestra-provider-kimi@^1
 1 RefreshArtifactIndex → verifyEnvelope(index, TRUSTED_KEYS, daemonVersion)          [M6-03]
 2 resolveArtifactVersion({requested, candidates, daemonVersion, sdkVersion, cfg})     → CompatError?  stop
 3 deriveTrust({indexed, sha512Match?, provenance?, reviewed, source}) → level | refused
      level < plugins.minTrust  ⇒ refuse with the reason and the flag that would allow it
 4 EgressPolicy.assertAllowed(tarballUrl,'artifact-tarball') → fetch (size cap, timeout)
 5 sha512 == index.sha512 == dist.integrity ? continue : refuse (no write)
 6 provenance verify (repo == manifest.repository) ; unpack with --ignore-scripts semantics (our own tar)
 7 tree sha256 recorded ; ArtifactManifest Zod-validated ; declares.egressHosts == [] ; binaries ⊆ allowlist
 8 static checks → findings shown / blocking per trust level
 9 PluginHost.loadProvider → shape check → contract smoke on bundled fixtures
10 register in provider map (atomic) → plugin.installed + plugin.loaded + audit row → WS → Fleet row appears
 any failure at 4–9 ⇒ quarantine + plugin.install_refused ; nothing registered ; previous state untouched
remove: Rule C-4 (drain) → unloadProvider → store.remove → plugin.removed + audit
```

### 4.7 Review reconciliation contract (2026-09-15)
v1 runs trusted code only: official, reviewed verified, or explicitly administrator-trusted local artifacts by immutable hash, subject to org policy. Provenance establishes origin, not safety. Trust is checked before dynamic import, shape inspection requiring evaluation, bundled test execution or registration; contracts themselves are executable plugin code. Quarantined community artifacts may be inspected as inert data only and cannot self-promote. Third-party release proof uses a reviewed verified artifact or an explicitly trusted local artifact, never silently community. Untrusted plugin hosting is deferred until an isolated process boundary, resource limits, narrow RPC, credential isolation and revocation have been designed and tested.

## 5. Tasks
- [ ] Write `plan/adr/ADR-014-plugin-sandboxing.md` (decision: no runtime sandbox in v1; signature + trust + review + no-install-scripts + declarative `declares` as compensating controls; revisit trigger: before any untrusted community plugin code is executed). Add the `DECISIONS.md` row.
- [ ] `packages/sdk/src/registry/`: `ArtifactManifest` + `ArtifactIndex` Zod schemas (`additionalProperties: false`), JSON-Schema export, `ArtifactKind` union, public README section.
- [ ] `packages/core/src/registry/compat.ts`: `resolveArtifactVersion` + `deriveTrust` (pure, 100 % branch, golden tables).
- [ ] Provider-id conflict + `minTrust` precedence rules in the settings engine (org may raise, user may not lower).
- [ ] `ArtifactFetcher` (npm packument + tarball, GitHub tarball, path) over the M6-03 client; two new `EgressReason`s; size caps.
- [ ] Provenance verification helper (Sigstore bundle → signer identity → repository match); absent/unverifiable ⇒ `provenance: false`, never an error.
- [ ] `PluginStore`: own tar extraction with traversal/symlink/absolute-path rejection, tree hashing, atomic install dir, quarantine with TTL.
- [ ] Static-check scanner + findings model; blocking rules per trust level.
- [ ] `PluginHost.loadProvider/unloadProvider/loadData` with atomic DI map swap and Rule C-4 drain.
- [ ] Contract smoke runner (reuse `packages/sdk/src/contract/` harness against the plugin's `fixturesDir`).
- [ ] Use cases `RefreshArtifactIndex`, `InstallArtifact`, `UpdateArtifact`, `RemoveArtifact`, `VerifyArtifact`, `ListArtifacts` + `installed_artifacts` migration + event registration.
- [ ] Data-artifact loading path: skills → M8-04 store, playbooks → M3-01 loader, policies → M8-01 layer, model catalog → M2-02 loader; all-or-nothing validation.
- [ ] HTTP controllers + WS topic `plugins` + OpenAPI; RBAC Admin; audit coverage.
- [ ] CLI `orch plugin search|install|update|remove|list|verify|check` with `--json` and `--dry-run`.
- [ ] Web Plugins screen + install preview drawer + type-to-confirm `local` dialog (EN + AR, RTL).
- [ ] `tools/registry/` build/sign/verify index + `registry.yml` workflow; registry source-of-truth `registry/artifacts.yaml`.
- [ ] Extend `pnpm registry:serve`: artifact index, fake npm packument/tarballs, tampered + yanked + engine-incompatible + unsigned + conflicting samples, `POST /v1/drift-reports` (M10-02) with the k ≥ 3 publication threshold.
- [ ] Templates: `examples/provider-plugin-template/` (builds on `FakeProvider`, passes `orch plugin check`) and `examples/skill-pack-template/`.
- [ ] `docs/registry-policy.md`: acceptance criteria, review process for `verified`, de-listing and yank policy, C4 prohibition (no credential handling, no token proxying, no account rotation), drift-advisory attribution.
- [ ] Extend the M0-08 egress test: plugins disabled ⇒ zero egress; enabled ⇒ index + npm host only; GitHub host only with an explicit `--from github:`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M10-03-01 | unit | `resolveArtifactVersion` matrix: range miss, yanked, prerelease with/without opt-in, `engines.orchestra` too high, `sdkRange` mismatch, de-listed | exactly one `CompatError` code per row, with the rejected-candidate list; 100 % branch |
| UT-M10-03-02 | unit | `deriveTrust` over the four-row table plus: index entry but sha mismatch, provenance missing, GitHub source, `minTrust` floor | `official/verified/community/local` or a named refusal; never upgrades trust after load |
| UT-M10-03-03 | unit | `ArtifactManifest` schema: unknown property, `declares.egressHosts: ['x']`, provider name not matching `orchestra-provider-*`, missing `engines.orchestra` | each rejected with a distinct Zod issue path |
| UT-M10-03-04 | unit (fast-check) | tar entry names: `../`, absolute, symlink to `/etc`, device file, 3 000-char path | every one rejected; extractor never writes outside the target dir; never throws uncaught |
| UT-M10-03-05 | unit | settings precedence: org `minTrust: 'verified'`, user `minTrust: 'local'` | effective `verified`; user lowering is rejected with a named error |
| AT-M10-03-01 | application | `InstallArtifact` happy path from the fixture registry (provider plugin) | installed, loaded, registered; `plugin.installed` + `plugin.loaded` + audit row with trust `verified` |
| AT-M10-03-02 | application | tampered tarball (sha512 differs from index) | `install_refused`, quarantine dir created, nothing loaded, provider map unchanged |
| AT-M10-03-03 | application | plugin whose bundled fixtures fail the contract smoke | `ContractSmokeFailed` with failing spec ids; not registered; directory quarantined |
| AT-M10-03-04 | application | second plugin claiming an existing `providerId` | `ProviderIdConflict`; first-party plugin still active |
| AT-M10-03-05 | application | `RemoveArtifact` while a session of that provider runs, with and without `--drain` | `PluginInUse` listing session ids; with drain, removal happens after the session ends; no session killed |
| AT-M10-03-06 | application | skill-pack install with one invalid skill file | whole package refused; no partial skills registered |
| IT-M10-03-01 | integration | fixture registry end-to-end: refresh index → install → restart daemon | plugin still loaded from `~/.orchestra/plugins` after restart; `orch plugin verify` exit 0; file modes 0600/0700 |
| IT-M10-03-02 | integration | hot load while other sessions run | new provider appears on Fleet over WS in < 5 s; existing panes untouched; no daemon restart |
| IT-M10-03-03 | integration | egress test: plugins enabled/disabled; `--from github:` | disabled ⇒ zero sockets; enabled ⇒ index + npm only; GitHub host only on explicit GitHub source; any other host fails the build |
| IT-M10-03-04 | integration | package with a `postinstall` script and a runtime dependency | script never executes (proven by an absent sentinel file); `UnbundledDependencies` refusal |
| E2E-M10-03-01 | e2e | Plugins screen: install preview → install → Fleet row → remove | preview lists sha512, provenance, engine check, static findings; trust badge correct; removal clears the Fleet row |
| CT-M10-03-01 | contract | `examples/provider-plugin-template` through `orch plugin check` | manifest valid, full contract harness green, reported trust `local` with the reason |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-03-01 | Install a signed provider plugin from the registry | 1. `pnpm registry:serve`. 2. `orch plugin install orchestra-provider-demo --json`. 3. `orch plugin list`. 4. Open Fleet. | Trust `verified`, sha512 + provenance shown, contract smoke green, provider row appears without a daemon restart; elapsed install < 30 s | ⬜ |
| TC-M10-03-02 | Install from a GitHub repo | 1. `orch plugin install --from github:<you>/orchestra-provider-demo#v0.1.0 --trust local`. 2. Read the confirmation dialog. | Type-to-confirm required; dialog states the code runs with daemon privileges (ADR-014); after confirming, install proceeds and is audited with trust `local` | ⬜ |
| TC-M10-03-03 | **Negative: unsigned / not in the index** | 1. Serve a plugin that is absent from the signed index. 2. `orch plugin install orchestra-provider-rogue`. | Refused before any download completes; message names the missing index entry and the `--trust local` escape hatch; nothing under `~/.orchestra/plugins/` | ⬜ |
| TC-M10-03-04 | **Negative: incompatible engine version** | 1. Publish `orchestra-provider-demo@2.0.0` with `engines.orchestra: ">=9"`. 2. `orch plugin install orchestra-provider-demo@2`. | `EngineIncompatible` naming required `>=9` and the daemon version; exit 2; the 1.x install stays active and loaded | ⬜ |
| TC-M10-03-05 | **Negative: tampered tarball** | 1. Alter one byte of a tarball after the index was signed. 2. Install. | sha512 mismatch; refused; quarantine directory created with the reason; `plugin.install_refused` event; provider map unchanged | ⬜ |
| TC-M10-03-06 | **Negative: forbidden declaration** | 1. Publish a plugin with `declares.egressHosts: ["api.openai.com"]` and a `postinstall` script. 2. Install. | Refused on the declaration alone (C2); the script never runs (sentinel file absent); audit row records both findings | ⬜ |
| TC-M10-03-07 | **Negative: contract smoke fails** | 1. Publish a plugin whose `fixtures/` contradict its manifest. 2. Install. | `ContractSmokeFailed` with the failing spec ids; not registered; Fleet unchanged | ⬜ |
| TC-M10-03-08 | Update and rollback-by-remove | 1. Install 1.0.0, then `orch plugin update orchestra-provider-demo`. 2. `orch plugin list`. 3. `orch plugin remove orchestra-provider-demo` then reinstall `@1.0.0`. | Update loads 1.1.0 hot; old version directory retained until removal; reinstall of 1.0.0 works offline from the store | ⬜ |
| TC-M10-03-09 | Remove with a live session | 1. Start a session on the installed provider. 2. `orch plugin remove <name>`. 3. Retry with `--drain`. | First attempt refused with `PluginInUse` and the session id; with `--drain` removal waits for the session to end; the session is never killed | ⬜ |
| TC-M10-03-10 | Data artifacts | 1. `orch plugin install orchestra-skills-flutter` and `orchestra-playbooks-release`. 2. Open Skills and Settings › Playbooks. | Skills appear with their trust level (M8-04); playbook is selectable in Missions; an invalid file in the pack would refuse the whole pack (verify with the bad sample) | ⬜ |
| TC-M10-03-11 | Author workflow | 1. Copy `examples/provider-plugin-template` to a new repo. 2. `orch plugin check .`. 3. Break the manifest and re-run. | Check reports manifest OK, contract harness green, trust that would be granted; after breaking, it names the exact field and exits 2 | ⬜ |
| TC-M10-03-12 | Offline | 1. Install two artifacts. 2. Disable the network. 3. Restart the daemon; `orch plugin list`; `orch plugin verify <name>`. | Both load from the store; verify passes offline against recorded hashes; no error surfaced; index age shown as stale | ⬜ |

### 6.3 Review regression scenarios
- [ ] Community plugin with top-level side effect is quarantined before import.
- [ ] Community bundled contract harness is never executed in daemon.
- [ ] User cannot lower org trust floor or enable community through settings.
- [ ] Update changes artifact hash: local trust must be explicitly renewed.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] A provider plugin that is not in the signed index, whose hash does not match, whose `engines.orchestra` excludes the daemon, or whose contract smoke fails is **never loaded** (TC-03, TC-04, TC-05, TC-07).
- [ ] No plugin install ever executes package lifecycle scripts, and no plugin may declare egress hosts or non-allowlisted binaries (TC-06, IT-04).
- [ ] `resolveArtifactVersion` and `deriveTrust` have 100 % branch coverage; the tar extractor has a fuzz test proving no write escapes the target directory.
- [ ] A successful install hot-registers the adapter in < 30 s with no daemon restart and no disturbance to running sessions (TC-01, IT-02).
- [ ] `orch plugin check` on `examples/provider-plugin-template` is green and is the command the Plugin Author Guide (M10-06) references.
- [ ] Every install / update / remove writes an audit row carrying the source, sha512, provenance result and trust level.
- [ ] ADR-014 accepted and linked from `DECISIONS.md`, `SECURITY.md` and the docs security page; the `local` install dialog states the privilege model.
- [ ] `docs/registry-policy.md` published, including the C4 prohibition and the de-listing/yank process.
- [ ] Egress test extended and green: zero egress when disabled; index + npm only when enabled; GitHub only on explicit request (C2).
- [ ] All TC-M10-03-01 … 12 pass and are recorded; no new lint / dependency-cruiser violations.

## 8. Risks / open questions
- **ADR-014 is the biggest accepted risk in the product.** Plugin code runs in-process with the daemon, which owns tmux, the DB and the token. The compensating controls are metadata-level. Revisit triggers are written into the ADR; an isolated process with restricted credentials/filesystem/network and narrow RPC is required before untrusted execution; worker threads and node:vm are not security boundaries.
- npm provenance verification depends on Sigstore tooling and on the attestation being published; if the toolchain is unavailable at runtime the trust level degrades rather than failing — confirm the exact verification API and offline behaviour **(verify against npm provenance / Sigstore docs at step start)**.
- `minEngine` in the manifest index (M6-03) and `engines.orchestra` here must use one range dialect — M6-03's log already flagged this. Decision for implementation: both are npm-style semver ranges evaluated by the same helper; add a migration note if M6-03 shipped a different spelling.
- Key custody: the artifact index and the manifest index should use **different** signing keys with different roles so a leak is contained; both are pinned in the SDK, so rotation is an SDK release (M6-03 §4.1).
- Registry availability becomes a product dependency for third parties; the client must stay fully functional offline from the store (TC-12), and the launch checklist (M10-07) must cover hosting, backups and key custody.
- Third-party plugins can be abandoned. The index carries `deListed` and yank flags, and Health should warn when an installed plugin's repository is archived — the archived-repo check is post-1.0.
- Review capacity for the `verified` tier is a human bottleneck; the policy document must state the SLA honestly (best-effort at 1.0) so unreviewed community artifacts remain quarantined; review delay never relaxes load policy.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
