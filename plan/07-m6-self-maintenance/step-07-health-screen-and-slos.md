# Step M6-07 — Health screen & SLOs

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M6-04, M6-01, M6-02, M6-03, M6-05, M6-06, M0-07 |
| Estimated effort | 2 days |
| Packages touched | `apps/web`, `packages/ui`, `apps/daemon`, `packages/core`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step the **Health** screen (nav position 11, `12-ux-principles.md`) exists and is the single place where the self-maintenance machinery is legible: SLO tiles for time-to-detect and time-to-remediate against their targets (< 60 s, < 10 s) with sample sizes and honest "insufficient data" states; the latest Doctor report with every check, its evidence and a **Run doctor** button; open and closed repair cases with their drift kind, confidence, rationale, ladder step, evidence and full remediation timeline, with **Retry remediation** and **Close case** actions; a registry panel showing the active manifest per provider, its signature status and a guarded **Rollback**; and the updates panel with provider-update items, canary verdicts and a **Run canary** action. This is also the step where `features.maintenance` is removed — M6 ships on by default.

## 2. Why
- D6 / G6 — the milestone's SLOs ("drift detected < 60 s; safe remediation < 10 s") are only real once they are measured and displayed; `00-source-plan-v0.2.md` §10.2 ends with "every case visible in **Health**".
- UX principle 1 (attention over information) — Health is deliberately the *detail* view: anything that needs a human is already an Attention item (`repair_needs_human`, `provider_update`, `model_deprecated`); Health is where you go to understand, not to be notified. Principle 4 (truth labelling) — every SLO number shows its sample size and window; an SLO with too few samples is never green. Principle 5 (zero-surprise control) — rollback and retry preview what they will do.
- G1 — the same screen works on desktop, in the Tauri shell (M7-01) and on a phone-width PWA (M7-03), so it is built responsive and RTL-safe from the start.
- C10 — every action on this screen is a mutating, audited API call behind an `Idempotency-Key`; C3 — evidence rendering must never leak a token-shaped string (the redaction happens at write time, and the UI additionally never renders raw payloads without the `<RedactedJson>` component).

## 3. Scope
### In scope
- Pure `SloCalculator` in `packages/core` (percentiles, target comparison, insufficient-data rule) — 100 % branch coverage.
- `GET /api/health/summary` and `GET /api/health/slos` aggregation endpoints; `health` WS topic fan-in.
- Health screen in `apps/web/src/features/health/` with sections: SLO tiles, Doctor card, Repair cases (list + detail drawer with remediation timeline), Registry panel, Updates & canary panel.
- Actions: Run doctor, Retry remediation (optionally a specific strategy), Close case, Refresh registry, Rollback manifest (preview modal), Run canary, Poll watchers.
- Empty / loading / error / offline / degraded states for every section; virtualised case list; responsive down to phone width; RTL; WCAG 2.1 AA.
- `orch health [--json]` summarising the same data for the terminal.
- Removal of the `features.maintenance` flag and the milestone's exit-criteria evidence capture.
### Out of scope (deferred to …)
- Repair-proposal ("assisted") tab and its diff viewer — deferred to M10-01, which adds a tab to the case drawer defined here.
- Historical charts / time-series of SLOs beyond the rolling window tiles — deferred to M9-08 (observability, Prometheus/Grafana).
- Alerting and notification routing on SLO breach — deferred to M8-08 (notification channels) and M9-08.
- Multi-host aggregation (one Health per host) — deferred to M7-05; this screen shows the connected host.
- RBAC gating of the action buttons — deferred to M9-01; the endpoints are written RBAC-ready (permission names declared, guard is a no-op in single-user mode).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/maintenance/slo.ts` — pure.

```
SLO-1  ttd   "Drift detected"        target < 60 000 ms  (p95)  source: repair_cases.evidence.metrics.ttdMs
SLO-2  ttr   "Safe remediation"      target < 10 000 ms  (p95)  source: repair_attempts where safety='safe-auto',
                                                                       measured case-level ttrMs (classified → fixed)
SLO-3  auto  "Auto-resolved share"   target ≥ 70 %              cases closed with reason 'remediated' ÷ all closed
SLO-4  canary "Version verified"     target ≥ 90 %              versions marked verified ÷ versions seen (M6-05)
```
Rules (unit-tested): **R-S1** percentiles are nearest-rank on the sorted sample; `p95` of n < `minSample` (5) is not reported — status `insufficient-data`, rendered neutral, **never green**. **R-S2** status = `met` when the p95 is within target, `at-risk` when within target but the p50 is above 70 % of it (trend warning), `breached` otherwise. **R-S3** the window is a closed interval `[now − windowMs, now]` on the *close* timestamp; open cases never contribute a `ttr`. **R-S4** a case closed with `cli_version_changed` or `manual` contributes to SLO-1 (it was detected) but not to SLO-2/SLO-3 (it was not remediated). **R-S5** every reported metric carries `sampleSize` and `windowMs`; the UI must show both (truth labelling). **R-S6** the calculator is pure and takes numbers, not repositories.

`HealthSummary` is a read model composed by the daemon, never persisted: doctor snapshot + case counts by state + attempt counts by outcome + registry status per provider + update items + canary verdicts + SLO metrics.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/maintenance/slo.ts   (pure; 100 % branch)
export type SloId = 'ttd' | 'ttr' | 'auto_resolved' | 'canary_verified';
export type SloStatus = 'met' | 'at-risk' | 'breached' | 'insufficient-data';
export interface SloTarget { id: SloId; label: string; unit: 'ms' | 'percent';
  comparison: 'lte' | 'gte'; target: number; statistic: 'p95' | 'ratio'; minSample: number; }
export interface SloMetric { id: SloId; status: SloStatus; value: number | null;
  p50?: number | null; p95?: number | null; sampleSize: number; windowMs: number; target: number; unit: 'ms'|'percent'; }
export declare function computeSlo(t: SloTarget, samples: readonly number[], windowMs: number): SloMetric;
export declare function percentile(sorted: readonly number[], p: number): number | null;

// apps/daemon/src/application/maintenance/get-health-summary.usecase.ts
export interface HealthSummary {
  hostId: string; generatedAt: string; daemonVersion: string;
  doctor: { reportId: string; trigger: DoctorTrigger; finishedAt: string; exitCode: 0|1|2;
            summary: DoctorReport['summary']; failed: CheckResult[]; running: boolean } | null;
  cases: { open: number; needsHuman: number; byKind: Record<DriftKind, number>; recent: RepairCaseSummary[] };
  remediation: { last24h: { applied: number; failed: number }; byStrategy: { strategyId: StrategyId; applied: number; failed: number; avgMs: number }[] };
  registry: { enabled: boolean; offline: boolean; lastRefreshAt: string | null;
              providers: { providerId: ProviderId; active: { version: string; source: ManifestSource['kind']; verifiedAt: string | null };
                           available?: string; canRollback: boolean }[] };
  updates: UpdateImpact[];
  canary: { providerId: ProviderId; cliVersion: string; state: CanaryState; gates: CanaryRun['gates']; finishedAt: string | null }[];
  slos: SloMetric[];
}
export class GetHealthSummary { execute(q: { windowMs?: number }): Promise<Result<HealthSummary, DomainError>>; }
export class GetSloMetrics { execute(q: { windowMs: number }): Promise<Result<SloMetric[], DomainError>>; }

// apps/web/src/features/health/types.ts  (DTO mirror, generated from the OpenAPI schema)
export interface HealthAction { id: 'run-doctor'|'retry-remediation'|'close-case'|'refresh-registry'
  |'rollback-manifest'|'run-canary'|'poll-watchers'; needsConfirm: boolean; preview?: string; }
```

### 4.3 Data / schema changes
- **No new tables.** Everything is read from `doctor_reports` (M6-01), `repair_cases` (M6-02), `repair_attempts` (M6-04), `canary_runs` + `providers` (M6-05), `model_lifecycle_changes` (M6-06) and the registry cache state (M6-03).
- Two indexes added for the aggregation queries: `repair_cases(closed_at)` and `repair_attempts(finished_at, safety)` — migration `NNN-m6-07-health-indexes`.
- Config `maintenance.slo`: `{ windowMs: 2592000000 /* 30 d */, minSample: 5, targets: { ttdMs: 60000, ttrMs: 10000, autoResolvedRatio: 0.7, canaryVerifiedRatio: 0.9 } }` — targets are config so a user can tighten them, but the *defaults* are the milestone's exit criteria and the acceptance run uses the defaults.
- Events: none new. `audit_log` rows come from the existing action endpoints.
- Feature flag: `features.maintenance` deleted from the config schema and every guard; a migration note tells users the key is now ignored (fail-soft: unknown key warns, does not crash).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/interface/http/health.controller.ts` + `GetHealthSummary` / `GetSloMetrics` use cases. The summary is assembled from repositories in parallel (`Promise.allSettled`) with a per-source timeout of 500 ms; a source that times out is rendered as a degraded section rather than failing the whole response (`degraded: ['registry']` in the DTO).
- A 5 s in-memory cache on the summary (invalidated by any `doctor.*`, `provider.*`, `catalog.*` event) keeps the screen cheap when several tabs are open.
- WS: the screen subscribes to `health.doctor`, `health.cases`, `health.registry`, `health.updates` and `catalog`; the client merges deltas into the summary it already has (snapshot + delta, the M0-06 pattern) and refetches the summary only on reconnect.
- No processes, no filesystem, no network in this step — every action is a call to an existing use case.
- Perf: the case list is virtualised (`@tanstack/react-virtual`, already used by M5-04's timeline); the drawer lazy-loads full evidence (`GET /api/repair-cases/:id`) only when opened. Budgets from `12-ux-principles.md` apply: screen interactive ≤ 1.5 s cold, first WS frame ≤ 500 ms.

### 4.5 API / UI surface
- `GET /api/health/summary?window=30d` → `HealthSummary` (+ `degraded: string[]`). `GET /api/health/slos?window=30d` → `SloMetric[]`.
- Actions reuse endpoints already defined: `POST /api/doctor/run` (M6-01), `POST /api/repair-cases/:id/remediate` and `GET …/attempts` (M6-04), `POST /api/repair-cases/:id/close` (M6-02), `POST /api/registry/refresh` and `POST /api/registry/providers/:id/rollback` (M6-03), `POST /api/canary/run` and `POST /api/watchers/poll` (M6-05). Each is called with an `Idempotency-Key` and a declared permission name (`maintenance:run`, `maintenance:remediate`, `maintenance:rollback`) for M9-01.
- CLI: `orch health [--json] [--window 30d]` prints the SLO table, doctor summary, open cases and registry status; exit 0 when no SLO is `breached` and no case is `needs_human`, 1 otherwise (usable in a cron/CI check).
- **Components** (`apps/web/src/features/health/`):
  - `HealthScreen` — sections in order: SLOs, Doctor, Repair cases, Registry, Updates & canary. Nav entry "Health"; `⌘K` actions "Run doctor", "Open Health", "Retry last remediation".
  - `SloTileRow` / `SloTile` — label, target ("< 60 s p95"), value, sample size ("n = 23 · 30 d"), status as icon + word (`met` ✓, `at-risk` !, `breached` ✕, `insufficient-data` –). Never colour-only. `insufficient-data` renders neutral with "not enough samples yet".
  - `DoctorCard` — last run (trigger, time, exit code), pass/warn/fail/skipped counts, **Run doctor** (disabled with a spinner while `running: true`), expandable `DoctorCheckTable` (check · provider · status · message · ms) with evidence in a `<RedactedJson>` viewer.
  - `RepairCaseList` — virtualised, filterable by state/provider/kind, columns: opened, provider + CLI version, kind, confidence, state, ladder step, attempts, TTD, TTR. Row → drawer.
  - `RepairCaseDrawer` — header (kind, confidence, fingerprint, provider/version), **Classification** (rationale rules with their signal counts), **Evidence** (signal list, redacted detail), **`RemediationTimeline`** (one row per attempt: ladder step, strategy, safety class, duration vs budget, outcome, verification result, error), and actions **Retry remediation** (with an optional strategy picker) and **Close case** (reason required). A `needs_human` case shows why the ladder stopped and a placeholder for the M10-01 proposal tab.
  - `RegistryPanel` — per provider: active manifest version + source + signature status + `verifiedAt`, available version, **Refresh** and **Rollback** (rollback opens `RollbackPreviewModal`: from → to, what changes, "running sessions keep their pinned manifest", explicit Confirm).
  - `UpdatesPanel` — `UpdateImpact` rows (severity icon, installed vs latest, suggested action, impacted manifests) with **Run canary** / **Refresh registry** / **Dismiss**, plus the latest canary verdict per provider with its three gate chips.
  - States: loading (skeletons), empty ("nothing has drifted — last doctor run 12 min ago"), error (retry button + last known summary), degraded (per-section banner naming the timed-out source), offline (WS disconnected banner; data shown with an "as of" timestamp).
  - Responsive: tiles wrap to 2 columns ≥ 640 px and 4 ≥ 1024 px; the case table collapses to cards at phone width; the drawer becomes a full-screen sheet. RTL via logical properties; `prefers-reduced-motion` respected; every interactive element reachable by keyboard with visible focus.

### 4.6 Flow / sequence
```
open /health
 → GET /api/health/summary?window=30d   (parallel repo reads, 500 ms per-source timeout, 5 s cache)
 → render sections; subscribe WS health.doctor|cases|registry|updates + catalog
 → WS delta ─▶ merge into the local summary (no refetch); reconnect ─▶ refetch summary

Run doctor        → POST /api/doctor/run {trigger:'manual'} → 202 → DoctorCard shows "running"
                    → WS health.doctor ─▶ card + SLO tiles update
Retry remediation → drawer → optional strategy → POST /api/repair-cases/:id/remediate
                    → WS attempt_started/attempt_finished ─▶ timeline rows stream in
                    → case fixed ─▶ ttr recorded ─▶ SLO-2 tile recomputes on the next summary tick
Rollback manifest → RollbackPreviewModal (from → to, effects) → Confirm
                    → POST /api/registry/providers/:id/rollback → WS health.registry ─▶ panel updates
Run canary        → POST /api/canary/run → WS health.updates ─▶ gate chips progress → verified badge
```

## 5. Tasks
- [ ] `packages/core/src/maintenance/slo.ts`: `SloTarget`, `SloMetric`, `percentile()`, `computeSlo()` with R-S1…R-S6; 100 % branch coverage.
- [ ] Migration `NNN-m6-07-health-indexes` (`repair_cases(closed_at)`, `repair_attempts(finished_at, safety)`).
- [ ] `GetSloMetrics` use case + sample extraction queries (ttd from cases, ttr from closed-remediated cases, ratios).
- [ ] `GetHealthSummary` use case: parallel reads, per-source timeout, `degraded[]`, 5 s cache with event invalidation.
- [ ] `health.controller.ts` + Zod DTOs + OpenAPI; permission names declared for M9-01.
- [ ] WS fan-in on the client: subscribe to the four health topics + `catalog`, snapshot+delta merge, reconnect refetch.
- [ ] `packages/ui`: `StatusChip` (icon + label), `MetricTile`, `RedactedJson` viewer, `TimelineRow` — shared, RTL-safe, AA contrast.
- [ ] `SloTileRow` / `SloTile` with target, value, sample size, window and the four statuses.
- [ ] `DoctorCard` + `DoctorCheckTable` (expandable evidence, Run doctor with in-flight state).
- [ ] `RepairCaseList` (virtualised, filters, keyboard navigation) and the summary DTO it consumes.
- [ ] `RepairCaseDrawer`: classification, evidence, `RemediationTimeline`, Retry (strategy picker) and Close (reason) actions.
- [ ] `RegistryPanel` + `RollbackPreviewModal` (preview text, session-pinning note, explicit confirm).
- [ ] `UpdatesPanel` with update rows, canary gate chips and the three actions.
- [ ] Empty / loading / error / degraded / offline states for all five sections.
- [ ] `apps/cli/src/commands/health.ts`: table + `--json`, exit code 0/1.
- [ ] Remove `features.maintenance` from the config schema and every guard; add the unknown-key warn path; update `ENVIRONMENT.md`/README references.
- [ ] Playwright E2E covering the five actions against FakeProvider; axe-core accessibility assertion on the screen.
- [ ] Capture the milestone exit-criteria evidence (E1–E10 in the M6 README) as screenshots into `plan/07-m6-self-maintenance/evidence/`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-07-01 | unit | `computeSlo` for n = 0, 1, 4, 5, 100 samples around the 60 s / 10 s targets | `insufficient-data` below `minSample`; `met`/`at-risk`/`breached` exactly per R-S2; 100 % branch |
| UT-M6-07-02 | unit | `percentile` nearest-rank against a reference implementation over 1 000 random arrays | identical results; `null` for an empty array; no NaN |
| UT-M6-07-03 | unit | R-S4: a case closed `cli_version_changed` | contributes to `ttd` samples, absent from `ttr` and from the auto-resolved ratio |
| AT-M6-07-01 | application | `GetHealthSummary` with the registry repository throwing | `degraded: ['registry']`, HTTP 200, every other section populated |
| AT-M6-07-02 | application | summary cache: 5 calls in 1 s, then a `doctor.ran` event, then 1 call | 1 repository pass for the first five, a fresh pass after the event |
| IT-M6-07-01 | integration | seed 20 cases/attempts → `GET /api/health/slos?window=30d` | p50/p95/sampleSize match a reference computation; targets from config echoed |
| E2E-M6-07-01 | e2e | Health screen against FakeProvider: inject drift, watch case → attempt → fixed | case row appears, drawer timeline streams two attempts over WS, SLO tiles update without a manual reload |
| E2E-M6-07-02 | e2e | all five actions (run doctor, retry, close, refresh registry, rollback with preview, run canary) | each issues one idempotent request, shows an in-flight state, updates over WS, and writes one `audit_log` row |
| E2E-M6-07-03 | e2e | axe-core on Health in light/dark, LTR and RTL, at 390 px and 1440 px | zero serious/critical violations; no colour-only status; visible focus on every control |
| E2E-M6-07-04 | e2e | WS disconnected mid-view | offline banner with "as of \<ts\>"; actions disabled with a reason; reconnect refetches the summary and clears the banner |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-07-01 | The screen tells the whole story | 1. Run the M6 README demo script steps 1–6. 2. Open Health. | Every section populated: SLO tiles with values + n, last doctor run, ≥ 3 cases with kinds and ladder steps, remediation timeline per case, registry showing manifest sources, updates + canary verdicts | ⬜ |
| TC-M6-07-02 | **SLO tiles are honest (truth labelling)** | 1. Fresh DB with 3 cases. 2. Read the TTD tile. 3. Add 3 more cases. | With n = 3 the tile reads "not enough samples yet", neutral, **not green**; at n ≥ 5 it shows p95, n and the 30 d window; hovering shows p50 | ⬜ |
| TC-M6-07-03 | **SLO measurement matches the database** | 1. `orch repair metrics --window 30d --json`. 2. Compare with the tiles and with `select ... from repair_cases/repair_attempts`. | p50/p95 and sample sizes agree across UI, CLI and SQL; TTD p95 < 60 000 ms and TTR p95 < 10 000 ms on the demo data | ⬜ |
| TC-M6-07-04 | Manual "Run doctor" | 1. Click **Run doctor**. 2. Watch the card. 3. `select count(*) from doctor_reports`. | Button shows in-flight, card updates over WS within 5 s, one new report row, one `audit_log` row; double-clicking does not create two runs (coalesced by M6-01) | ⬜ |
| TC-M6-07-05 | Manual "Retry remediation" with a strategy | 1. Open a `needs_human` case. 2. Retry with `ReloadManifest`. | Exactly one new attempt row appears in the timeline with its duration vs budget; case state updates; `actor.kind: user` in the event and audit row | ⬜ |
| TC-M6-07-06 | **Zero-surprise rollback** | 1. Registry panel → **Rollback** on `fake`. 2. Read the preview modal. 3. Confirm. | Modal names from → to and states that running sessions keep their pinned manifest; nothing happens until Confirm; after confirming the panel shows the previous version and `provider.manifest_rolled_back` exists | ⬜ |
| TC-M6-07-07 | **Negative: no secret leaks into the UI** | 1. Create a case whose evidence contained a token (M6-02 TC-09). 2. Open the drawer and expand Evidence. 3. View page source / copy the JSON. | Redacted placeholders only; `grep -Ei 'bearer|sk-|authorization'` over the copied JSON and over the WS frames finds nothing | ⬜ |
| TC-M6-07-08 | **Negative / resilience: daemon partially down** | 1. Stop the registry fixture server and make the registry repository time out (dev hook). 2. Reload Health. | The registry section shows a degraded banner naming the source; every other section renders; no full-page error; actions in the degraded section disabled with a reason | ⬜ |
| TC-M6-07-09 | **Resilience: 200 cases and 1 000 attempts** | 1. Seed the DB. 2. Open Health; scroll the case list; open three drawers. | Screen interactive ≤ 1.5 s, list scrolls at 60 fps (virtualised), drawer opens < 300 ms, daemon RSS growth < 50 MB, summary request < 500 ms | ⬜ |
| TC-M6-07-10 | Phone width + RTL + dark | 1. 390 px viewport, `dir=rtl`, Arabic locale, dark theme. 2. Walk every section and run one action. | Tiles wrap, table becomes cards, drawer is a full-screen sheet, mirrored icons, no horizontal scroll, status readable without colour, the action completes | ⬜ |
| TC-M6-07-11 | `orch health` parity and exit codes | 1. `orch health --json`. 2. `orch health; echo $?` with a `needs_human` case, then after closing it. | JSON equals the API payload; exit 1 while a case needs a human or an SLO is breached, 0 afterwards; usable from cron | ⬜ |
| TC-M6-07-12 | Feature flag removed | 1. Put `features.maintenance: false` in `config.yaml`. 2. Restart the daemon. | Daemon boots, logs "unknown/ignored config key `features.maintenance`", maintenance is active anyway; no code path still reads the flag (`grep -r "features.maintenance" src/` empty) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-07-01 … 12 pass and are recorded with build hash and date.
- [ ] `computeSlo` / `percentile` have 100 % branch coverage; UI, CLI and SQL agree on every SLO number (TC-03).
- [ ] TTD p95 **< 60 s** and safe-remediation TTR p95 **< 10 s** are displayed and met on the acceptance data set, with sample size and window shown on every tile (M6 exit criteria E2, E3).
- [ ] Health shows doctor results, open/closed cases with ladder step and evidence, the remediation history, registry state and available updates; **Run doctor** and **Retry remediation** work from the UI (E9).
- [ ] Every action is idempotent, previewed where it changes state, and produces exactly one `audit_log` row (TC-04…06, E6).
- [ ] No secret- or token-shaped string reaches the browser in any payload or WS frame (TC-07, C3).
- [ ] A failing sub-system degrades one section, never the screen (TC-08); an offline WS shows staleness honestly (E2E-04).
- [ ] Performance and accessibility budgets met: interactive ≤ 1.5 s, first WS frame ≤ 500 ms, 60 fps list at 200 cases, zero serious/critical axe violations in light/dark and LTR/RTL (TC-09, TC-10).
- [ ] `features.maintenance` is gone from the schema and the code, and the daemon tolerates the stale key (TC-12).
- [ ] No new lint/dependency-cruiser violations; `apps/web` imports only `packages/ui` and `packages/sdk` types.
- [ ] M6 exit-criteria evidence E1–E10 captured in `plan/07-m6-self-maintenance/evidence/`; `PROGRESS.md` and the milestone README updated.

## 8. Risks / open questions
- **A dashboard nobody reads** is the named milestone risk. Mitigation is structural: anything actionable is an Attention item first (`repair_needs_human`, `provider_update`, `model_deprecated`) and Health is the drill-down. If TC-01 leaves you thinking "I'd never open this", cut sections rather than adding colour.
- SLO targets live in config, so a user can make their own numbers green. The acceptance run must use the shipped defaults, and the tile shows the target value so a tightened/loosened target is visible rather than implied.
- Small sample sizes are the norm on a healthy machine — most users will see `insufficient-data` for weeks. That is the correct, honest output (R-S1); do not "warm up" the tiles with synthetic data.
- The summary endpoint fans out over six repositories; on Postgres in team mode (M9-05) the parallel reads may need a shared connection budget — re-check when M9-05 lands.
- Removing `features.maintenance` means M6 code runs for everyone, including users with no registry configured; the default config keeps `maintenance.registry.enabled: false`, so the only always-on parts are Doctor, drift detection and ladder-1 — verify that combination on a machine with a single provider before removing the flag.
- The case drawer is where M10-01 adds a "Proposal" tab; keep the drawer's tab structure and the `needs_human` placeholder stable so that step is additive.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
