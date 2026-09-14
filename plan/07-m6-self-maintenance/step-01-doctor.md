# Step M6-01 — Doctor

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M1-04 (BinaryRegistry), M2-03 (full manifests), M1-08 (`orch` CLI scaffold, telemetry pipeline) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon`, `apps/cli`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step `orch doctor` (and the daemon on its own at boot, hourly, and whenever a CLI version changes) runs a fixed list of quota-free checks per provider and host — binary present and allowlisted, CLI version inside the manifest's `cliVersionRange`, auth/plan status, `--version` / `--help` probes diffed against the manifest and pinned fixtures, Codex app-server schema diff, agy `/usage` schema check, hooks/MCP registration, tmux version, disk budgets — and produces a `DoctorReport` as a terminal table or JSON with deterministic exit codes. Every run is persisted and emitted as a `doctor.ran` event. The user can see at a glance which provider is healthy, which is unverified, and why.

## 2. Why
- D6 (platform maintains itself) and G6 (drift detected < 60 s): the Doctor is the scheduled half of detection; M6-02 adds the runtime half.
- C1 (only official binaries): the Doctor re-verifies the allowlist and version at boot and on change, closing the gap between M1-04's one-time detection and the running fleet.
- C3 (tokens never seen): the auth check uses the adapter's `AuthProbe` only, which returns `{loggedIn, plan, accountLabel}` and nothing else.
- C7/C8 (no scraping, documented flags only): every probe is a documented, quota-free command whose output is parsed by a typed parser, never a regex over PTY bytes.
- Replaces `plan/ENVIRONMENT.md` as the source of truth for the dev machine from M6 onward (see that file's header).

## 3. Scope
### In scope
- `DoctorModule` in the daemon: check strategy registry (DI map keyed by check id), `RunDoctor` use case, scheduler (boot / hourly / `provider.version_changed`), report persistence, `doctor.ran` event.
- SDK extension: optional `doctor?: DoctorProbes` on `ProviderAdapter` with quota-free probe specs; probe specs for claude, codex, agy; `FakeProvider` probes.
- `orch doctor [--json] [--provider <id>] [--check <id>] [--timeout <ms>]` command; `POST /api/doctor/run`, `GET /api/doctor/reports`.
- Pinned help fixtures: `packages/providers/<id>/fixtures/<cliVersion>/help/help.txt` and the parsed `commands.json` used for the diff.
- Disk budget checks against the retention config (M5-06) and the runtime dirs from `11-repo-layout.md`.
### Out of scope (deferred to …)
- Turning failed checks into `RepairCase`s — deferred to M6-02 (this step emits the signal, nothing consumes it yet).
- Manifest signature check strategy — deferred to M6-03 (registers a new check id `manifest.signature`).
- Canary runs on version change — deferred to M6-05.
- Health screen UI — deferred to M6-07; this step only exposes API + CLI.
- Full `orch` command set — deferred to M7-06; this step adds the `doctor` command to the M1-08 scaffold.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `DoctorReport` (value object, `packages/core/src/maintenance/doctor-report.ts`): immutable result of one run; `summary` computed from checks; `exitCode` derived: `0` all pass/skipped, `1` any `warn` and no `fail`, `2` any `fail`, `3` reserved for "doctor could not run" (daemon unreachable / config invalid), set by the CLI.
- `CheckResult` value object: `status ∈ pass|warn|fail|skipped`; `skipped` carries a reason (provider not installed, opt-in not acknowledged, probe not applicable).
- Rules: a check for a provider whose `auth_status` is `logged_out` is `skipped` unless it is `auth.status` or `binary.*` (never trigger a login flow). A probe exceeding `probeTimeoutMs` is `fail` with evidence `{timeoutMs}`. Checks are independent: one failure never short-circuits the others.
- `DoctorTrigger = 'boot' | 'hourly' | 'cli_version_change' | 'manual' | 'canary'` (canary used by M6-05).

### 4.2 Interfaces / contracts
```ts
// packages/core/src/maintenance/doctor.ts
export type DoctorCheckId =
  | 'binary.present' | 'binary.allowlisted' | 'binary.version_in_range'
  | 'auth.status' | 'probe.version' | 'probe.help_commands'
  | 'probe.rpc_schema' | 'probe.usage_schema'
  | 'hooks.registered' | 'mcp.registered'
  | 'tmux.version' | 'disk.budget' | 'manifest.signature' /* M6-03 */;
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export interface CheckResult {
  id: DoctorCheckId; provider?: ProviderId; status: CheckStatus;
  message: string; evidence?: Record<string, unknown>; durationMs: number;
  driftHint?: DriftKind;                     // consumed by M6-02
}
export interface DoctorReport {
  id: string; hostId: string; trigger: DoctorTrigger; startedAt: string; finishedAt: string;
  cliVersions: Record<ProviderId, string | null>; checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; skipped: number }; exitCode: 0 | 1 | 2;
}

// packages/core/src/maintenance/ports.ts
export interface DoctorCheck {                 // one strategy per check id, DI-registered
  readonly id: DoctorCheckId; readonly scope: 'host' | 'provider';
  run(ctx: CheckContext): Promise<Result<CheckResult, DomainError>>;   // never throws
}
export interface CheckContext { hostId: string; provider?: ProviderId; cliVersion?: string;
  manifest?: CapabilityManifest; clock: Clock; deadlineMs: number; }
export interface DoctorReportRepository { save(r: DoctorReport): Promise<Result<void, DomainError>>;
  latest(hostId: string): Promise<Result<DoctorReport | null, DomainError>>;
  list(hostId: string, limit: number): Promise<Result<DoctorReport[], DomainError>>; }

// packages/sdk/src/doctor.ts  (optional adapter extension)
export interface DoctorProbes { probes(): ProbeSpec[]; }
export interface ProbeSpec {
  id: 'probe.version' | 'probe.help_commands' | 'probe.rpc_schema' | 'probe.usage_schema';
  argv: string[];                              // documented flags only (C8); binary from BinaryRegistry
  quotaFree: true;                             // literal true — a probe that could spend quota is rejected at registration
  timeoutMs?: number;
  parse(stdout: string, stderr: string, exitCode: number): Result<ProbeOutcome, ParseError>;
}
export type ProbeOutcome =
  | { kind: 'version'; version: string }
  | { kind: 'commands'; commands: string[] }                    // compared with manifest.commands[].name
  | { kind: 'schema'; canonicalJson: string; sha256: string }   // compared with fixtures/<ver>/rpc/schema.json
  | { kind: 'usage'; keys: string[] };                          // compared with fixtures/<ver>/stream/usage-keys.json

// apps/daemon/src/application/maintenance/run-doctor.usecase.ts
export class RunDoctor { constructor(checks: Map<DoctorCheckId, DoctorCheck>, providers: ProviderRegistry,
  repo: DoctorReportRepository, events: EventBus, clock: Clock, ids: IdGenerator, cfg: DoctorConfig) {}
  execute(cmd: { trigger: DoctorTrigger; providerFilter?: ProviderId[]; checkFilter?: DoctorCheckId[] }):
    Promise<Result<DoctorReport, DomainError>>; }
```

### 4.3 Data / schema changes
- New table `doctor_reports (id text pk, host_id text, trigger text, started_at text, finished_at text, exit_code integer, summary_json text, report_json text)`; index on `(host_id, started_at desc)`. Postgres-compatible types only (D8). Retention: keep last 200 per host (pruned by the same job as events retention, M5-06).
- Event `doctor.ran` payload (Zod, registered with the event-schema registry from M0-05): `{ reportId, trigger, summary, failedCheckIds: DoctorCheckId[], cliVersions }`. Actor `{kind:'system', id:'doctor'}`; `source.channel = 'cli'` for manual runs, `'ui'` for API runs, `'tmux'` never.
- `providers.cli_version` is updated by M1-04, not here; the Doctor reads it.
- Config (Zod, `maintenance.doctor`): `{ enabled: true, intervalMs: 3600000, bootDelayMs: 5000, versionChangeDebounceMs: 5000, probeTimeoutMs: 15000, diskBudgets: { recordingsMaxBytes, dbMaxBytes, logsMaxBytes, worktreesMaxCount } }`. Feature flag `features.maintenance`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/maintenance/checks/*.check.ts` — one class per check id. Probes spawn the allowlisted binary path from `BinaryRegistry` with an explicit env allowlist (`PATH, HOME, TERM, LANG` + manifest-declared vars), `cwd = ~/orchestra-scratch/`, stdin closed, `timeoutMs`, output capped at 1 MB. Spawning lives only in `infrastructure/**` (dependency rule).
- Probe specs (all labelled **verify against vendor docs at step start**): claude `--version`, `--help` and `AuthProbe` via `claude /status` (verify: non-interactive form); codex `--version`, `--help`, `codex login status` (auth), `codex app-server generate-json-schema` (verify: exact subcommand and output shape) → canonical JSON sha256 vs `fixtures/<ver>/rpc/schema.json`; agy `--version`, `--help`, `agy -p "/usage"` (verify: JSON shape, quota-free) → top-level keys vs `fixtures/<ver>/stream/usage-keys.json`; agy probes are `skipped` unless `tos_acknowledged_at` is set (C11).
- `hooks.registered`: for providers with feature `hooks`, render `launcher.preLaunchFiles()` for a dry `InteractiveSpec` and compare with files on disk for every running session (`paths.hooksConfig`); assert the daemon URL/port entries exist. `mcp.registered`: same for `paths.mcpConfig` on Lead sessions (M2-05). Read-only; never rewrites files (M6-04 does).
- `tmux.version`: `tmux -V` via the `SessionSupervisor` message `queryTmuxVersion` (D13 — no other module spawns tmux); `>= 3.3` pass, else fail.
- `disk.budget`: sizes of `~/.orchestra/recordings`, `orchestra.db` (+ WAL), `logs/`, `manifests-cache/`, count of `<repo>/.orchestra/worktrees/*` across known repos; `warn` at 80 %, `fail` at 100 % of the configured budget.
- `DoctorScheduler` (`infrastructure/maintenance/doctor.scheduler.ts`): boot run after `bootDelayMs` once `BinaryRegistry` detection completes; `setInterval(intervalMs)`; subscribes to `provider.version_changed` with a 5 s debounce; a mutex guarantees one run at a time — concurrent requests join the in-flight run and receive the same report.
- `BinaryRegistry` re-check interval is set to ≤ 30 s (config `binaryWatch.intervalMs`) so a version change is noticed fast enough for the 60 s TTD SLO; if M1-04 did not expose this knob, add it here.

### 4.5 API / UI surface
- CLI: `orch doctor` → table (columns: check · provider · status · message · ms); `--json` → `DoctorReport`; `--provider claude,codex`; `--check probe.help_commands`; exit codes 0/1/2/3. `orch doctor --watch` re-prints on every `doctor.ran` WS event.
- HTTP: `POST /api/doctor/run` body `{trigger:'manual', providers?, checks?}` (Idempotency-Key honoured; returns 202 + `reportId` if a run is in flight, 200 + report otherwise); `GET /api/doctor/reports?limit=20`; `GET /api/doctor/reports/:id`; `GET /api/doctor/latest`.
- WS topic `health.doctor` publishes `{reportId, summary, trigger}` on every run.
- Fleet screen (M1-10) gains a small "doctor: N fail / M warn" badge per provider (link only; the full view is M6-07).

### 4.6 Flow / sequence
```
boot | hourly | provider.version_changed | POST /api/doctor/run | orch doctor
   → DoctorScheduler (debounce, mutex) → RunDoctor.execute
      → for each host check (tmux.version, disk.budget) run in parallel
      → for each installed provider: binary.* → auth.status → probes (parallel, per-provider timeout) → hooks/mcp
      → DoctorReport (summary, exitCode) → repo.save → events.emit('doctor.ran') → ws 'health.doctor'
   ← CLI prints table/JSON, exits with exitCode
```

## 5. Tasks
- [ ] `packages/core/src/maintenance/`: `DoctorReport`, `CheckResult`, `DoctorCheckId`, `DoctorTrigger`, ports (`DoctorCheck`, `DoctorReportRepository`); summary/exit-code rules with unit tests.
- [ ] `packages/sdk/src/doctor.ts`: `DoctorProbes`, `ProbeSpec`, `ProbeOutcome`; add optional `doctor?` to `ProviderAdapter`; registration-time assertion that every probe has `quotaFree: true`.
- [ ] Contract spec `packages/sdk/src/contract/doctor.contract.spec.ts`: every adapter probe argv uses only manifest-documented flags; parse never throws on fuzzed input (fast-check).
- [ ] Kysely migration `doctor_reports`; SQLite repository + in-memory repository.
- [ ] `RunDoctor` use case with check-map DI, per-provider timeout, independent checks, `doctor.ran` emission.
- [ ] Host checks: `TmuxVersionCheck` (via SessionSupervisor message), `DiskBudgetCheck`.
- [ ] Provider checks: `BinaryPresentCheck`, `BinaryAllowlistedCheck`, `VersionInRangeCheck` (semver vs `cliVersionRange`), `AuthStatusCheck` (AuthProbe only).
- [ ] Probe runner (`infrastructure/maintenance/probe-runner.ts`): spawn with env allowlist, timeout, 1 MB cap, returns `Result`.
- [ ] Probe checks: `VersionProbeCheck`, `HelpCommandsCheck` (diff vs `manifest.commands[].name` and pinned `help.txt`), `RpcSchemaCheck` (codex only), `UsageSchemaCheck` (agy only, gated on ToS ack).
- [ ] Record pinned help/schema/usage-keys fixtures for claude, codex, agy with `orch fixtures record` (M1-08) and update `RECORDED.md`.
- [ ] `HooksRegisteredCheck` and `McpRegisteredCheck` (read-only comparison against `preLaunchFiles`).
- [ ] `DoctorScheduler`: boot, hourly, version-change debounce, mutex/coalescing; `binaryWatch.intervalMs ≤ 30 s`.
- [ ] `DoctorModule` wiring behind `features.maintenance`; config schema `maintenance.doctor`.
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS topic `health.doctor`.
- [ ] `apps/cli/src/commands/doctor.ts`: table/JSON renderers, filters, `--watch`, exit codes.
- [ ] FakeProvider probes + scenario `doctor-all-pass.yaml` and `doctor-help-drift.yaml`.
- [ ] Fleet badge (provider row) reading `GET /api/doctor/latest`.
- [ ] Package READMEs: how to add a check, how to add a probe to an adapter.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-01-01 | unit | `DoctorReport.summary/exitCode` from mixed check results | pass-only→0; warn→1; any fail→2; skipped never affects code |
| UT-M6-01-02 | unit | `VersionInRangeCheck` with versions inside/outside/prerelease vs `cliVersionRange` | pass / fail with `driftHint: 'manifest-stale'` / warn for prerelease |
| UT-M6-01-03 | unit | `HelpCommandsCheck` diff: manifest lists a command missing from `--help` output | fail, evidence `{missing:[…], extra:[…]}` |
| UT-M6-01-04 | unit (fast-check) | every `ProbeSpec.parse` over random bytes | returns `Result`, never throws |
| UT-M6-01-05 | unit | `DoctorScheduler` debounce: 5 `provider.version_changed` in 2 s | exactly one run |
| AT-M6-01-01 | application | `RunDoctor` with one check that times out and one that passes | report contains both; timeout check `fail`, other `pass`; `doctor.ran` emitted once |
| AT-M6-01-02 | application | provider `logged_out` | probe checks `skipped` with reason; `auth.status` `fail` |
| IT-M6-01-01 | integration | probe runner spawns FakeProvider binary `--version` with env allowlist | version parsed; env contains only allowlisted keys |
| IT-M6-01-02 | integration | `doctor_reports` repository round-trip + `GET /api/doctor/reports` | JSON columns validated; ordering newest first |
| IT-M6-01-03 | integration | contract: `doctor.contract.spec.ts` for claude/codex/agy/fake | argv flags ⊆ manifest-documented flags; `quotaFree` literal true |
| E2E-M6-01-01 | e2e | `orch doctor --json` against daemon with FakeProvider | exit 0; JSON validates against `DoctorReport` schema |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-01-01 | Baseline on real CLIs | 1. Log in to claude and codex. 2. `orch doctor`. 3. `echo $?` | Table shows every check for claude/codex `pass` (agy `skipped` unless ToS acknowledged); exit 0; one `doctor.ran` row in `events` | ⬜ |
| TC-M6-01-02 | Missing binary | 1. `PATH=/usr/bin orch doctor --provider codex` (daemon restarted with same PATH). | `binary.present: fail` for codex; other providers unaffected; exit 2 | ⬜ |
| TC-M6-01-03 | Version outside manifest range | 1. Edit `packages/providers/claude/manifest.json` `cliVersionRange` to `^0.1.0`. 2. `orch doctor --provider claude`. 3. Restore. | `binary.version_in_range: fail` with `driftHint: manifest-stale`; probes still run; exit 2 | ⬜ |
| TC-M6-01-04 | Help drift (mutated fixture) | 1. Append a fake command line to `packages/providers/codex/fixtures/<ver>/help/help.txt`. 2. `orch doctor --check probe.help_commands --provider codex`. 3. Restore. | `probe.help_commands: fail`, evidence lists the extra command; exit 2 | ⬜ |
| TC-M6-01-05 | Hooks config removed under a running session | 1. Start a claude session. 2. Delete the session's hooks config file referenced by `paths.hooksConfig`. 3. `orch doctor --check hooks.registered`. | `hooks.registered: fail` naming the session id and missing file; nothing rewritten on disk | ⬜ |
| TC-M6-01-06 | On-change trigger timing (SLO input) | 1. `orch doctor simulate version-bump --provider fake --to 9.9.0` (FakeProvider binary reports new version). 2. Watch `orch doctor --watch`. 3. Compare `provider.version_changed.ts` with `doctor.ran.ts`. | A run with trigger `cli_version_change` appears; delta ≤ 35 s (≤ 30 s watcher + 5 s debounce) | ⬜ |
| TC-M6-01-07 | Probe timeout resilience | 1. Set `maintenance.doctor.probeTimeoutMs: 100`. 2. `orch doctor --provider codex`. 3. Restore. | Slow probes `fail` with `{timeoutMs:100}`; run completes; no orphan `codex` processes (`pgrep codex` empty after 5 s) | ⬜ |
| TC-M6-01-08 | Concurrent runs coalesce | 1. Fire `POST /api/doctor/run` three times within 1 s. | First returns 200 + report or all return the same `reportId`; exactly one `doctor.ran` event | ⬜ |
| TC-M6-01-09 | Disk budget warning | 1. Set `diskBudgets.recordingsMaxBytes` to current recordings size × 1.1. 2. `orch doctor --check disk.budget`. | `disk.budget: warn` with used/limit bytes; exit 1 | ⬜ |
| TC-M6-01-10 | No auth prompt ever | 1. Log out of codex (`codex logout`, verify per docs). 2. `orch doctor`. | `auth.status: fail`; every codex probe `skipped: logged_out`; no browser/login prompt opened; no token-shaped string in the report (`grep -Ei 'token|secret|bearer'` empty) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-01-01 … 10 pass and are recorded with build hash and date.
- [ ] Doctor runs automatically at boot, hourly and within 35 s of a CLI version change (TC-M6-01-06 evidence attached).
- [ ] `orch doctor --json` output validates against the `DoctorReport` Zod schema; exit codes 0/1/2/3 documented in the CLI help.
- [ ] Every probe for claude/codex/agy is marked `quotaFree: true`, uses only manifest-documented flags (contract test green), and its vendor facts are re-verified and noted in the step log.
- [ ] `doctor.ran` event persisted for every run; `doctor_reports` migration applied on fresh and upgraded DBs.
- [ ] No token-shaped field appears in any report (contract test `auth.contract.spec.ts` extended to `DoctorReport`).
- [ ] No new lint/dependency-cruiser violations; spawning only in `infrastructure/**`.
- [ ] Package READMEs for `packages/sdk` (adding probes) and `apps/daemon` maintenance module updated; `plan/ENVIRONMENT.md` header points to `orch doctor`.

## 8. Risks / open questions
- Exact non-interactive form of `claude /status` and `codex login status`, and whether `codex app-server generate-json-schema` still exists under that name — **verify against Claude Code / Codex docs at step start**; if a probe is not quota-free it is dropped, not worked around.
- `agy -p "/usage"` output shape and whether it counts as quota-free — **verify against Antigravity docs at step start**; the probe stays behind the ToS acknowledgement (C11).
- `--help` output is not a stable contract; diffs use the parsed command list, not raw text, but vendors may rename commands without functional drift → the check reports `warn` when only additions are found and `fail` only when a manifest command disappears.
- If `BinaryRegistry` (M1-04) has no periodic re-check, adding `binaryWatch.intervalMs` here touches M1 code; coordinate via the M1-04 step log.
- Hourly runs on a laptop that sleeps: the scheduler uses wall-clock comparison (`lastRunAt + intervalMs <= now`) checked every minute, not a naive `setInterval`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
