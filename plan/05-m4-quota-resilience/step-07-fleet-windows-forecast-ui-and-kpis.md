# Step M4-07 — Fleet windows/forecast UI & KPIs

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-02 |
| Estimated effort | 1.5 days |
| Packages touched | `apps/web` (screens/fleet), `packages/ui`, `apps/daemon` (application/kpi, interface/http) |
| Risk | Low |
| Owner | |

## 1. Goal
After this step the Fleet screen (v1 from M1-10) shows, per provider, every declared quota window as a card with used / limit / reset countdown, a forecast bar with the projected end-of-window utilisation and time-to-limit, a confidence chip that says **official** or **estimate** on every single number, a cooling badge with a live countdown when M4-03 has the provider cooling, and reserve shading on the bar when M4-04 has a reserve on that window. Above the provider grid a KPI strip reports the four M4 numbers — off-top-tier routing %, window utilisation %, reroute success rate, and quota-blocked time % — over a selectable range (24 h / 7 d / 30 d), each with its own definition tooltip and estimate label. Everything updates live over the `quota` and `routing` WS topics; a window with no signal says "No signal yet" and shows no bar at all.

## 2. Why
- **G2** is stated as a measurable target ("≥ 60 % of tasks routed off the top-tier model; ≥ 80 % of each paid window used productively") and `01-vision-scope.md` says the product KPIs are "tracked from M4 onward in the Fleet screen". This is that screen.
- **G4**: the cooling badge and the forecast bar are how a human sees "you are about to be blocked" before the fleet stalls.
- **UX principle 4 (truth labelling)** is the acceptance bar for this step: every number says *official* or *estimate* with its source; nothing is rendered without provenance.
- **UX principle 2 (calm density)**: state is shown by shape + text, never colour alone — this screen is dense and is the main WCAG risk in M4.
- **`12-ux-principles.md`** places windows/forecasts on Fleet at M4-07 explicitly; the reliability budgets table (cold start ≤ 1.5 s, first WS frame ≤ 500 ms) applies here.
- **D1**: one UI codebase; the same components must work in the Tauri shell (M7-01) and in the PWA at phone width (M7-03), so the layout is built responsive now rather than retrofitted.

## 3. Scope
### In scope
- `apps/web/src/screens/fleet/`: `WindowCard`, `ForecastBar`, `ConfidenceChip`, `CoolingBadge`, `ReserveMarker`, `KpiStrip`, `KpiTile`, `WindowEmptyState`, plus the existing provider rows from M1-10.
- Shared primitives promoted into `packages/ui`: `ConfidenceChip`, `MeterBar` (segmented bar with a reserve marker and a projection segment), `Countdown` (reset / cooling, `prefers-reduced-motion` aware).
- Daemon: `ComputeFleetKpis` use case + `GET /fleet/kpis?range=24h|7d|30d` (computed from `routing_decisions`, `tasks`, `task_retries`, `provider_windows`, `reserve_breaches`, `events`), with a 60 s memo.
- Live updates via the existing `quota` topic (`window_updated`, `forecast_updated`, `rate_limited`, `cooling_started/ended`, `reserve_breached`) and `routing` topic (`rerouted`); optimistic countdown ticking in the client between events.
- Empty/unknown/degraded states; a "Refresh (official)" action wired to `POST /providers/:id/windows/refresh` (M4-01) shown only for adapters with a quota-free probe.
- a11y (axe clean, keyboard navigable, screen-reader labels carrying the confidence word), RTL, dark-first tokens, reduced-motion.
### Out of scope (deferred to …)
- Historical charts of window usage over time — deferred to M5-04 (Timeline) where the event history already lives.
- Cross-review coverage %, drift/remediation SLO tiles — deferred to M3-08 (Missions) and M6-07 (Health) respectively.
- Model Scorecards and learned-weight visualisations — deferred to M8-06.
- Editing budgets/policies from this screen (read-only links to Settings) — deferred to M8-02.
- Multi-host fleet aggregation — deferred to M7-05.
- Phone-specific layout polish and push notifications — deferred to M7-03 (the components are responsive here, but the PWA pass is M7).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain types. The screen is a projection of `WindowState` (M4-01), `QuotaForecast` (M4-02), `ProviderAvailability` (M4-03), `ReserveStatus` (M4-04) and a new read-model `FleetKpis`. KPI definitions are fixed and documented in one place so the tooltip, the API and the docs cannot drift:

- **K1 off-top-tier routing %** = `count(routing_decisions where dry_run = 0 and chosen_model.costTier < maxCostTier(provider)) / count(all non-dry-run decisions)` over the range. Target ≥ 60 % (G2).
- **K2 window utilisation %** = mean over windows of `used / limit` at each window's *close* (rollover) inside the range; windows with no `limit` are excluded from the mean and counted in `excludedWindows`. Target ≥ 80 % (G2).
- **K3 reroute success rate** = `count(rerouted tasks that later reached a terminal non-failed state) / count(routing.rerouted)` over the range; `null` when there were no reroutes.
- **K4 quota-blocked time %** = `Σ time tasks spent in state blocked(reason: quota) / Σ time tasks spent in any non-terminal state` over the range. Lower is better; it is the honest counterweight to K2.

Rules: every KPI is `confidence: 'estimate'` (K2 depends on estimated `used`); a KPI with too little data (`sampleCount < 5`) renders as "not enough data" rather than a misleading percentage; all four are computed from persisted rows, never from in-memory counters, so a restart does not reset them.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/kpi/fleet-kpis.ts
export type KpiRange = '24h' | '7d' | '30d';
export interface KpiValue {
  value: number | null;              // null ⇒ not enough data
  sampleCount: number;
  target?: number;                   // G2 targets for K1/K2
  confidence: 'estimate';
  note?: string;                     // e.g. '2 windows excluded: no limit reported'
}
export interface FleetKpis {
  range: KpiRange; from: string; to: string;
  offTopTierRoutingPct: KpiValue;    // K1
  windowUtilisationPct: KpiValue;    // K2
  rerouteSuccessRatePct: KpiValue;   // K3
  quotaBlockedTimePct: KpiValue;     // K4
  computedAt: string;
}
```
```ts
// apps/web/src/screens/fleet/types.ts — the screen's view model
export interface WindowCardVm {
  providerId: ProviderId; kind: WindowKind; unit: UsageUnit;
  used: number; limit?: number; usedPct?: number;
  resetAt?: string; windowConfidence: Confidence; windowSource: QuotaSource; observedAt: string;
  forecast?: { burnPerHour: number; projectedUtilisationPct?: number; timeToLimitMs?: number;
               projectedExhaustAt?: string; level: ForecastLevel; willResetFirst: boolean;
               basis: { sampleCount: number; spanMinutes: number } };
  cooling?: { until: string; confidence: Confidence; reason: string };
  reserves: Array<{ policyId: string; kind: 'lead' | 'review'; reservedUnits?: number; level: BudgetLevel }>;
  canRefreshOfficial: boolean;       // adapter has a quota-free QuotaProbe (M4-01)
}
```
```tsx
// packages/ui/src/meter-bar.tsx  (shared primitive)
export interface MeterBarProps {
  value: number;                     // used, in `unit`
  max?: number;                      // limit; undefined ⇒ renders an "unbounded" track with no fill %
  projected?: number;                // projected value at reset (hatched segment)
  marker?: { at: number; label: string };   // reserve floor
  level: ForecastLevel;              // drives shape/pattern, not colour alone
  ariaLabel: string;                 // must include the confidence word
}
export const ConfidenceChip: React.FC<{ confidence: Confidence; source?: string; title?: string }>;
export const Countdown: React.FC<{ to: string; prefix?: string; onElapsed?: () => void }>;
```

### 4.3 Data / schema changes
None. `ComputeFleetKpis` reads existing tables only (`routing_decisions`, `tasks`, `task_retries`, `provider_windows`, `reserve_breaches`, `events`, `sessions`). Two read-only indexes are added for the range queries: `routing_decisions(created_at, dry_run)` and `events(type, ts)` — index-only migration `<next>-m4-07-kpi-indexes.ts`, no column or table changes.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Nothing launched, no vendor contact. The only outbound action on the screen is *Refresh (official)*, which calls the M4-01 endpoint and therefore runs the adapter's own quota-free probe (`isQuotaFree`) — never for adapters without one, and never for agy without ToS acknowledgement (C11).
- KPI computation is a set of SQL aggregations behind a 60 s memo keyed on `(range)`; the memo is invalidated by `task.*` and `routing.*` events. Budget: < 150 ms for a 30-day range on a database with 100 k events (benchmarked).
- Client: one WS subscription to `quota` + `routing`; a single 1 s interval drives every `Countdown` (one timer for the screen, not one per card) and pauses when the tab is hidden (`visibilitychange`) to protect the idle-memory budget.
- Rendering budget: the provider grid must stay within the `12-ux-principles.md` targets — first WS frame ≤ 500 ms after connect, no layout thrash with 5 providers × 4 windows; virtualisation is unnecessary at this size and is explicitly not added.

### 4.5 API / UI surface
- `GET /fleet/kpis?range=24h|7d|30d` → `FleetKpis`.
- Existing endpoints consumed: `GET /fleet/windows` (M4-01 `?includeForecast=true`), `GET /fleet/availability` (M4-03), `GET /fleet/budgets` (M4-04), `POST /providers/:id/windows/refresh` (M4-01).
- Screen layout (`apps/web/src/screens/fleet/FleetScreen.tsx`):
  1. **KPI strip** — four `KpiTile`s (label, value, target chip when there is one, sparkline-free), a range selector (`24h | 7d | 30d`), and a single *estimate* chip for the strip. A tile with `value: null` reads "Not enough data (n < 5)".
  2. **Provider grid** — one section per provider: the M1-10 row (binary, version, auth/plan, concurrency, health) plus a `WindowCard` per declared window.
  3. **`WindowCard`** — title `5h window`; `MeterBar` with the used segment, the hatched projection segment up to `projectedUtilisationPct`, and the `ReserveMarker` at the reserve floor; under it: `used / limit unit` (or `used unit · limit unknown`), `ConfidenceChip` (official / estimate + source + "updated 12 s ago"), reset `Countdown`, forecast line ("~14 k tokens/h · projected 92 % at reset · est. limit in 2 h 10 m" or "Not enough samples yet"), `CoolingBadge` with its own countdown and confidence when cooling, reserve line when a reserve applies, and *Refresh (official)* when `canRefreshOfficial`.
  4. **`WindowEmptyState`** — "No signal yet" + one line explaining what produces a signal for this provider; no bar, no fabricated numbers (R-W4).
- States per card: `no-signal`, `ok`, `warn`, `high`, `critical`, `cooling`, `reserve-breached`, `stale` (`observedAt` older than `staleAfterMinutes`, default 30 → chip reads "stale"), `refreshing`, `refresh-failed`.
- Accessibility: every bar has an `aria-label` that spells out the numbers and the confidence word ("Codex weekly window, estimate: 62 000 of 100 000 tokens used, projected 92 percent at reset"); level is conveyed by icon + text + fill pattern, never by hue alone; `Countdown` is `aria-live="off"` with a static accessible text alternative to avoid screen-reader spam; all interactive elements reachable by keyboard in DOM order; `prefers-reduced-motion` removes the bar transition and the countdown animation.
- RTL: logical properties throughout; the meter fills from the inline start; countdown and units follow `dir`.

### 4.6 Flow / sequence
```
FleetScreen mount
  ├─ TanStack Query: GET /fleet/windows?includeForecast=true · /fleet/availability · /fleet/budgets · /fleet/kpis?range=24h
  ├─ WS subscribe: topics `quota`, `routing`
  └─ start ONE 1 s countdown ticker (paused on document.hidden)

quota.window_updated   ─▶ patch WindowCardVm.{used,limit,resetAt,windowConfidence,windowSource,observedAt}
quota.forecast_updated ─▶ patch .forecast (level drives shape/pattern + text)
quota.cooling_started  ─▶ set .cooling ─▶ CoolingBadge + countdown ; cooling_ended ─▶ clear
quota.reserve_breached ─▶ patch .reserves[].level ─▶ ReserveMarker + reserve line
routing.rerouted       ─▶ invalidate /fleet/kpis memo key (debounced 5 s)

user clicks Refresh (official)
  └─ POST /providers/:id/windows/refresh ─▶ 202 ─▶ card state `refreshing`
        ├─ quota.window_updated arrives ─▶ chip flips to official, state `ok`
        └─ 422 ProbeNotQuotaFree / 409 ProbeInFlight ─▶ state `refresh-failed` + inline reason
```

## 5. Tasks
- [ ] `packages/ui`: `MeterBar` (used + projected + marker + level pattern), `ConfidenceChip`, `Countdown` (single-ticker friendly, reduced-motion aware) with Storybook-style usage docs and unit tests.
- [ ] `apps/web/src/screens/fleet/`: `WindowCard`, `ForecastBar`, `CoolingBadge`, `ReserveMarker`, `WindowEmptyState` with all ten card states.
- [ ] `KpiStrip` + `KpiTile` + range selector + definition tooltips sourced from a single `KPI_DEFINITIONS` constant shared with the API docs.
- [ ] Fleet screen composition: KPI strip above the M1-10 provider rows; responsive down to phone width (single column, cards stack).
- [ ] WS wiring for `quota` + `routing` topics with optimistic patching; one screen-level countdown ticker paused on `visibilitychange`.
- [ ] `ComputeFleetKpis` use case implementing K1–K4 exactly as defined in §4.1, with `sampleCount` gates and `excludedWindows` notes; 60 s memo + event invalidation.
- [ ] `GET /fleet/kpis` controller + DTO + OpenAPI; index-only migration `m4_07_kpi_indexes`.
- [ ] *Refresh (official)* action: visible only when `canRefreshOfficial`, with `refreshing` / `refresh-failed` states and the `422`/`409` reasons rendered inline.
- [ ] Stale detection (`observedAt` older than `staleAfterMinutes`) and the "stale" chip variant.
- [ ] a11y pass: axe in the Playwright suite, `aria-label` text including the confidence word, keyboard order, focus rings, reduced-motion.
- [ ] RTL pass: screenshot both directions in the E2E suite; verify meter fill direction and countdown placement.
- [ ] Perf check against the `12-ux-principles.md` budgets (first WS frame ≤ 500 ms; no jank with 5 providers × 4 windows).
- [ ] Config `ui.fleet.staleAfterMinutes` (30), `features.quota` gating the whole section.
- [ ] Docs: user-facing "Reading the Fleet screen" page explaining official vs estimate and each KPI definition; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-07-01 | unit (component) | `MeterBar` with `max` undefined / `value > max` / `projected < value` / `marker` beyond `max` | unbounded track with no fill %; clamped fill with an "over limit" pattern; projection never rendered behind used; marker clamped; no `NaN` in any style value |
| UT-M4-07-02 | unit (component) | `ConfidenceChip` for `official` / `estimate` | renders the literal words "official"/"estimate" plus source; text present in the accessible name, not only in a `title` |
| UT-M4-07-03 | unit (component) | `WindowCard` in each of the ten states | correct badge/text per state; `no-signal` renders no bar and no number; `cooling` shows the countdown and its confidence |
| UT-M4-07-04 | unit | `ComputeFleetKpis` K1–K4 on a seeded dataset | values match hand-computed figures; `sampleCount < 5` ⇒ `value: null`; windows without `limit` excluded from K2 with a `note` |
| UT-M4-07-05 | unit | KPI with zero reroutes / zero decisions | K3 `null`, K1 `null`; no division by zero anywhere |
| AT-M4-07-01 | application | KPI memo: 20 requests in 60 s, then a `routing.rerouted` event | one SQL pass for the 20 requests; the event invalidates the memo; recomputation < 150 ms on the 100 k-event fixture DB |
| E2E-M4-07-01 | e2e (Playwright + FakeProvider) | run `burn-to-85.yaml`; watch the Fleet screen | bar and forecast line update live without reload; level text walks `ok → warn → high`; every visible number is accompanied by an official/estimate chip |
| E2E-M4-07-02 | e2e (Playwright + FakeProvider) | trigger `rate-limit-429.yaml` | cooling badge appears within 2 s with a counting-down reset, `official` chip; when the cooling ends the badge disappears without a reload |
| E2E-M4-07-03 | e2e (axe) | axe scan of the Fleet screen in all card states, light and dark, LTR and RTL | zero serious/critical violations; contrast ≥ WCAG 2.1 AA; no state distinguishable by colour alone |
| E2E-M4-07-04 | e2e | keyboard-only walk of the screen | every card, chip, refresh button and KPI tooltip reachable and operable; focus visible; no trap |
| E2E-M4-07-05 | e2e (perf) | connect with 5 providers × 4 windows seeded | first WS frame ≤ 500 ms; no layout shift after hydration; one interval timer active (asserted via the test hook) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-07-01 | Real windows render with provenance | 1. Run two short Claude Code tasks and one Codex task. 2. Open Fleet. | Each provider shows its declared windows with used figures, an *estimate* chip naming the source (`stream-json`, `app-server`) and "updated n s ago". No number appears anywhere without a chip. | ⬜ |
| TC-M4-07-02 | Official refresh (agy, if opted in) | 1. With agy ToS acknowledged, click *Refresh (official)* on an agy window. | Card goes to `refreshing`, then the chip flips to **official** with the vendor `resetAt` and a reset countdown. For Claude/Codex the button is not rendered at all (no quota-free probe). | ⬜ |
| TC-M4-07-03 | Forecast bar and thresholds | 1. Run FakeProvider `burn-to-85.yaml` on `fake-b`. 2. Watch the card. | The projection segment grows ahead of the used segment; the level text walks `ok → warn → high`; "projected NN % at reset" and "est. limit in H:MM" appear; both labelled *estimate*. | ⬜ |
| TC-M4-07-04 | Cooling badge with countdown | 1. Trigger `rate-limit-429.yaml` on `fake-a`. | Badge "Cooling · resets in 29:xx · official" within 2 s, counting down each second; the provider's cards show the cooling state by icon **and** text; when it ends the badge clears live. | ⬜ |
| TC-M4-07-05 | Reserve shading | 1. Set a 20 % review reserve on `fake-b` (M4-04). 2. Burn it into the reserve. | The reserve marker is visible on the bar with its label; when breached the reserve line reads "below review reserve — non-review tasks will not route here"; the marker is present even before the breach. | ⬜ |
| TC-M4-07-06 | KPI strip | 1. After a mix of tasks incl. at least one reroute, read the KPI strip at 24 h and 7 d. | Four tiles with values, sample counts and the G2 targets on K1/K2; hovering each shows its exact definition; K2's note names any window excluded for having no limit; the whole strip carries an *estimate* chip. | ⬜ |
| TC-M4-07-07 | Negative: no signal / not enough data | 1. Start the daemon against a fresh database. 2. Open Fleet. | Every declared window says "No signal yet" with a one-line explanation; **no** bars, percentages or invented limits; KPI tiles read "Not enough data (n < 5)". | ⬜ |
| TC-M4-07-08 | Negative: refresh refused | 1. Click *Refresh (official)* twice quickly on agy. 2. Then clear agy's ToS acknowledgement and try again. | Second click → inline "Refresh already running" (`409`); after clearing ToS the button is hidden or the call returns a clear refusal — no agy process is launched (C11). | ⬜ |
| TC-M4-07-09 | Stale data | 1. Stop all agents and wait past `ui.fleet.staleAfterMinutes`. | The chip reads "stale" with the `observedAt` time; the number is still shown but explicitly aged; the forecast line says the burn rate has decayed. | ⬜ |
| TC-M4-07-10 | RTL + reduced motion + keyboard | 1. Switch the UI to Arabic (RTL). 2. Enable "Reduce motion" in macOS. 3. Navigate the screen with Tab/Shift-Tab only. | Meters fill from the inline start, countdowns and units mirrored correctly, no clipped text; bar transitions and countdown animation are disabled; every control is reachable, operable and has a visible focus ring. | ⬜ |
| TC-M4-07-11 | Restart while cooling | 1. With `fake-a` cooling, `kill -9` the daemon and restart; reload the browser. | The card immediately shows the same cooling countdown and the same window figures; KPIs are unchanged (computed from persisted rows, not from memory). | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Every number rendered on the Fleet screen is accompanied by an official/estimate chip and its source; a window with no signal renders no number and no bar (TC-M4-07-01, TC-M4-07-07).
- [ ] Windows, forecasts, cooling badges and reserve markers update live over WS with no page reload, within 2 s of the underlying event.
- [ ] The four KPIs (K1–K4) match their §4.1 definitions, report `sampleCount`, honour the `< 5` gate, and are recomputed from persisted rows after a restart (TC-M4-07-11).
- [ ] *Refresh (official)* appears only for adapters with a quota-free probe, respects the agy ToS gate (C11), and renders `409`/`422` reasons inline.
- [ ] axe reports zero serious/critical violations in light and dark, LTR and RTL, across all card states; no state is distinguishable by colour alone; `prefers-reduced-motion` is honoured.
- [ ] The screen meets the `12-ux-principles.md` budgets: first WS frame ≤ 500 ms, no layout shift after hydration, exactly one interval timer, paused when the tab is hidden.
- [ ] The screen works at phone width (single column) without horizontal scrolling — the PWA polish itself is M7-03.
- [ ] All TC-M4-07-01…11 pass and are recorded with build hash, date and screenshots in `plan/05-m4-quota-resilience/evidence/`.
- [ ] No new ESLint / dependency-cruiser violations; `apps/web` still imports only `packages/ui` and `packages/sdk` types.
- [ ] "Reading the Fleet screen" docs page written; `PROGRESS.md` row updated.

## 8. Risks / open questions
- **K2 (window utilisation) is only meaningful where a `limit` is known.** For providers that never report one (likely Claude — verify against Claude Code docs at step start) the tile silently narrows to the providers that do, which can flatter the number. The `note` naming excluded windows is mandatory, not optional.
- K1 depends on `costTier` in the model catalog (M2-02) being accurate; a mis-tiered model moves the headline G2 number. Link the tooltip to the Models screen so the definition is auditable.
- Showing a projected bar next to a measured bar invites the reader to treat both as facts. Mitigations: different fill pattern for the projection, the word "projected" in the label, and the chip. If usability testing shows confusion, drop the projection segment before weakening the labelling.
- Countdowns imply precision about vendor resets that may be rolling rather than fixed (verify against each vendor's docs at step start, as in M4-01/M4-02). An estimated cooling countdown must always carry the *estimate* chip — an official-looking countdown on a guessed reset is the worst failure mode of this screen.
- Dense dark-first UI plus four status dimensions (level, confidence, cooling, reserve) risks WCAG contrast failures and colour-only encoding; the axe scan across all states (E2E-M4-07-03) is the gate, and shape/pattern/text carry the meaning.
- KPI SQL over 30 days on a large event table could get slow as history grows (M5 adds recordings and FTS). The two indexes plus the 60 s memo are the M4 answer; revisit with a materialised daily rollup in M9-08 if the benchmark regresses.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
