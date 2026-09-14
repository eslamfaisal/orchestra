# Step M4-02 — QuotaForecaster

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-01 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `apps/daemon` (application/quota, infrastructure/quota, interface/http, interface/ws) |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step every `WindowState` produced by M4-01 has a companion `QuotaForecast`: a burn rate (EWMA over `UsageSample`s, in units/hour), a time-to-limit, a projected exhaust timestamp, a projected utilisation at `resetAt`, and a threshold level (`unknown | ok | warn | high | critical`) derived from the 70 / 85 / 95 % marks. Forecasts are recomputed when a window changes and on a 60 s tick, persisted so they survive a restart, published as `quota.forecast_updated`, and readable at `GET /fleet/forecasts`. The assignment engine's `quotaAvailability(provider)` factor (`06-intelligence-layer.md` §3) stops being a stub and starts returning a number derived from the forecast. Every forecast field is labelled `confidence: 'estimate'` — a forecast is never *official*, even when the window it is built on is. No UI yet (M4-07).

## 2. Why
- **G4 (never blocked)**: pre-emptive rerouting (M4-03) and reserves (M4-04) both need "when will this window run out", not just "how much is used".
- **G2 (≥ 80 % of each paid window used productively)**: utilisation is only measurable against a projected end-of-window figure; M4-07 renders exactly these numbers.
- **D3** (deterministic engine, not LLM guesses): the forecaster is a pure domain service with 100 % branch coverage and property tests, so routing behaviour under quota pressure is reproducible in golden tests.
- **D7 / `06-intelligence-layer.md` §3**: `score = capabilityFit × quotaAvailability × costEfficiency × constraints`; this step supplies `quotaAvailability`.
- **UX principle 4 "truth labelling"** and non-goal "exact remaining-quota readouts where vendors don't expose them": the forecast carries its own `confidence`, the `windowConfidence` it was derived from, `sampleCount` and `spanMinutes`, so the UI can say *estimate from 7 samples over 42 min*.
- **C5 indirectly**: a good forecast means fewer requests that would have been rate-limited at all; the forecaster never probes a vendor, it only reads samples M4-01 already stored.

## 3. Scope
### In scope
- Pure domain service `QuotaForecaster` + `BurnRateEstimator` in `packages/core/src/quota/forecast/` with rules R-F1…R-F9.
- Value objects `BurnRate`, `QuotaForecast`, `ForecastLevel`, `ForecastBasis`, `ForecastThresholds`.
- Pure `availabilityScore(forecast | null)` → `0…1` consumed by the assignment engine through a port (no engine rewrite: M2-04 already calls `quotaAvailability`).
- Daemon: `RecomputeForecast`, `GetFleetForecasts` use cases; `ForecastScheduler` (event-driven + 60 s tick); `quota_forecasts` table + repository; `quota.forecast_updated` event; `GET /fleet/forecasts`, `GET /providers/:id/forecasts`; WS `quota` topic extension.
- Threshold crossing detection with hysteresis; one Attention platform item when a window first crosses 95 % (reuses the M1-11 queue).
- FakeProvider scenarios `burn-steady.yaml`, `burn-to-85.yaml`, `burn-spiky.yaml`.
### Out of scope (deferred to …)
- Cooling, retries and actually rerouting on a forecast/threshold — deferred to M4-03.
- Reserves, per-mission budgets, `quota.reserve_breached` — deferred to M4-04.
- Lead handoff on projected exhaustion — deferred to M4-05.
- Whole-mission simulation of window impact — deferred to M4-06.
- Fleet bars, chips, KPI strip — deferred to M4-07.
- Learning the forecast parameters from outcomes — deferred to M8-06 (half-lives stay config in M4).
- Cross-host aggregation of windows — deferred to M7-05.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/quota/forecast/{burn-rate.ts, thresholds.ts, quota-forecast.ts, quota-forecaster.ts, availability.ts}`. Zero I/O; `now` is passed in, ids come from `IdGenerator` at the application layer.

Rules (100 % branch coverage in `quota-forecaster.spec.ts`):
- **R-F1 Forecasts are never official.** `QuotaForecast.confidence` is the literal `'estimate'`. The window's own confidence travels as `windowConfidence` for display only. Asserted by a type-level test and a runtime test.
- **R-F2 Evidence gate.** With fewer than `minSamples` (default 3) usage samples, or a sample span shorter than `minSpanMinutes` (default 10), the forecast is `{ level: 'unknown', burnRatePerHour: 0, timeToLimitMs: undefined, projectedExhaustAt: undefined }`. Never extrapolate from one sample.
- **R-F3 Bucketed EWMA.** Samples are folded into fixed buckets of `bucketMinutes(kind)`; per-bucket rate = units in bucket ÷ bucket length; `ewma_b = α·rate_b + (1−α)·ewma_{b−1}` with `α = 1 − 2^(−bucketMinutes / halfLifeMinutes)`. Empty buckets contribute rate `0` (idle time lowers the burn rate — a fleet that stops working must not keep forecasting exhaustion).
- **R-F4 Time-to-limit.** `timeToLimitMs = (limit − used) / burnRatePerMs` only when `limit` is known, `limit > used` and `burnRatePerHour > 0`; otherwise `undefined`. `used ≥ limit` ⇒ `timeToLimitMs = 0`, `level = 'critical'`.
- **R-F5 Reset wins.** If `resetAt` is known and `now + timeToLimitMs ≥ resetAt`, the window resets before it is exhausted: `willResetFirst = true`, `projectedExhaustAt = undefined`, and the level is computed from `projectedUsedAtReset = used + burnRate × (resetAt − now)` clamped to `[used, ∞)`.
- **R-F6 Thresholds + hysteresis.** Level from `pct = 100 × projectedUsedAtReset / limit` (or `100 × used / limit` when `resetAt` is unknown): `< 70 ok`, `≥ 70 warn`, `≥ 85 high`, `≥ 95 critical`. A level only falls again once `pct` drops `hysteresisPp` (default 5) below the threshold that raised it; the previous level is an input to `forecast()`, not hidden state.
- **R-F7 No limit ⇒ no level.** If `limit` is unknown the level is `unknown` regardless of burn rate; `burnRatePerHour` and `spanMinutes` are still reported (they are useful on their own and feed M4-06 estimates).
- **R-F8 Total function.** `forecast()` never throws and never returns `NaN`, `Infinity` or a negative number in any numeric field. Zero-length windows, `resetAt` in the past, duplicate timestamps, out-of-order samples and `limit = 0` are all handled (`limit = 0` ⇒ treated as unknown, R-F7).
- **R-F9 Monotonicity.** For a fixed `(used, limit, now)`: a larger burn rate never yields a larger `timeToLimitMs`; a larger `used` never yields a larger `timeToLimitMs`; `level` is non-decreasing in `pct` at equal previous level. Property-tested.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/quota/forecast/quota-forecast.ts
import type { Confidence, ProviderId, UsageUnit, WindowKind, WindowState } from '../window-state';

export type ForecastLevel = 'unknown' | 'ok' | 'warn' | 'high' | 'critical';

export interface BurnRate {
  perHour: number;          // units of `unit` per hour, ≥ 0, finite
  unit: UsageUnit;
  halfLifeMinutes: number;  // parameter used, echoed for explainability
}

export interface ForecastBasis {
  sampleCount: number;      // samples inside the lookback
  spanMinutes: number;      // first→last sample span, 0 when < 2 samples
  bucketMinutes: number;
  lookbackMinutes: number;
  windowConfidence: Confidence;   // confidence of the WindowState this was derived from
  windowSource: WindowState['source'];
}

export interface QuotaForecast {
  providerId: ProviderId;
  kind: WindowKind;
  burn: BurnRate;
  used: number;
  limit?: number;
  usedPct?: number;                 // 0…100, only when limit is known
  projectedUsedAtReset?: number;
  projectedUtilisationPct?: number; // G2 window-utilisation input
  timeToLimitMs?: number;
  projectedExhaustAt?: string;      // ISO-8601 UTC
  willResetFirst: boolean;
  level: ForecastLevel;
  crossed?: 70 | 85 | 95;           // set only on the recompute that raised the level
  confidence: 'estimate';           // R-F1 — literal type, never widened
  basis: ForecastBasis;
  computedAt: string;
}

export interface ForecastParams {
  halfLifeMinutes: Record<WindowKind, number>;   // 5h:20, daily:120, weekly:720, tokens:60
  bucketMinutes: Record<WindowKind, number>;     // 5h:5,  daily:15,  weekly:60,  tokens:5
  lookbackMinutes: Record<WindowKind, number>;   // 5h:300, daily:1440, weekly:10080, tokens:720
  minSamples: number;        // 3
  minSpanMinutes: number;    // 10
  thresholds: [70, 85, 95];
  hysteresisPp: number;      // 5
}

export interface ForecastInput {
  window: WindowState;
  samples: ReadonlyArray<Pick<UsageSample, 'ts' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>>;
  previousLevel: ForecastLevel;    // for hysteresis; 'unknown' on first run
  params: ForecastParams;
  now: IsoTimestamp;
}

// packages/core/src/quota/forecast/quota-forecaster.ts
export interface QuotaForecaster {
  forecast(input: ForecastInput): QuotaForecast;              // total, pure, never throws (R-F8)
}
export const createQuotaForecaster: () => QuotaForecaster;

// packages/core/src/quota/forecast/availability.ts
/** Engine factor for `score = capabilityFit × quotaAvailability × …` (06 §3). */
export function availabilityScore(f: QuotaForecast | null): number;   // ok/unknown 1.0 · warn 0.85 · high 0.5 · critical 0.2 · used ≥ limit 0
```
```ts
// apps/daemon/src/application/quota/ports.ts (additions)
export interface QuotaForecastRepository {
  upsert(f: QuotaForecast): Promise<Result<void, StorageError>>;
  list(providerId?: ProviderId): Promise<Result<QuotaForecast[], StorageError>>;
  get(providerId: ProviderId, kind: WindowKind): Promise<Result<QuotaForecast | null, StorageError>>;
}
/** Implemented here, consumed by the AssignmentEngine adapter from M2-04 — DI, no switch. */
export interface QuotaAvailabilityPort {
  scoreFor(providerId: ProviderId): number;       // min over that provider's window forecasts
  worstLevel(providerId: ProviderId): ForecastLevel;
}
```
Use cases (`apps/daemon/src/application/quota/`, one class each, `Result`-returning): `RecomputeForecast` (per `(provider, kind)`), `RecomputeAllForecasts` (tick), `GetFleetForecasts`. Errors: `QuotaError = ProviderNotEnabled | StorageError`.

### 4.3 Data / schema changes
Migration `apps/daemon/src/infrastructure/persistence/migrations/<next>-m4-02-quota-forecasts.ts` (additive; shipped migrations untouched). New table `quota_forecasts` (not in `04-domain-model.md` §4 v1 — add the row to that table when the step closes):

| Column | Type | Note |
|---|---|---|
| `id` | TEXT (ULID) | |
| `provider_row_id` | TEXT | FK `providers.id` |
| `kind` | TEXT | `5h`/`weekly`/`daily`/`tokens` |
| `burn_per_hour` | REAL | ≥ 0 |
| `unit` | TEXT | mirrors `provider_windows.unit` |
| `used`, `limit` | REAL / REAL NULL | snapshot the forecast was computed from |
| `used_pct`, `projected_used_at_reset`, `projected_utilisation_pct` | REAL NULL | |
| `time_to_limit_ms` | INTEGER NULL | |
| `projected_exhaust_at` | TEXT NULL | ISO-8601 UTC |
| `will_reset_first` | INTEGER | 0/1 |
| `level` | TEXT | `unknown`…`critical` |
| `basis_json` | TEXT | Zod-validated `ForecastBasis` |
| `computed_at` | TEXT | |

Unique index `(provider_row_id, kind)`; index `(level)`. Rows are overwritten in place (one live forecast per window); history lives in the `events` table.

Event `quota.forecast_updated` (already in the catalog, `04-domain-model.md` §3): payload = `QuotaForecast`, Zod-validated on write, `source.channel = 'system'`. Emitted only when a field the UI shows actually changed (level, `usedPct` by ≥ 1 pp, `burn.perHour` by ≥ 5 %, `projectedExhaustAt` by ≥ 60 s) — otherwise the tick is silent, so the WS topic stays quiet on an idle fleet.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No processes, no tmux, no network. The forecaster reads `provider_windows` + `usage_samples` (M4-01) through repositories only.
- `apps/daemon/src/infrastructure/quota/forecast.scheduler.ts`: subscribes to `quota.window_updated` and `quota.rate_limited` with a 5 s debounce per `(provider, kind)`; plus a 60 s `setInterval` tick (injected `Clock`, fake timers in tests) so time decay and `resetAt` rollovers are reflected without new samples. Both paths funnel into `RecomputeForecast`; recomputation for one window is serialised by a per-key in-flight guard.
- Sample loading is bounded: `lookbackMinutes(kind)` and a hard cap of 5 000 samples per recompute (oldest dropped, `basis.sampleCount` reports the truncated count). On an empty repository the scheduler does nothing.
- Params come from config (`quota.forecast.*`, Zod-validated, fail-fast) with the defaults in `ForecastParams`; overridable per provider in `~/.orchestra/config.yaml`.
- Boot: forecasts are loaded from `quota_forecasts` into the `QuotaAvailabilityPort` cache before the HTTP server starts accepting traffic, so the engine never scores against an empty cache after a restart.

### 4.5 API / UI surface
- `GET /fleet/forecasts` → `{ forecasts: QuotaForecast[], params: ForecastParams }`.
- `GET /providers/:id/forecasts` → `QuotaForecast[]` for one provider (404 `ProviderNotEnabled`).
- `GET /providers/:id/windows` (M4-01) gains an optional `?includeForecast=true` returning `{ kind, state, forecast }` triples.
- WS `/ws` topic `quota` also carries `quota.forecast_updated`.
- Attention: one platform item `quota.threshold` when a window first reaches level `critical` (title `claude 5h window projected to hit 95 %`, body with burn rate + projected time, action *Open Fleet*), auto-resolved when the level falls back below 95 − hysteresis or the window rolls over. No item for `warn`/`high` — those are ambient state in M4-07.
- No screen work in this step.

### 4.6 Flow / sequence
```
IngestUsageSample (M4-01) ─▶ quota.window_updated ─┐
quota.rate_limited (M4-01) ────────────────────────┤
60 s tick (Clock) ─────────────────────────────────┴─▶ ForecastScheduler (debounce 5 s, per-key in-flight guard)
   ─▶ RecomputeForecast(providerId, kind)
        ├─ ProviderWindowRepository.get(provider, kind)        → WindowState | null → null ⇒ stop
        ├─ UsageSampleRepository.since(provider, now − lookback)
        ├─ QuotaForecastRepository.get → previousLevel
        ├─ QuotaForecaster.forecast({window, samples, previousLevel, params, now})   ← pure
        ├─ QuotaForecastRepository.upsert
        ├─ QuotaAvailabilityPort cache update  ──▶ AssignmentEngine.quotaAvailability (M2-04)
        └─ changed? ─▶ emit quota.forecast_updated ─▶ /ws topic quota
                       crossed 95 for the first time ─▶ Attention item quota.threshold
```

## 5. Tasks
- [ ] `packages/core/src/quota/forecast/`: `ForecastLevel`, `BurnRate`, `QuotaForecast`, `ForecastBasis`, `ForecastParams` types + Zod schemas mirrored in `packages/sdk`.
- [ ] `BurnRateEstimator`: bucketing, empty-bucket handling, EWMA with `α` from half-life (R-F3); unit tests incl. out-of-order and duplicate timestamps.
- [ ] `QuotaForecaster.forecast()` implementing R-F1…R-F9; 100 % branch coverage.
- [ ] `availabilityScore()` + table test for every level; exported from `packages/core`.
- [ ] Property tests (fast-check, ≥ 1 000 runs): no `NaN`/`Infinity`/negative; monotonic in burn rate and in `used`; `confidence` always `'estimate'`.
- [ ] Migration `m4_02_quota_forecasts` + Kysely `QuotaForecastRepository` + in-memory double.
- [ ] Use cases `RecomputeForecast`, `RecomputeAllForecasts`, `GetFleetForecasts` (one class each, constructor-injected ports).
- [ ] `ForecastScheduler` (event subscription + debounce + 60 s tick + in-flight guard), behind `features.quota`.
- [ ] `QuotaAvailabilityPort` implementation + DI registration; wire into the M2-04 engine's `quotaAvailability` slot; update the engine's golden tests with a "provider at level `critical` loses to a healthy fallback" case.
- [ ] Change-detection filter + `quota.forecast_updated` emission with Zod-validated payload.
- [ ] Attention platform item `quota.threshold` (raise + auto-resolve) via the M1-11 queue.
- [ ] HTTP controller `GET /fleet/forecasts`, `GET /providers/:id/forecasts`, `?includeForecast` on windows; DTOs + OpenAPI.
- [ ] Boot warm-up: load persisted forecasts into the availability cache before listening.
- [ ] Config keys `quota.forecast.{halfLifeMinutes,bucketMinutes,lookbackMinutes,minSamples,minSpanMinutes,hysteresisPp}` + per-provider overrides.
- [ ] FakeProvider scenarios `burn-steady.yaml`, `burn-to-85.yaml`, `burn-spiky.yaml` (emit-usage sequences with controlled pacing).
- [ ] Docs: `packages/core/README.md` forecaster section (formula + parameters); add `quota_forecasts` to `04-domain-model.md` §4; `PROGRESS.md` row.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-02-01 | unit | steady 1 000 tokens/5 min for 60 min, `limit` 100 000, `used` 12 000 | `burn.perHour ≈ 12 000` (±2 %), `timeToLimitMs ≈ 7.33 h`, `level` from projected pct, `confidence: 'estimate'` |
| UT-M4-02-02 | unit | 2 samples over 4 min (below both gates) | `level: 'unknown'`, `burn.perHour: 0`, `timeToLimitMs: undefined`, `basis.sampleCount: 2` |
| UT-M4-02-03 | unit | burst then 45 min idle (empty buckets) | burn rate decays toward 0; `projectedExhaustAt` moves later then becomes `undefined`; no throw |
| UT-M4-02-04 | unit | hysteresis: pct 86 → level `high`; pct 81 → stays `high`; pct 79 → `warn` | level falls only after dropping `hysteresisPp` below the raising threshold; `crossed` set only on the rise |
| UT-M4-02-05 | unit | `limit` undefined / `limit: 0` / `used > limit` / `resetAt` in the past | `unknown` (R-F7) / `unknown` / `level: 'critical'`, `timeToLimitMs: 0` / rollover handled, no negative field |
| UT-M4-02-06 | unit (property, fast-check, 1 000 runs) | random sample sequences, limits, resets, `now` | never throws; every numeric field finite and ≥ 0; `confidence === 'estimate'`; `timeToLimitMs` non-increasing in burn rate and in `used` |
| UT-M4-02-07 | unit | `availabilityScore` for each level and for `null` | `1.0 / 1.0 / 0.85 / 0.5 / 0.2 / 0` per table; `null` ⇒ `1.0` (never penalise an unknown window) |
| AT-M4-02-01 | application | `RecomputeForecast` with fake clock; 20 `quota.window_updated` in 2 s | debounced to one recompute; one `quota.forecast_updated`; no duplicate rows |
| AT-M4-02-02 | application | recompute twice with an unchanged window | second emits nothing (change filter) but `computed_at` still refreshes |
| AT-M4-02-03 | application | window crosses 95 % then rolls over at `resetAt` | one `quota.threshold` Attention item raised then auto-resolved; no duplicate items |
| AT-M4-02-04 | application | engine golden test: two capable providers, one at level `critical` | healthy provider chosen; `RoutingDecision.reasons` includes the quota factor and its value |
| IT-M4-02-01 | integration | migration + repository round-trip; restart with persisted forecasts | forecasts survive; availability cache warm before the first request is served |
| E2E-M4-02-01 | e2e (Playwright + FakeProvider) | run `burn-to-85.yaml`, poll `GET /fleet/forecasts` | level walks `unknown → ok → warn → high`; `projectedExhaustAt` monotonically approaches; all `confidence: 'estimate'` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-02-01 | First real forecast from Claude Code | 1. Run three short `quick` tasks on Claude Code in `~/orchestra-scratch/` over ~15 min. 2. `GET /providers/claude/forecasts`. | `5h` forecast with `burn.perHour > 0`, `basis.sampleCount ≥ 3`, `basis.spanMinutes ≥ 10`, `confidence: "estimate"`, `basis.windowConfidence` matching the window (`estimate` unless a vendor figure arrived). | ⬜ |
| TC-M4-02-02 | Evidence gate (negative) | 1. Restart the daemon with an empty `usage_samples` table (fresh DB). 2. Run exactly one task on Codex. 3. `GET /providers/codex/forecasts`. | `level: "unknown"`, `burn.perHour: 0`, no `projectedExhaustAt`, no `quota.threshold` Attention item. Nothing is invented from one sample. | ⬜ |
| TC-M4-02-03 | FakeProvider walk to `high` | 1. Set `fake-b` window `limit` via scenario `burn-to-85.yaml`. 2. Start it. 3. Watch WS topic `quota`. | `quota.forecast_updated` events show level `ok → warn → high`; each payload has `crossed` set exactly once per threshold; `usedPct` rises monotonically. | ⬜ |
| TC-M4-02-04 | Idle decay | 1. After TC-03, stop all `fake-b` sessions. 2. Wait 10 min without starting anything. | `burn.perHour` falls on each 60 s tick; `projectedExhaustAt` moves later and then disappears; level drops only after the hysteresis margin, never oscillates. | ⬜ |
| TC-M4-02-05 | Negative: no limit ⇒ no level | 1. Pick a provider whose window has `used` but no `limit` (Claude, unless a vendor figure arrived). 2. Read its forecast. | `level: "unknown"`, `usedPct` absent, `burn.perHour` still reported. No fabricated limit anywhere in the payload (C-rule "never fabricate", R-W4). | ⬜ |
| TC-M4-02-06 | Threshold item at 95 % | 1. Run `burn-to-85.yaml` with `overshoot: true` so `fake-b` projects > 95 %. 2. Open Attention. | One item "fake-b 5h window projected to hit 95 %" with burn rate and projected time, both labelled *estimate*; it auto-resolves when the scenario's window rolls over. | ⬜ |
| TC-M4-02-07 | Restart resilience | 1. While `fake-b` is at level `high`, `kill -9` the daemon. 2. Restart. 3. Immediately `GET /fleet/forecasts` and Quick-Delegate a task. | Same level and `projectedExhaustAt` as before the kill (recomputed, not reset to `unknown`); the first routing decision after boot already reflects the degraded availability (no cold-cache window where `fake-b` scores 1.0). | ⬜ |
| TC-M4-02-08 | Real rate limit, observed safely | 1. Do not provoke a limit (C5). 2. When one occurs naturally, or replay a recorded fixture: `pnpm --filter @orchestra/daemon fixtures:replay claude exit/429.txt --session <id>`. 3. Read the forecast. | The window's `resetAt` from the vendor payload is used for `willResetFirst` / `projectedUsedAtReset`; the forecast still reports `confidence: "estimate"` even though `windowConfidence` is `official`. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `QuotaForecaster` and `BurnRateEstimator` reach **100 % branch coverage**; the property test UT-M4-02-06 passes with ≥ 1 000 runs.
- [ ] No output field is ever `NaN`, `Infinity` or negative, and `confidence` is `'estimate'` in every code path (enforced by the literal type plus a runtime assertion test).
- [ ] Every window with ≥ `minSamples` samples spanning ≥ `minSpanMinutes` has a persisted forecast within 65 s of the last sample; windows below the gate report `unknown` and nothing else.
- [ ] `AssignmentEngine.quotaAvailability` is served by `QuotaAvailabilityPort`; the M2-04 golden suite still passes and gained the degraded-provider case.
- [ ] `GET /fleet/forecasts` returns in < 100 ms with 5 providers × 4 windows; forecasts survive `kill -9` + restart with the availability cache warm before the first request.
- [ ] `quota.forecast_updated` is emitted only on material change (verified by AT-M4-02-02); an idle fleet produces no WS traffic on the `quota` topic.
- [ ] All TC-M4-02-01…08 pass and are recorded with build hash and date.
- [ ] No new ESLint / dependency-cruiser / architecture violations; `packages/core` still imports nothing (the forecaster takes `now` as a parameter, never reads a clock).
- [ ] `04-domain-model.md` §4 lists `quota_forecasts`; `PROGRESS.md` row updated.

## 8. Risks / open questions
- Half-life defaults (20 min for a 5-h window) are guesses; too short makes the forecast twitchy, too long makes it blind to a burst. Mitigation: parameters are config, `basis` is in every payload, and M8-06 can tune them from outcomes later.
- Vendor windows may be **rolling** rather than fixed (verify against Claude Code / Codex / Antigravity docs at step start). A rolling window makes `projectedUsedAtReset` pessimistic; R-F5 keeps it conservative, which is the safe direction for G4 but may under-use quota (G2). Revisit in M4-07 with real observations.
- `used` for Claude is a sum of our own samples (M4-01 R-W2) and therefore misses usage from sessions started outside Orchestra (`tmux attach`, another terminal). The forecast will under-estimate. Mitigation: `basis.windowConfidence` + the Fleet copy in M4-07 says "Orchestra-observed usage only"; nothing is fabricated to compensate.
- Mixing units inside one provider (`tokens` vs `credits` for agy — verify against Antigravity docs at step start): forecasts are per `(provider, kind)` and carry `unit`, so no cross-unit arithmetic ever happens; aggregation across kinds is intentionally not attempted.
- `availabilityScore` steps (0.85 / 0.5 / 0.2) are product policy, not science; they change routing behaviour and must be changed only with the M2-04 golden suite updated in the same PR.
- Cache/DB divergence if a write fails after the cache update: the upsert happens before the cache update, and a failed upsert aborts the recompute (no event, no cache change).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
