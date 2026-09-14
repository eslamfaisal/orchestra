# Step M7-02 — Signing, notarization, updater

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M7-01 (Tauri shell + sidecar build manifest), M0-08 (CI & quality gates), M6-07 (Health screen — the update card lands there) |
| Estimated effort | 2.5 days |
| Packages touched | `apps/desktop` (`src-tauri/entitlements.plist`, updater config, update UI plugin wiring), `apps/web` (update banner + Health → Updates card), `apps/daemon` (`GET /api/v1/updates/state` passthrough), `tools/scripts` (`sign-bundle.sh`, `verify-bundle.sh`, `make-manifest.ts`), `.github/workflows/release.yml`, `docs/deployment/` |
| Risk | High (notarization rejections are slow; a bad updater key is unrecoverable) |
| Owner | |

## 1. Goal
The app becomes distributable. Every Mach-O inside the bundle — the Tauri binary, both Node sidecar runtimes, `better_sqlite3.node`, `pty.node`, `spawn-helper` — is signed with the Developer ID Application certificate under a hardened runtime with an explicit, minimal entitlements list; the `.dmg` is notarized by Apple and the ticket is stapled; a clean Mac installs and launches it with **zero Gatekeeper dialogs**. The app then updates itself through the Tauri updater against a signed `latest.json` manifest, using a signing key that lives outside the repository, with a **download → verify → swap** order that never deletes the working installation before the replacement has been verified, a staged-rollout percentage, an OS-floor check, and a documented rollback. A tampered or wrongly-signed update is refused and the old version keeps running.

## 2. Why
- **D1** makes the desktop app a first-class surface; an unsigned app is not a surface, it is a support ticket. The 1.0 Definition of Done (ROADMAP, source plan §20) names "Tauri signed/notarized, safe updater" explicitly.
- **Source plan §10.1** specifies the update channel contract for the app/daemon artifact: GitHub Releases, signed, notarized, Tauri updater, **never delete-before-verify**, staged rollout, OS-floor check, applied on quit or user choice. This step is the literal implementation of that row.
- **C2** allows exactly one piece of egress here: the update check. Everything else the app fetches stays on `127.0.0.1`. The update endpoint is the only host added to the egress allowlist test.
- **R9 (supply chain)**: a self-updating binary is the highest-value target in the product. Separate signing keys (Apple's for identity, ours for update payload integrity), secrets isolation in CI, and provenance are security controls, not release polish.
- **G6/D6** ("the platform maintains itself", independent, signed, rollbackable update channels): the app channel must behave like the manifest and catalog channels do in M6.
- **C13/C3**: no certificate, key, or App Store Connect credential may ever appear in a log, an artifact, or a bundled file.

## 3. Scope
### In scope
- Hardened-runtime entitlements file and the inside-out signing order for every Mach-O and the app bundle.
- `notarytool submit --wait` + `stapler staple` for the `.dmg` (and the `.app` inside it); `spctl` and `codesign --verify --deep --strict` verification gates.
- `.dmg` packaging (background image, `/Applications` symlink) for arm64 and x64.
- Tauri updater: `latest.json` manifest schema, a dedicated ed25519 updater keypair (generated with `tauri signer generate`), public key embedded in `tauri.conf.json`, private key in a password manager + CI secret only.
- **Never delete-before-verify** install order, enforced and tested.
- Staged rollout: a `rollout` percentage in the manifest and a stable per-install bucket derived from the install id.
- OS-floor check: refuse to offer an update whose `minimumSystemVersion` exceeds the running OS, with a clear "this Mac stays on N" message.
- Rollback: pinned previous release kept on GitHub Releases, `orchestra://update/pin?version=` handling, and a documented manual downgrade path.
- Update UX: Health → Updates card, non-modal banner, "Install on quit" vs "Install and relaunch", release notes, skip-this-version, changelog link.
- `release.yml` workflow: matrix build (arm64, x64), sign, notarize, staple, sign the update payload, generate + sign `latest.json`, create the GitHub Release, attach SBOM and provenance; secrets scoped to the single job that needs them.
- `docs/deployment/desktop-release.md`: runbook, key custody, rotation procedure, incident procedure for a leaked key.
### Out of scope (deferred to …)
- Homebrew cask, npm provenance for the CLI, semantic-release wiring for the whole repo — **M10-07**.
- Windows/Linux signing (Authenticode, AppImage/`.deb`) — **M10-07**.
- Signed capability manifests / registry artifacts and the Sigstore-vs-minisign choice (ADR-006) — **M6-03**; this step uses the Tauri updater's own ed25519 scheme and does not pre-empt ADR-006.
- Delta/patch updates — not planned before 1.0; full-bundle updates only.
- Auto-update of the `orch` CLI — **M7-06** documents `brew upgrade` / `pnpm add -g` instead.
- Enterprise MDM/notarized-installer (`.pkg`) distribution — **M9-06**.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No core domain changes. One application-level read model, surfaced on Health (M6-07) alongside the other update channels:

```ts
// packages/sdk/src/updates/app-update.ts
export type AppUpdateState =
  | { status: 'idle'; currentVersion: string; lastCheckedAt?: string }
  | { status: 'available'; currentVersion: string; version: string; notes: string; pubDate: string; sizeBytes: number }
  | { status: 'downloading'; version: string; downloadedBytes: number; totalBytes: number }
  | { status: 'verified'; version: string; readyToInstall: true }
  | { status: 'blocked'; reason: 'os-floor' | 'not-in-rollout' | 'signature-invalid' | 'download-failed'; detail: string }
  | { status: 'installing'; version: string };
```
Rules (pure, unit-testable, 100 % branch):
- `isEligible(manifest, { osVersion, installBucket, currentVersion })` returns `false` when `semver.lt(osVersion, manifest.minimumSystemVersion)` (→ `os-floor`), when `installBucket >= manifest.rollout` (→ `not-in-rollout`), or when `semver.lte(manifest.version, currentVersion)`.
- `installBucket` = `sha256(installId) mod 100`, stable for the life of the install (`installId` is the existing `hosts.id` ULID). A user who clicks "Check for updates" manually bypasses the rollout gate; an automatic check does not.
- A downloaded artifact is only ever moved into place after signature verification returns ok; a failed verification deletes the *download*, never the installation.

### 4.2 Interfaces / contracts
`latest.json` (the Tauri updater manifest, extended with fields the app reads itself):
```jsonc
{
  "version": "0.7.0",
  "notes": "…markdown release notes…",
  "pub_date": "2026-11-03T10:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<base64 ed25519 sig of the .tar.gz>", "url": "https://github.com/<org>/orchestra/releases/download/v0.7.0/Orchestra_0.7.0_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "…_x64.app.tar.gz" }
  },
  "orchestra": { "minimumSystemVersion": "14.0", "rollout": 25, "minUpdatableFrom": "0.5.0", "sha256": { "darwin-aarch64": "…" } }
}
```
```ts
// apps/desktop/src-tauri/src/updater.rs (shape, expressed in TS for the plan)
interface UpdateService {
  check(opts: { manual: boolean }): Promise<Result<AppUpdateState, UpdateError>>;
  download(version: string, onProgress: (b: number, total: number) => void): Promise<Result<StagedUpdate, UpdateError>>;
  verify(staged: StagedUpdate): Promise<Result<VerifiedUpdate, UpdateError>>;  // ed25519 over the archive + sha256 compare
  install(v: VerifiedUpdate, mode: 'on-quit' | 'relaunch'): Promise<Result<void, UpdateError>>;
  pin(version: string): Promise<Result<void, UpdateError>>;  // rollback helper
}
type UpdateError = 'network' | 'signature-invalid' | 'hash-mismatch' | 'os-floor' | 'not-in-rollout'
                 | 'disk-space' | 'install-failed' | 'permission-denied';
```
Entitlements (`src-tauri/entitlements.plist`) — minimal set, each with a written reason:
| Key | Value | Why |
|---|---|---|
| `com.apple.security.cs.allow-jit` | true | JavaScriptCore in WKWebView |
| `com.apple.security.cs.allow-unsigned-executable-memory` | true | Node/V8 in the sidecar "(verify: try removing it and re-notarize; drop if the sidecar still runs)" |
| `com.apple.security.cs.disable-library-validation` | true | the sidecar `dlopen`s `better_sqlite3.node` / `pty.node`, signed with our Developer ID but loaded by the bundled Node binary "(verify: may be unnecessary once every addon is signed with the same Team ID)" |
| `com.apple.security.cs.allow-dyld-environment-variables` | **false / omitted** | not needed; omitting narrows the attack surface |
| `com.apple.security.inherit` | — | not used; the sidecar gets its own entitlements file with only the two `cs.*` keys it needs |
| `com.apple.security.network.client` | true | update check + the daemon's own outbound calls (GitHub PR API, Web Push) |
| `com.apple.security.network.server` | true | the daemon listens on `127.0.0.1` |
| `com.apple.security.files.user-selected.read-write` | true | the folder picker (M7-01) and git worktrees under the chosen repo |
App sandbox (`com.apple.security.app-sandbox`) is **not** enabled: the daemon spawns `tmux` and vendor CLIs from the user's `PATH`, which the sandbox forbids. This is recorded as a deliberate decision in the release runbook; Developer ID distribution does not require the sandbox.

### 4.3 Data / schema changes
None. `AppUpdateState` is in-memory in the shell; the last check timestamp and any skipped version go to `~/.orchestra/config.yaml` under `desktop.updates`:
```yaml
desktop:
  updates:
    channel: stable        # stable | beta  (beta reads latest-beta.json)
    autoCheck: true
    checkIntervalHours: 6
    autoDownload: true     # download + verify automatically; never installs without consent
    skippedVersion: null
    pinnedVersion: null
```

### 4.4 Infrastructure (signing, notarization, CI)
**Signing order (inside-out; `tools/scripts/sign-bundle.sh`)** — driven by the artifact manifest emitted by M7-01's `build-sidecar.sh`, so nothing is signed by glob and nothing is missed:
1. `resources/daemon/native/<arch>/*.node`, `spawn-helper`, any other nested Mach-O.
2. `binaries/orchestrad-<triple>` (the bundled Node runtime) — with the sidecar entitlements file.
3. Any framework/dylib Tauri stages.
4. `Contents/MacOS/Orchestra` — with `entitlements.plist`.
5. The `.app` bundle itself, `--options runtime --timestamp --sign "Developer ID Application: <name> (<TEAMID>)"`.
6. `verify-bundle.sh`: `codesign --verify --deep --strict --verbose=4 Orchestra.app` and `codesign -d --entitlements :- Orchestra.app` diffed against the checked-in expected entitlements (a test, not a glance).
7. Build the `.dmg`, sign it, `xcrun notarytool submit --wait --key … --key-id … --issuer …`, then `xcrun stapler staple` the `.dmg` **and** the `.app` inside it; `spctl -a -vvv -t install` on the result.

**CI (`release.yml`)**, triggered on tag `v*`:
```
jobs:
  build:      matrix [aarch64-apple-darwin, x86_64-apple-darwin] on macos runners
              → pnpm build → build-sidecar.sh → tauri build (unsigned) → upload artifact
  sign:       needs build; runs ONLY on macos; secrets: APPLE_CERT_P12, APPLE_CERT_PASSWORD,
              APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER
              → import cert into a temporary keychain (deleted in `always()` teardown)
              → sign-bundle.sh → notarize → staple → verify-bundle.sh → upload signed artifacts
  updater:    needs sign; secrets: TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
              → tar the .app → `tauri signer sign` → make-manifest.ts (version, notes from CHANGELOG,
                 rollout from the tag's `rollout:` trailer or default 10) → upload latest.json
  release:    needs updater; creates the GitHub Release, attaches .dmg, .tar.gz, latest.json,
              SBOM (CycloneDX), SLSA provenance; marks prerelease for beta channel tags
```
Secrets isolation rules, all asserted by a workflow-lint test: no `secrets.*` in the `build` job; `TAURI_SIGNING_PRIVATE_KEY` appears in `updater` only; every job sets `permissions:` to the minimum (`contents: write` only in `release`); no `pull_request_target`; the workflow never runs on forks; `set -x` is forbidden in signing scripts; every script uses `--keychain` with a throwaway keychain path.

**Key custody**: the Apple certificate and the updater private key are generated on the dev machine, stored in the password manager, and never committed. `.gitignore` gets `*.p12`, `*.p8`, `*.key`; a `gitleaks`/`trufflehog` CI check (already part of M0-08's hygiene) covers the rest. Rotation: publish a version signed with the **old** key that embeds **both** public keys, wait for adoption, then switch — documented, because the updater trusts only the key compiled into the running app.

**Staged rollout operations**: `rollout` starts at 10, is raised by editing `latest.json` in the release assets (a small `scripts/bump-rollout.ts`), and is dropped to 0 to halt a bad release. Halting does **not** roll anyone back; rollback is a new higher version built from the previous tag, plus the documented manual `.dmg` reinstall for affected users.

### 4.5 API / UI surface
- Web: Health → **Updates** card gains an "Application" row next to the M6 rows (manifests, catalog, plugins): current version, channel, state, last check, actions (Check now, Download, Install and relaunch, Install on quit, Skip this version, Release notes). A non-modal banner appears when `status = 'verified'`.
- Tauri: `update://` internal events bridged to the web app over the daemon's WS as a `updates` topic message (the shell posts state to `POST /api/v1/updates/state`, the daemon fans it out) — so the browser UI and the desktop UI render the same card without extra IPC surface.
- Deep links: `orchestra://update` opens the Updates card; `orchestra://update/pin?version=0.6.3` sets `pinnedVersion` after a confirm.
- CLI: `orch doctor` (M6-01) gains an `app.update_channel` check reporting current version, channel and whether the last check succeeded.

### 4.6 Flow / sequence
```
timer (every checkIntervalHours) or user "Check now"
 → GET https://github.com/<org>/orchestra/releases/latest/download/latest.json   [ONLY allowed egress]
 → parse + validate (Zod) → isEligible(osVersion, installBucket, currentVersion)
      os-floor / not-in-rollout / already current → state = blocked|idle (logged, shown on Health)
 → autoDownload → download .tar.gz to ~/Library/Caches/dev.orchestra.app/updates/<version>/
 → VERIFY: ed25519 signature over the archive with the embedded public key  +  sha256 compare
      invalid → delete the DOWNLOAD only → state = blocked{signature-invalid} → installation untouched
 → state = verified → user chooses:
      "Install and relaunch"  → stop sidecar per quitBehaviour → tauri updater swaps the bundle
                                 (new bundle staged beside the old; old removed only after the new
                                  one is in place and verified) → relaunch → new version boots
      "Install on quit"       → staged; applied on the next ⌘Q
 → on next launch: version recorded, `app.updated` audit event, release notes shown once
failure during swap → previous bundle left intact; state = blocked{install-failed} with the log path
```

## 5. Tasks
- [ ] Create the Developer ID identity in the login keychain; export `.p12`; create the App Store Connect API key; store all three in the password manager; record fingerprints (not secrets) in `docs/deployment/desktop-release.md`.
- [ ] `tauri signer generate` the updater keypair; put the **public** key in `tauri.conf.json`, the private key in the password manager and the CI secret store only.
- [ ] Write `src-tauri/entitlements.plist` and `src-tauri/entitlements-sidecar.plist` with a comment per key; add `expected-entitlements.plist` used by the verification test.
- [ ] `tools/scripts/sign-bundle.sh` driven by the M7-01 artifact manifest (inside-out order, temporary keychain, no `set -x`).
- [ ] `tools/scripts/verify-bundle.sh`: `codesign --verify --deep --strict`, entitlements diff, `spctl -a -vvv`, list any unsigned Mach-O found by `find … -perm +111 | file`.
- [ ] `.dmg` layout (background, `/Applications` symlink, window size) for both arches.
- [ ] Notarization step with `notarytool --wait`; on rejection, fetch and print the log JSON (redacted) as a CI artifact.
- [ ] `tools/scripts/make-manifest.ts`: build `latest.json` from the tag, CHANGELOG, signatures and hashes; Zod schema + fixture test.
- [ ] Rust `UpdateService`: check/download/verify/install with the never-delete-before-verify ordering and explicit error mapping.
- [ ] Eligibility rules module (pure TS, shared with the web UI for display) with 100 % branch coverage: OS floor, rollout bucket, `minUpdatableFrom`, skipped/pinned version.
- [ ] `POST /api/v1/updates/state` + `updates` WS topic + Health → Updates card + banner + release-notes dialog (EN/AR).
- [ ] `release.yml` with the four jobs and the secrets-isolation rules; a workflow-lint test asserting them.
- [ ] Egress allowlist: add the releases host to the `no-vendor-endpoints` allowlist module and extend M0-08's egress test to prove nothing else is contacted during an update check.
- [ ] `docs/deployment/desktop-release.md`: runbook, key custody, rotation, rollout bump/halt, rollback, leaked-key incident procedure.
- [ ] Dry run: cut `v0.7.0-rc.1` to a private repo/prerelease, do the full clean-Mac install and update round-trip before the real tag.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-02-01 | unit | `isEligible`: OS 13.6 vs `minimumSystemVersion 14.0` | `blocked{os-floor}`; no download attempted |
| UT-M7-02-02 | unit | rollout bucketing: 1000 synthetic install ids at `rollout: 25` | 25 % ± 3 % eligible; the same id is always in the same bucket across runs |
| UT-M7-02-03 | unit | manual check with `rollout: 0` | eligible (manual bypasses rollout); automatic check with the same input → `not-in-rollout` |
| UT-M7-02-04 | unit | `latest.json` Zod schema against a malformed manifest (missing platform key, bad semver, rollout 150) | parse error; state stays `idle`; error logged with the field path |
| UT-M7-02-05 | unit | skipped / pinned version handling | skipped version never offered again automatically but still offered on manual check; pinned version blocks all upgrades with a visible reason |
| IT-M7-02-06 | integration (Rust) | `verify()` on an archive whose bytes were flipped | `signature-invalid`; the download file is deleted; the installed bundle path is untouched (checksum before/after identical) |
| IT-M7-02-07 | integration (Rust) | `install()` interrupted (process killed mid-swap, simulated by a failing move) | previous bundle still launchable; state `install-failed`; no partially written `.app` left in `/Applications` |
| IT-M7-02-08 | integration | entitlements diff: bundle signed by `sign-bundle.sh` vs `expected-entitlements.plist` | identical; test fails if a new entitlement appears without updating the expectation |
| IT-M7-02-09 | integration | unsigned-Mach-O scan of the built bundle | zero results; the test enumerates `.node`, `spawn-helper`, the Node runtime and the Tauri binary explicitly |
| IT-M7-02-10 | integration | workflow lint on `release.yml` | no secret referenced outside its job; `permissions` minimal per job; no `pull_request_target`; signing scripts contain no `set -x` |
| E2E-M7-02-11 | e2e | update check against a local fixture server serving `latest.json` | check → download → verify → `verified`; only the fixture host is contacted (egress assertion) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-02-01 | **Zero Gatekeeper dialogs on install** | 1. On a clean macOS user account (no dev tools, no keychain identities), download the `.dmg` over HTTPS in Safari 2. Mount it, drag Orchestra to `/Applications` 3. Launch from Finder 4. `spctl -a -vvv -t exec /Applications/Orchestra.app` | No "unidentified developer", no "damaged and can't be opened", no per-binary blocked dialogs; at most the standard first-open confirmation for a quarantined app; `spctl` prints `accepted, source=Notarized Developer ID` | ⬜ |
| TC-M7-02-02 | Notarization + stapling offline | 1. Disconnect the test Mac from the network 2. Launch the freshly installed app | App launches (the stapled ticket is used; no online check needed); `stapler validate /Applications/Orchestra.app` → "The validate action worked!" | ⬜ |
| TC-M7-02-03 | **Updater round-trip** | 1. Install 0.7.0 on the clean account 2. Publish 0.7.1 with `rollout: 100` 3. In the app, Health → Updates → Check now 4. Download → Install and relaunch | Update found with release notes; download progress shown; state reaches `verified` before any install action is offered; app relaunches on 0.7.1; `app.updated` audit event present; tmux agents untouched throughout | ⬜ |
| TC-M7-02-04 | **Negative — bad signature** | 1. Replace the published `.tar.gz` with a byte-flipped copy (keep the old signature) 2. Check for updates 3. After the failure, launch the app again and check the version | Verification fails; UI shows "update rejected: signature invalid" with a Retry and a link to the release page; `/Applications/Orchestra.app` is unchanged and still launches; `ls ~/Library/Caches/dev.orchestra.app/updates/` shows the download removed | ⬜ |
| TC-M7-02-05 | **Negative — manifest signed with the wrong key** | 1. Sign an artifact with a freshly generated keypair not embedded in the app 2. Check for updates | Same refusal path as TC-04; the log names `signature-invalid`, not a generic network error | ⬜ |
| TC-M7-02-06 | **Negative — OS floor** | 1. Publish a manifest with `minimumSystemVersion: "99.0"` 2. Check for updates | "Not available for this Mac (requires macOS 99.0)"; no download; Health card shows `blocked{os-floor}`; automatic checks stop nagging | ⬜ |
| TC-M7-02-07 | Staged rollout | 1. Publish with `rollout: 0` 2. Automatic check on two installs 3. Click **Check now** manually on one of them | Automatic checks report "up to date"; the manual check offers the update; bumping to 100 makes both offer it on the next automatic check | ⬜ |
| TC-M7-02-08 | **Resilience — network dies mid-download** | 1. Start a download of a large release 2. Turn Wi-Fi off at ~50 % 3. Turn it back on and retry | Download fails cleanly with `download-failed`; no partial archive is ever verified or installed; retry resumes or restarts and completes; installed version unchanged until success | ⬜ |
| TC-M7-02-09 | **Resilience — disk full** | 1. Fill the disk to < 200 MB free 2. Attempt an update | `disk-space` error before download starts, with the required size in the message; installation untouched | ⬜ |
| TC-M7-02-10 | Install on quit | 1. Reach `verified` 2. Choose **Install on quit** 3. Keep working, then `⌘Q` 4. Relaunch | No interruption while working; on quit the swap happens; relaunch is on the new version; if `quitBehaviour = keep-daemon`, the old sidecar is stopped and the new one starts on next launch (recorded in the log) | ⬜ |
| TC-M7-02-11 | Rollback / pin | 1. On the new version run `open "orchestra://update/pin?version=0.7.0"` and confirm 2. Publish 0.7.2 3. Check for updates 4. Reinstall 0.7.0 from the release page `.dmg` | Pinned state visible on Health with a "pinned by you" note; 0.7.2 is not offered; the older `.dmg` installs over the newer app without Gatekeeper complaints and starts with the existing database intact | ⬜ |
| TC-M7-02-12 | Secrets hygiene | 1. Open the CI logs of a full release run 2. `grep -Ei 'BEGIN (EC|RSA|PRIVATE)|p12|issuer|-----BEGIN'` over every job log and every published artifact | No key material, no issuer id, no password; the temporary keychain is deleted in the teardown step even when the job fails | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Every Mach-O in the bundle is signed with the Developer ID Application identity under the hardened runtime; IT-M7-02-09 finds zero unsigned binaries.
- [ ] The entitlements list is minimal, documented key-by-key, and pinned by a diff test; any addition requires editing the expectation file in the same PR.
- [ ] `.dmg` is notarized and stapled for arm64 and x64; **TC-M7-02-01 (zero Gatekeeper dialogs) passes on a clean Mac** and the `spctl` output is saved in `evidence/`.
- [ ] Updater round-trip passes end-to-end (TC-M7-02-03) and the never-delete-before-verify ordering is proven by IT-M7-02-06/07 and TC-M7-02-04.
- [ ] Staged rollout, OS-floor check and pin/rollback all behave as specified and are visible on Health → Updates.
- [ ] The updater private key exists only in the password manager and the CI secret store; `release.yml` passes the secrets-isolation lint (IT-M7-02-10); no secret appears in any log or artifact (TC-M7-02-12).
- [ ] The only network host the app contacts for updates is the releases host, proven by the extended M0-08 egress test.
- [ ] `docs/deployment/desktop-release.md` covers the runbook, key custody, key rotation, rollout bump/halt, rollback and the leaked-key incident procedure.
- [ ] All TC pass; no new lint/arch violations; `PROGRESS.md` and `DECISIONS.md` (if an ADR was needed for the sandbox decision) updated.

## 8. Risks / open questions
- Whether `com.apple.security.cs.disable-library-validation` and `allow-unsigned-executable-memory` are actually required once every addon carries the same Team ID signature is unknown until tested — "(verify)" by removing each and re-notarizing. Every entitlement kept without proof is a permanent weakening of the hardened runtime, so this experiment is a task, not an option.
- Notarization can reject for reasons unrelated to the last change (Apple-side policy updates). Budget for two or three round-trips; keep the `notarytool` log artifact so rejections are diagnosable without a rebuild.
- Not enabling the App Sandbox is a deliberate, documented trade-off (the daemon must spawn `tmux` and vendor CLIs). If a future distribution channel requires the sandbox, the daemon would have to move outside the bundle entirely — record this in the runbook so it is not rediscovered later.
- The Tauri updater's install step is library code we do not control; the never-delete-before-verify guarantee therefore depends on the pinned Tauri version's behaviour. IT-M7-02-07 asserts the observable property rather than the implementation, and the Tauri version is pinned with a comment pointing at this test — "(verify the pinned version's swap implementation at step start)".
- Key rotation requires an app version that trusts two public keys; whether the pinned Tauri updater supports multiple trusted keys is unconfirmed — "(verify)". If it does not, rotation means a manual reinstall for all users, which must be stated in the runbook.
- `latest.json` served from GitHub Releases means GitHub availability is an update-availability dependency; acceptable for v1, revisit with the registry work in M10-03.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
