# Milestone M6 — Self-maintenance

> Folder: `plan/07-m6-self-maintenance/` · Steps M6-01 … M6-07 · ~16 working days · Depends on M1 (substrate, adapters, telemetry) and M4 (quota signals feed the drift classifier).

## Goal

After M6 the platform maintains itself against vendor CLI churn (D6, G6). A Doctor runs at boot, hourly and on every CLI version change and reports binary/version/auth/probe/hook/tmux/disk health. Runtime telemetry (Zod parse failures, unknown event types, ack timeouts, unexpected exits, approval loops, model-not-found, 429 patterns) flows into a pure `DriftClassifier` that opens a `RepairCase` within 60 s of the first signal. A `RemediationLadder` applies safe, audited fixes (reload manifest, re-register hooks/MCP, restart pane and resume, switch transport, reroute task, rollback) in under 10 s, or fetches a newer signed manifest from the registry (ladder step 2). Release watchers turn vendor CLI releases into actionable Attention items and a canary lane verifies a new CLI version in an isolated worktree before it is marked *verified*. Model deprecations flow through the assignment engine and flag the policies that reference them. Everything is visible on the Health screen with SLO metrics.

## Why this milestone now

- Every adapter shipped in M1 is pinned to a CLI version through fixtures; vendors ship weekly (R1, score 20 — the highest risk in the register). Without M6 each release silently degrades prompt round-trips, parsers and routing, and the only detector is a human noticing.
- M4 delivered the quota signal pipeline (`quota.rate_limited`, windows, reroute). The drift classifier needs those signals to distinguish "vendor changed the 429 shape" from "user hit a limit", which is why M6 waits for M4-01/M4-03.
- M10-01 (Repair Agent, ladder step 3) and M10-02 (community drift loop) build directly on `RepairCase`, `DriftClassifier`, the registry client and the audit trail defined here. M6 fixes those contracts before the ecosystem work starts.
- Running M6 in parallel with M5 (history) and M7 (Tauri) keeps the solo-developer lane busy while M3/M4 acceptance settles (R16).

## Entry criteria

- M1-13 MVP accepted: ≥ 2 real adapters (claude, codex; agy opt-in) pass contract tests on pinned fixtures; `BinaryRegistry` (M1-04) reports versions and emits `provider.version_changed`; telemetry pipeline (M1-08) returns `Result.err(ParseError)` on unknown payloads instead of throwing.
- M2-03 full manifests exist with `cliVersionRange`, `commands[]`, `paths.hooksConfig`/`mcpConfig`, `updateSources`.
- M4-01 quota signals and M4-03 reroute use case are merged (drift classifier consumes `quota.rate_limited`; `RerouteTask` strategy reuses M4-03).
- M2-02 model catalog loader with `validTo`/`deprecated` fields (needed by M6-06).
- `FakeProvider` supports scripted scenarios (M0-03) so every M6 test and demo runs without a real account (C9).

## Exit criteria (measurable)

| # | Criterion | How measured |
|---|---|---|
| E1 | `orch doctor` runs at boot, hourly and on CLI version change; JSON + table report; exit codes 0/1/2/3 | TC-M6-01-* ; `doctor.ran` events in DB |
| E2 | **Time-to-detect < 60 s** (p95) from first drift signal to `RepairCase` in state `classified`, on all injected scenarios | `evidence_json.metrics.ttdMs` over ≥ 20 injected cases (FakeProvider) |
| E3 | **Safe remediation < 10 s** (p95) from `classified` to `fixed` for ladder-1 strategies | `evidence_json.metrics.ttrMs`; TC-M6-04-* |
| E4 | `DriftClassifier` and `RemediationLadder` have 100 % branch coverage | Vitest coverage gate in CI |
| E5 | Signed manifest fetched, verified, cached, hot-reloaded without daemon restart; tampered manifest rejected; rollback to last-known-good works offline | TC-M6-03-* |
| E6 | Every remediation attempt appears in `audit_log` and as `doctor.remediation_applied|failed` with timing | SQL check in TC-M6-04-07 |
| E7 | A new CLI release produces a "Provider Update" Attention item with impacted manifests; a new installed version is `unverified` until the canary passes | TC-M6-05-* |
| E8 | A deprecated model in the catalog re-scores to a non-preferred candidate and every policy referencing it is flagged with a one-click migration suggestion | TC-M6-06-* |
| E9 | Health screen shows doctor results, open/closed cases with ladder step and evidence, remediation history, updates, SLO tiles (TTD, TTR); manual "Run doctor" and "Retry remediation" work | TC-M6-07-* |
| E10 | No compliance regression: no new egress hosts beyond registry URL + manifest `updateSources`; auth/allowlist/ToS files never written by any strategy | egress test (M0-08) + `ForbiddenPathGuard` unit tests |

## Steps

| ID | File | Title | Effort | Depends on |
|---|---|---|---|---|
| M6-01 | [step-01](step-01-doctor.md) | Doctor | 2.5 d | M1-04, M2-03, M1-08 |
| M6-02 | [step-02](step-02-drift-detector-and-classifier.md) | Drift detector & classifier | 2.5 d | M6-01, M4-01, M1-08, M0-05 |
| M6-03 | [step-03](step-03-manifest-registry-client.md) | Manifest registry client | 2 d | M2-03, M0-04, M0-08 |
| M6-04 | [step-04](step-04-remediation-ladder-1-2.md) | Remediation ladder 1–2 | 3 d | M6-02, M6-03, M4-03, M1-02, M5-05 |
| M6-05 | [step-05](step-05-release-watchers-and-canary-lane.md) | Release watchers & canary lane | 2 d | M6-01, M6-03, M1-03, M1-11, M6-04 |
| M6-06 | [step-06](step-06-model-lifecycle.md) | Model lifecycle | 1.5 d | M6-03, M2-02, M2-04, M2-09 |
| M6-07 | [step-07](step-07-health-screen-and-slos.md) | Health screen & SLOs | 2 d | M6-04, M6-01, M6-02, M6-03, M6-05, M6-06, M0-07 |

Total: 15.5 d (ROADMAP: ~16 d).

## What you can test after this milestone

- Run `orch doctor` and `orch doctor --json`; break something on purpose (rename a hooks config, downgrade tmux in PATH, fill the recordings budget) and watch the check flip.
- Inject drift against `FakeProvider` (unknown hook event, mutated `--help` fixture, fake version bump, ack timeout, model-not-found) and watch: signal → case (< 60 s) → ladder attempt (< 10 s) → `fixed` on the Health screen, with audit rows.
- Point the daemon at a local fixture registry, publish a newer signed manifest, watch it hot-reload; corrupt the signature and watch it get rejected; go offline and watch rollback use the cache.
- Simulate a vendor release in the release feed fixture and see the Attention item; bump the FakeProvider version and watch the canary lane mark it `verified`.
- Mark a model deprecated in a catalog override and see the routing policy flagged with a migration diff.

## Demo script

Preconditions: daemon running with `features.maintenance: true`, `maintenance.registry.url` pointing at the local fixture registry (`pnpm registry:serve` from `packages/sdk/src/registry/fixtures/`), FakeProvider enabled, scratch repo `~/orchestra-scratch/`, web UI open on **Health**.

1. `orch doctor` — table shows all checks `pass` for `fake`, real providers as installed; `orch doctor --json | jq .summary` shows counts; exit code 0. Health → Doctor card shows "last run: manual, just now".
2. **Inject unknown event type:** `orch doctor simulate unknown-event --provider fake` starts a FakeProvider session whose scenario posts a hook payload `{"hook_event_name":"BrandNewHook"}` three times. Watch Health → Repair cases: a case `parser-drift` (confidence 0.85) appears; the TTD badge shows the measured value (< 60 s). Ladder runs `ReloadManifest` → no newer manifest → `RegistryFix` fetches `fake@1.1.0` from the fixture registry (which declares the new event) → verify passes → case `fixed`; TTR badge < 10 s. Audit tab lists both attempts.
3. **Inject mutated fixture:** `orch doctor simulate mutated-fixture --provider fake` rewrites the pinned `help.txt` fixture for `fake` so the `probe.help_commands` diff fails. `orch doctor` now reports `probe.help_commands: fail`; a case `manifest-stale` opens from the doctor signal; ladder step 2 restores the manifest that matches; `orch doctor simulate reset` restores the fixture.
4. **Fake CLI version bump:** `orch doctor simulate version-bump --provider fake --to 9.9.0`. `BinaryRegistry` emits `provider.version_changed` within 30 s → doctor runs (trigger `cli_version_change`) → Fleet badge shows `fake 9.9.0 · unverified` → canary lane creates `~/orchestra-scratch/.orchestra/worktrees/canary-fake-9.9.0`, runs quota-free probes + contract fixtures + FakeProvider smoke → badge flips to `verified`; `provider.canary_completed` event.
5. **Ack timeout / transport:** `orch doctor simulate ack-timeout --provider fake` — the fake ignores two `send-keys` commands; classifier opens `transport-broken`; ladder `RestartPaneAndResume` restarts the pane through the `SessionSupervisor` and the session resumes; case `fixed`.
6. **Model missing:** `orch doctor simulate model-missing --provider fake` — the fake exits with the `model-not-found` stderr fixture; case `model-missing`; ladder `RerouteTask` reroutes the task to the next candidate (M4-03 path); Board shows the task on the new provider.
7. **Tampered manifest:** edit `fake/1.2.0.json` in the fixture registry without re-signing; `orch registry refresh` → rejected with `SignatureInvalid`; cache and active manifest unchanged; doctor check `manifest.signature: pass` (still on the verified one).
8. **Offline rollback:** stop the fixture registry; `orch registry rollback fake` → active manifest becomes previous last-known-good from `~/.orchestra/manifests-cache/`; sessions started afterwards use it.
9. **Provider update item:** `orch doctor simulate release --provider fake --version 9.10.0` appends an entry to the fixture release feed; the watcher (forced with `orch watchers poll`) creates an Attention item "Provider Update: fake 9.10.0 (installed 9.9.0, manifest range ^9.9)" with suggested action `wait-for-manifest`.
10. **Model deprecation:** add `deprecated: true, renamedTo: fake-pro-2` to `fake-pro` in `~/.orchestra/catalog-overrides/models/fake/fake-pro.yaml`; `orch catalog reload`; Models screen shows the deprecation badge; Attention shows "your `architect` role lists a deprecated model"; click **Migrate** → diff preview of the routing policy → apply → `audit.policy_migrated` row.
11. Health → SLO tiles: TTD p95 and TTR p95 over the demo cases are both green (< 60 s, < 10 s). Click **Run doctor** and **Retry remediation** on a closed case to show the manual actions.

## Milestone risks

| Risk | Mitigation |
|---|---|
| Probes accidentally spend quota or trigger a login (`--help`, `/status`, `/usage` behaviour changes) | every probe declares `quotaFree: true` and is labelled "(verify)" per provider at step start; probe timeouts; probes never run against a provider with `auth_status = logged_out` except the auth probe itself |
| Classifier over-triggers on legitimate noise (a user hitting 429, a one-off parse error) | thresholds + windows in config; 429 alone is never drift; confidence < 0.5 records signal only; golden tests for false-positive scenarios |
| Remediation loops (fix → drift → fix …) | max ladder runs per case; per-case mutex; never remediate during a canary; backoff; case goes `needs_human` after 3 runs |
| Signing scheme decision (ADR-006) slips and blocks M6-03 | decided inside M6-03 §4 (minisign/ed25519 for hot manifests, Sigstore for releases); keys pinned in SDK |
| Egress creep (feeds, registry) violates C2 | runtime `EgressPolicy` allowlist = registry URL + hosts from signed manifests' `updateSources`; static `no-vendor-endpoints` rule; egress test extended |
| `BinaryRegistry` version watcher interval too slow for the 60 s TTD | watcher interval ≤ 30 s (config); doctor debounce 5 s; measured in TC-M6-01-06 |
| Health screen becomes a dashboard nobody reads (UX principle 1) | cases that need a human are also Attention items; Health is the detail view |

## Parallelization notes

- **Lane A (core detection):** M6-01 → M6-02 → M6-04 → M6-07. Critical path, ~10 d.
- **Lane B (registry):** M6-03 depends only on M2-03 and can start on day 1 in parallel with M6-01; it must land before M6-04 starts (RegistryFix strategy).
- **Lane C (watchers/canary):** M6-05 depends on M6-01 only; run it in parallel with M6-02/M6-04.
- **Lane D (model lifecycle):** M6-06 depends on M2-02 + M6-03; can run in parallel with M6-04; its Attention/Models UI is small enough to finish before M6-07 wires the Health screen.
- Shared touchpoints to coordinate: `repair_cases` migrations (M6-02 adds, M6-04 adds `repair_attempts`), the event catalog additions (`provider.manifest_reloaded`, `provider.manifest_rolled_back`, `provider.canary_completed`, `catalog.*`), and the `EgressPolicy` port (M6-03 introduces, M6-05 reuses). Land M6-03 first when in doubt.
- All steps ship behind `features.maintenance`; the flag is removed in M6-07 acceptance.

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
