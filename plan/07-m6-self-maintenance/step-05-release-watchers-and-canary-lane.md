# Step M6-05 — Release watchers & canary lane

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M6-01 (Doctor, probes, fixtures), M6-03 (`EgressPolicy`, manifest cache), M1-03 (worktrees), M1-11 (Attention queue) |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon`, `apps/cli`, `apps/web`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step Orchestra learns about vendor CLI releases *before* they hurt. A `ReleaseWatcher` polls each provider's `manifest.updateSources` (releases feed, changelog) on an allowlisted egress path, compares the latest published version with the installed version and the active manifest's `cliVersionRange`, and turns a meaningful difference into a **"Provider Update"** item in the Attention queue that names the impacted manifests and a suggested action. Independently, whenever a CLI version actually changes on disk, the provider is marked **unverified** and a **canary lane** runs that version in an isolated scratch worktree — quota-free Doctor probes, the provider's contract fixtures, and (with explicit opt-in) one small smoke session — before the version is marked **verified**. Fleet and Health show a verified/unverified badge per provider, and a failed canary opens a `RepairCase` instead of letting the fleet discover the breakage task by task.

## 2. Why
- D6 / G6 — "vendor changes surfaced as actionable items"; `00-source-plan-v0.2.md` §10.2 names both the watchers and the canary lane as part of drift detection.
- R1 (score 20) — the cheapest mitigation for weekly vendor releases is knowing about them and testing them on purpose in a scratch repo rather than on real work.
- C2 — release feeds are new egress and therefore go through the `EgressPolicy` allowlist introduced in M6-03, with hosts taken from *verified* manifests only and the reason tag `release-feed`.
- C10 — a smoke session spends a little quota, so it is previewed and permissioned, never silent.
- UX principle 1 (attention over information) — a release becomes one Attention item with a suggested action, not a dashboard number nobody reads.
- `providers.verified` already exists in the schema (`04-domain-model.md` §4); this step is what finally writes it.

## 3. Scope
### In scope
- `ReleaseWatcher` scheduler + `ReleaseFeedClient` (conditional GET, size cap, timeout) reusing M6-03's egress-guarded HTTP client.
- Per-provider feed parsers in `packages/providers/<id>` (GitHub-releases JSON / Atom and plain changelog), returning a normalized `ReleaseEntry[]`.
- Pure `UpdateImpactRule` in `packages/core`: `(latestRelease, installedVersion, activeManifest) → UpdateImpact` with a `suggestedAction`.
- Attention item kind `provider_update` (dedupe per `(provider, version)`), and `provider.update_available` events (namespace already reserved in `04-domain-model.md` §3).
- Canary lane: `CanaryRun` entity, isolated scratch worktree, three gates (probes → contract fixtures → optional smoke session), `providers.verified` write, `provider.canary_completed` / `provider.canary_failed`.
- Fleet + Attention badges for verified/unverified; `orch watchers poll`, `orch canary run|status`.
- Feed + release fixtures for offline tests; FakeProvider release feed.
### Out of scope (deferred to …)
- Remediating what the canary finds — deferred to M6-04 (the canary calls `IngestDriftSignal` with `source: 'canary'`; the ladder does the rest).
- Updating the CLI itself — Orchestra never installs or upgrades a vendor binary (C1); the suggested action tells the user what to run.
- Auto-fetching a newer manifest on a release — deferred to M6-03/M6-04 (`RegistryFix`); this step only *suggests* `refresh-registry`.
- Health screen rendering of updates and canary history — deferred to M6-07.
- Orchestra's own app update check and staged rollout — deferred to M7-02.
- Community staleness signalling back to the registry — deferred to M10-02.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/maintenance/updates/{release-entry.ts, update-impact.ts, canary-run.ts}` — pure.

`UpdateImpactRule.evaluate(input) → UpdateImpact` (each branch unit-tested):

| # | Condition | `severity` | `suggestedAction` |
|---|---|---|---|
| R-U1 | `latest === installed` | `none` | `none` (no item) |
| R-U2 | `latest > installed` and `latest` satisfies `activeManifest.cliVersionRange` | `info` | `update-cli` — safe to update; manifest already covers it |
| R-U3 | `latest > installed` and `latest` does **not** satisfy the range, but the registry advertises a manifest that does | `warn` | `refresh-registry` |
| R-U4 | `latest > installed`, outside the range, no matching manifest anywhere | `warn` | `wait-for-manifest` |
| R-U5 | `installed > latest` (prerelease/nightly on the machine) | `info` | `none` + note "installed version is ahead of the feed" |
| R-U6 | `installed` does not satisfy the active range **right now** | `critical` | `refresh-registry`, and the Doctor check `binary.version_in_range` is already failing (M6-01) |
| R-U7 | a canary for `installed` is pending or failed | `warn` | `canary-pending` / `canary-failed` |

Rules: **R-U8** semver comparison only; an unparsable feed version is ignored with a warning, never guessed. **R-U9** one Attention item per `(providerId, version, suggestedAction)`; a later poll updates it in place (no duplicates, no re-notification unless severity rises). **R-U10** an item is auto-resolved when the condition stops holding (user updated, manifest refreshed, canary passed). **R-U11** the watcher never reads anything but the feed body: no vendor APIs, no auth, no cookies (C2, C3).

`CanaryRun`: `requested → probing → fixtures → smoke → passed | failed | skipped`, with `gates: { probes, fixtures, smoke }` each `pass | fail | skipped`. **R-U12** a provider is `verified` only when every *non-skipped* gate passed and at least `probes` + `fixtures` ran. **R-U13** a version is `unverified` the moment `provider.version_changed` fires; sessions already running keep running (they are pinned to their manifest, M6-03) but the Fleet badge and any new `RoutingDecision` mark the provider `unverified` (the assignment engine does **not** exclude it — that would block all work; it records `unverified` in `reasons[]`). **R-U14** the smoke session runs only when `canary.smokeSession` is `auto`, or `ask` and the user approved the Attention item; it is skipped entirely for a provider whose `auth_status` is `logged_out` and for agy without `tos_acknowledged_at` (C11).

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/updates.ts   (optional adapter extension, like DoctorProbes)
export interface ReleaseFeedParser {
  /** Parse a feed body into normalized entries. Never throws; unknown shape ⇒ Result.err(ParseError). */
  parse(body: string, contentType: string): Result<ReleaseEntry[], ParseError>;
  /** Which updateSources keys this parser handles. */
  sources(): readonly ('releases' | 'changelog')[];
}
export interface ReleaseEntry { version: string; publishedAt: string; url: string;
  title?: string; excerpt?: string; prerelease?: boolean; }

// packages/core/src/maintenance/updates/update-impact.ts   (pure; 100 % branch)
export type UpdateSeverity = 'none' | 'info' | 'warn' | 'critical';
export type SuggestedAction = 'none' | 'update-cli' | 'refresh-registry' | 'wait-for-manifest' | 'canary-pending' | 'canary-failed';
export interface UpdateImpactInput {
  providerId: ProviderId; installedVersion: string | null; latest: ReleaseEntry | null;
  activeManifest: { manifestVersion: string; cliVersionRange: string } | null;
  registryCandidateRanges: readonly string[]; canary: { state: CanaryState; version: string } | null;
  allowPrerelease: boolean;
}
export interface UpdateImpact {
  providerId: ProviderId; severity: UpdateSeverity; suggestedAction: SuggestedAction;
  latestVersion: string | null; installedVersion: string | null;
  impactedManifests: readonly { manifestVersion: string; cliVersionRange: string; satisfies: boolean }[];
  note: string; ruleId: `R-U${number}`;
}
export declare function evaluateUpdateImpact(i: UpdateImpactInput): UpdateImpact;

// packages/core/src/maintenance/updates/canary-run.ts
export type CanaryState = 'requested' | 'probing' | 'fixtures' | 'smoke' | 'passed' | 'failed' | 'skipped';
export type GateResult = 'pass' | 'fail' | 'skipped';
export interface CanaryRun {
  id: string; hostId: string; providerId: ProviderId; cliVersion: string; manifestVersion: string | null;
  trigger: 'version_change' | 'manual' | 'update_item'; state: CanaryState;
  gates: { probes: GateResult; fixtures: GateResult; smoke: GateResult };
  worktreePath: string | null; startedAt: string; finishedAt: string | null; durationMs: number | null;
  evidence: { doctorReportId?: string; failedFixtures?: string[]; smokeSessionId?: string; error?: string };
}

// apps/daemon/src/application/ports/updates.ports.ts
export interface ReleaseFeedClientPort { fetch(url: URL, etag?: string): Promise<Result<{ status:'ok'; body: string; contentType: string; etag?: string } | { status:'not-modified' }, FeedError>>; }
export type FeedError = { code:'Unreachable' } | { code:'HttpStatus'; status:number } | { code:'TooLarge' } | { code:'Timeout' } | EgressDenied;
export interface CanaryRunRepository { save(r: CanaryRun): Promise<Result<void, StorageError>>;
  latest(p: ProviderId, cliVersion: string): Promise<Result<CanaryRun | null, StorageError>>;
  list(limit: number): Promise<Result<CanaryRun[], StorageError>>; }
export interface ContractFixtureRunner { run(p: ProviderId, cliVersion: string, cwd: string, timeoutMs: number): Promise<Result<{ passed: boolean; failed: string[]; total: number }, RunnerError>>; }
```
Use cases: `PollReleaseFeeds`, `EvaluateProviderUpdates`, `RunCanary`, `GetCanaryStatus`, `ResolveUpdateItem`.

### 4.3 Data / schema changes
- Migration `NNN-m6-05-canary-runs`: `canary_runs (id TEXT PK, host_id, provider_id, cli_version, manifest_version, trigger, state, gates_json, worktree_path, started_at, finished_at, duration_ms, evidence_json)`; index `(provider_id, cli_version, started_at DESC)`. `providers.verified` (exists) is written by `RunCanary`; add `providers.verified_at TEXT` and `providers.last_release_seen TEXT`.
- Feed cache on disk (not DB): `~/.orchestra/manifests-cache/feeds/<provider>-<sourceKey>.json` = `{etag, fetchedAt, entries: ReleaseEntry[]}` — reused by M10-01 as its `releaseNotes` input (it reads this cache, never the network).
- Events: `provider.update_available` `{providerId, latestVersion, installedVersion, severity, suggestedAction, impactedManifests, ruleId}`; `provider.update_resolved` `{providerId, version, why}`; `provider.canary_started|completed|failed` `{canaryId, providerId, cliVersion, gates, durationMs, evidence}`. Attention items are persisted by the M1-11 queue with `kind: 'provider_update'` and `payload = UpdateImpact`.
- Config `maintenance.watchers`: `{ enabled: true, intervalMs: 21600000, jitterPct: 10, timeoutMs: 10000, maxBytes: 524288, allowPrerelease: false }`. Config `maintenance.canary`: `{ enabled: true, smokeSession: 'ask' /* auto | ask | off */, scratchRepo: '~/orchestra-scratch', fixtureTimeoutMs: 300000, smokeTimeoutMs: 180000, keepWorktreeOnFailure: true, maxConcurrent: 1 }`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Feeds** (`apps/daemon/src/infrastructure/updates/release-watcher.ts`): for each enabled provider, for each key in the *verified* active manifest's `updateSources` (`releases`, `changelog`), `EgressPolicy.assertAllowed(url, 'release-feed')` → conditional GET through the same egress-guarded undici client as M6-03 (10 s timeout, 512 KB cap, no cookies, no credentials, ≤ 2 same-host redirects). Interval 6 h ± 10 % jitter, first poll at boot + 120 s, never more than one in-flight poll per provider. `Unreachable`/`Timeout` is a warn with exponential backoff, never a case.
- **Parsers** live in the provider packages (D5): GitHub releases JSON (`tag_name`, `published_at`, `prerelease`, `html_url`) and Atom, plus a plain-markdown changelog heading parser. The exact feed URLs and shapes for Claude Code, Codex and Antigravity come from each manifest's `updateSources` and are **(verify against Claude Code / Codex / Antigravity docs at step start)**; a source that cannot be parsed is dropped with a `warn` and the provider simply has no update item — we never scrape a vendor page for structure (C7).
- **Canary worktree**: `WorktreeManager` (M1-03) creates `<scratchRepo>/.orchestra/worktrees/canary-<provider>-<version>` on branch `canary/<provider>/<version>` from the scratch repo's base ref. Removed on pass; kept on failure when `keepWorktreeOnFailure` so the evidence survives for M10-01.
- **Gate 1 — probes**: `RunDoctor.execute({trigger:'canary', providerFilter:[p]})` (M6-01, `DoctorTrigger` already includes `'canary'`). Quota-free by construction. Fail ⇒ gate fail + `IngestDriftSignal(doctor_check_failed, source:'canary')`.
- **Gate 2 — fixtures**: `ContractFixtureRunner` runs the provider package's contract suite against the fixture set pinned to the *installed* version: `pnpm --filter ./packages/providers/<id> exec vitest run --reporter=json`, cwd = the canary worktree, env allowlist only, `fixtureTimeoutMs` 5 min. In a packaged (non-repo) install the suite ships as a prebuilt runner in the provider package; when neither is available the gate is `skipped` and the provider stays `unverified` (R-U12).
- **Gate 3 — smoke session**: one FakeProvider-shaped minimal task on the *real* provider — headless where `manifest.headless` allows, otherwise an interactive session with one scripted prompt round-trip — started through `SessionSupervisor` in the canary worktree, budgeted by `smokeTimeoutMs`, asserting: session reaches `running`, ≥ 1 normalized telemetry event parses, one command acks, session exits cleanly. Because it spends quota it obeys `canary.smokeSession`: `ask` (default) creates an Attention item **"Run smoke test for \<provider\> \<version\>? (~1 short task)"** with Approve/Skip and a preview of the exact argv (C10, UX principle 5); `off` skips; `auto` runs immediately. Never runs for a logged-out provider or agy without ToS acknowledgement (C11).
- **Concurrency**: a canary acquires the `MaintenanceLock` from M6-04 (or, if M6-04 has not landed yet in the parallel lane, the lock module is introduced here and M6-04 reuses it) so a ladder run and a canary never overlap. `maxConcurrent: 1` host-wide.
- **Trigger**: subscribe to `provider.version_changed` (M1-04) → set `verified = false`, `verified_at = null` → enqueue canary (debounce 5 s, same as the Doctor). Manual: `orch canary run <provider>`.

### 4.5 API / UI surface
- `GET /api/updates` → `UpdateImpact[]` (one per provider, severity-sorted). `POST /api/updates/:providerId/resolve` (audited, dismisses an item with a reason).
- `POST /api/canary/run` `{providerId}` (`Idempotency-Key`, audited) → 202 `{canaryId}`; `GET /api/canary/runs?provider=&limit=`; `GET /api/canary/runs/:id`.
- `POST /api/watchers/poll` `{providerId?}` (dev/manual trigger, audited).
- WS topic `health.updates`: `{event:'update_available'|'update_resolved'|'canary_started'|'canary_finished', providerId, payload}`.
- CLI: `orch watchers poll [--provider id]`, `orch canary run <provider> [--no-smoke]`, `orch canary status [--json]`, `orch updates list [--json]`.
- UI (small, the full Health view is M6-07): Attention item card `ProviderUpdateItem` (`apps/web/src/features/attention/items/`) — title "Provider Update: \<provider\> \<version\>", body "installed \<x\>, manifest range \<range\>", severity chip with icon + label (never colour alone), actions **Refresh registry** / **Run canary** / **Dismiss**, plus the smoke-approval variant with an argv preview. Fleet row (M1-10) gains a `verified` / `unverified · canary pending` / `unverified · canary failed` badge with a tooltip naming the failed gate. RTL-safe, keyboard reachable, `prefers-reduced-motion` respected.

### 4.6 Flow / sequence
```
A) watcher
timer/boot+120s | POST /api/watchers/poll
 → for each provider: EgressPolicy.assertAllowed(feedUrl,'release-feed')
 → ReleaseFeedClient.fetch(etag) → not-modified ⇒ stop
 → adapter.releaseFeed.parse(body) → ReleaseEntry[] → cache write
 → evaluateUpdateImpact({installed, latest, activeManifest, registryCandidateRanges, canary})
 → severity 'none' ⇒ resolve any open item ; else upsert Attention item (dedupe R-U9)
   → emit provider.update_available → ws health.updates

B) canary
provider.version_changed (debounce 5 s) | POST /api/canary/run
 → providers.verified = false ; emit provider.canary_started
 → MaintenanceLock.acquire('canary:<provider>')
 → WorktreeManager.create(canary-<provider>-<version>)
 → gate probes  : RunDoctor(trigger:'canary')            fail ⇒ IngestDriftSignal(source:'canary')
 → gate fixtures: ContractFixtureRunner.run(...)          fail ⇒ IngestDriftSignal(parse/contract evidence)
 → gate smoke   : per config 'auto' | 'ask'(Attention approval) | 'off'
 → all non-skipped gates pass ⇒ providers.verified = true, verified_at = now, emit provider.canary_completed
   else ⇒ state failed, emit provider.canary_failed, keep worktree, Attention item severity warn
 → release lock ; remove worktree on pass
```

## 5. Tasks
- [ ] `packages/core/src/maintenance/updates/`: `ReleaseEntry`, `UpdateImpact*`, `CanaryRun`, `CanaryState`, `GateResult` types.
- [ ] Pure `evaluateUpdateImpact()` implementing R-U1…R-U8; golden table; drive to 100 % branch coverage.
- [ ] `packages/sdk/src/updates.ts`: `ReleaseFeedParser` + optional `releaseFeed?` on `ProviderAdapter`; contract spec `updates.contract.spec.ts` (parse never throws; entries have semver-parsable versions or are dropped).
- [ ] Feed parsers for claude / codex / agy (GitHub JSON + Atom + markdown changelog) with recorded feed fixtures under `packages/providers/<id>/fixtures/<cliVersion>/feeds/`.
- [ ] `ReleaseFeedClient` over the M6-03 egress-guarded client (conditional GET, 512 KB cap, timeout, backoff).
- [ ] Feed cache store (`manifests-cache/feeds/`) with atomic writes, reused later by M10-01.
- [ ] `PollReleaseFeeds` + `EvaluateProviderUpdates` use cases; Attention item upsert/dedupe/auto-resolve (R-U9/R-U10).
- [ ] Event registration: `provider.update_available`, `provider.update_resolved`, `provider.canary_*`.
- [ ] Migration `canary_runs` + `providers.verified_at` / `last_release_seen`; repository.
- [ ] `RunCanary` use case + state machine with the three gates and R-U12/R-U13/R-U14 guards.
- [ ] `ContractFixtureRunner` (vitest JSON reporter, env allowlist, timeout, packaged-install fallback ⇒ gate `skipped`).
- [ ] Smoke-session runner through `SessionSupervisor` with argv preview + `smokeSession: ask` approval item (C10).
- [ ] `MaintenanceLock` integration (introduce here if M6-04 has not landed; otherwise reuse) + `maxConcurrent: 1`.
- [ ] Version-change subscription with 5 s debounce; `providers.verified` flip; Fleet badge.
- [ ] HTTP controllers + Zod DTOs + OpenAPI; WS topic `health.updates`.
- [ ] `apps/cli/src/commands/{watchers,canary,updates}.ts`.
- [ ] `ProviderUpdateItem` Attention card + Fleet verified/unverified badge in `apps/web` / `packages/ui`.
- [ ] FakeProvider release feed fixture + `orch doctor simulate release --provider fake --version X` support.
- [ ] Extend the M0-08 egress test: feed hosts allowed only when present in a verified manifest; any other host denied.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-05-01 | unit | `evaluateUpdateImpact` golden table over R-U1…R-U7 incl. prerelease with/without `allowPrerelease` | exact `severity`, `suggestedAction`, `ruleId`, `impactedManifests[].satisfies` per row; 100 % branch |
| UT-M6-05-02 | unit | R-U8: feed entry with version `"latest"` / `"v2026.09 build 7"` | dropped with a warning; no item; no throw |
| UT-M6-05-03 | unit (fast-check) | every provider `ReleaseFeedParser` over random/truncated bodies | always `Result`, never throws; entries either semver-parsable or absent |
| UT-M6-05-04 | unit | `CanaryRun` gate logic R-U12: probes pass, fixtures skipped, smoke pass | run `passed` but provider **not** verified (fixtures is mandatory); reason recorded |
| AT-M6-05-01 | application | two consecutive polls with the same latest version | one Attention item created, second poll updates in place; exactly one `provider.update_available` event |
| AT-M6-05-02 | application | user updates the CLI so the condition clears | item auto-resolved (R-U10) with `provider.update_resolved`; Attention queue empty |
| AT-M6-05-03 | application | `smokeSession: 'ask'` and the user skips | gate `skipped`; provider still `unverified`; no session started; no quota spent |
| AT-M6-05-04 | application | feed host not in any verified manifest | `EgressDenied` before any socket; poll marked failed; audit row; no item |
| IT-M6-05-01 | integration | full canary on FakeProvider after a simulated version bump | `canary_runs` row with three gates, worktree created and removed, `providers.verified = 1`, `provider.canary_completed` emitted |
| IT-M6-05-02 | integration | canary with a deliberately mutated fixture | fixtures gate fails, worktree kept, `IngestDriftSignal(source:'canary')` opens a `RepairCase`, provider stays `unverified` |
| IT-M6-05-03 | integration | conditional GET: second poll returns 304 | no parse, no event, `etag` reused, cache untouched |
| E2E-M6-05-01 | e2e | `orch doctor simulate release --provider fake --version 9.10.0` → `orch watchers poll` → `orch updates list --json` | one `provider_update` item with impacted manifests and `suggestedAction: wait-for-manifest`; visible in the Attention UI |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-05-01 | Provider Update item appears with the right action | 1. Append `9.10.0` to the FakeProvider feed fixture (installed 9.9.0, manifest range `^9.9`). 2. `orch watchers poll`. 3. Open Attention. | One item "Provider Update: fake 9.10.0", body shows installed 9.9.0 and range `^9.9`, impacted manifest listed, action `wait-for-manifest`; severity chip has icon + text | ⬜ |
| TC-M6-05-02 | Suggested action flips when the registry has a match | 1. Publish a `fake` manifest with range `^9.10` to the fixture registry. 2. `orch watchers poll`. | Same item updated in place to `refresh-registry` (R-U3); no duplicate item; one `provider.update_available` with the higher severity | ⬜ |
| TC-M6-05-03 | Auto-resolve | 1. With the item open, refresh the registry so the active manifest covers 9.10.0 and bump the installed version. 2. `orch watchers poll`. | Item disappears from Attention; `provider.update_resolved` event present; `orch updates list` empty | ⬜ |
| TC-M6-05-04 | Canary marks a new version verified | 1. `orch doctor simulate version-bump --provider fake --to 9.9.0`. 2. Watch Fleet. 3. `orch canary status --json`. | Badge goes `unverified` within 35 s, canary worktree `canary-fake-9.9.0` appears, gates probes+fixtures pass, badge flips to `verified`; worktree removed; `provider.canary_completed` | ⬜ |
| TC-M6-05-05 | **Negative: failing canary opens a case, not a silent pass** | 1. Mutate `packages/providers/fake/fixtures/<ver>/help/help.txt`. 2. `orch canary run fake`. 3. `orch drift list`; `ls` the canary worktree. | Fixtures gate fails; provider stays `unverified` with a tooltip naming the gate; a `RepairCase` opens with `source: canary`; worktree kept for evidence | ⬜ |
| TC-M6-05-06 | **Negative: quota is never spent without consent** | 1. Set `canary.smokeSession: 'ask'`. 2. Trigger a canary. 3. Read the Attention approval card, then click Skip. | Card shows the exact argv preview; no session starts until approval; after Skip the smoke gate is `skipped`, provider stays `unverified`, zero usage recorded in `usage_samples` | ⬜ |
| TC-M6-05-07 | **Negative: egress stays inside the allowlist** | 1. Edit a *local, unsigned* manifest override so `updateSources.releases` points at `https://api.openai.com/...`. 2. `orch watchers poll`. | The unsigned/unverified manifest is not used as an egress source; `EgressDenied` recorded with an audit row; no connection attempt in `tcpdump`/the egress harness; daemon healthy | ⬜ |
| TC-M6-05-08 | Resilience: feed offline / rate-limited / huge | 1. Point the feed at a server returning 503, then one returning a 5 MB body, then unplug the network. 2. Poll each time. | `HttpStatus`, `TooLarge`, `Unreachable` — all warns; exponential backoff visible in logs; no Attention item, no repair case, cached entries still served to `orch updates list` | ⬜ |
| TC-M6-05-09 | Resilience: canary during a ladder run | 1. Start a remediation ladder run (M6-04). 2. Immediately `orch canary run fake`. | The canary waits on the `MaintenanceLock`, then runs; the two never overlap (check `canary_runs.started_at` vs `repair_attempts` windows); no pane restarted twice | ⬜ |
| TC-M6-05-10 | **Timing: detection of a version change (TTD input)** | 1. `orch doctor simulate version-bump --provider fake --to 9.9.1`. 2. Compare `provider.version_changed.ts` with `provider.canary_started.ts` and with the Fleet badge flip. | Badge `unverified` and canary started within **≤ 40 s** (30 s watcher + 5 s debounce + start); full canary (probes+fixtures, no smoke) completes in < 6 min; record both numbers | ⬜ |
| TC-M6-05-11 | Real feed sanity (one provider) | 1. With claude installed and logged in, enable watchers for claude only. 2. `orch watchers poll --provider claude`. 3. `orch updates list --json`. | The feed parses, the latest version is plausible and semver-parsable, the item (if any) names the real installed version; zero requests to any host other than the manifest's `updateSources` host | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-05-01 … 11 pass and are recorded with build hash and date.
- [ ] `evaluateUpdateImpact` has 100 % branch coverage; every provider feed parser passes the fuzz contract spec.
- [ ] A new feed release produces exactly one Attention item with impacted manifests and a correct `suggestedAction`, updated in place and auto-resolved when the condition clears (TC-01…03).
- [ ] A CLI version change marks the provider `unverified` within 40 s and a passing canary flips it to `verified`; a failing canary keeps it `unverified` and opens a `RepairCase` (TC-04, TC-05, TC-10).
- [ ] No smoke session ever starts without an explicit config `auto` or a user approval, and the approval card previews the exact argv (TC-06, C10).
- [ ] Egress is limited to hosts declared in **verified** manifests' `updateSources` plus the registry; the M0-08 egress test proves it (TC-07, C2).
- [ ] Watcher failures are warns with backoff and never create repair cases or user-visible errors (TC-08).
- [ ] Canary and remediation never run concurrently (TC-09).
- [ ] Orchestra never installs, upgrades or downgrades a vendor binary anywhere in this step (code review against C1).
- [ ] No new lint/dependency-cruiser violations; feed parsing lives in provider packages, not in core or daemon.
- [ ] `PROGRESS.md` updated; provider README documents the feed fixture and how to add a parser.

## 8. Risks / open questions
- Feed URLs, formats and stability for Claude Code, Codex and Antigravity are **(verify against each provider's docs at step start)**; they come from the manifest, so a wrong URL is a manifest fix (M6-03), not a code change. If a provider publishes no machine-readable feed, the provider simply has no watcher — we do not scrape (C7).
- GitHub feeds are rate-limited for unauthenticated clients; conditional GET plus a 6 h interval should stay well inside it. We never attach a token to a feed request (C3), so a 403 is a warn and the item is simply absent.
- A canary's contract-fixture gate needs the fixture set for the *new* version, which by definition does not exist yet; the gate therefore runs the *pinned* fixtures against the new binary and a failure means "the new version changed behaviour" — exactly the signal we want, but it can be a false alarm for cosmetic changes. Failures open a case at the classifier's confidence, not automatically at `critical`.
- Smoke sessions cost quota on a real subscription; default `ask` keeps it consensual, but a user with `auto` and many providers could burn a noticeable slice after a multi-CLI update day — bounded by `maxConcurrent: 1` and one short task per version.
- The scratch repo must exist and be clean; if `canary.scratchRepo` is missing or dirty the run is `skipped` with a clear message rather than touching a real project (M1-03 rule).
- `keepWorktreeOnFailure` accumulates worktrees; the Doctor `disk.budget` check (M6-01) counts them and M5-06 retention prunes canary worktrees older than 30 days — coordinate in that step's log.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
