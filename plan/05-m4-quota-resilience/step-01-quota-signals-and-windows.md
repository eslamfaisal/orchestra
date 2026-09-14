# Step M4-01 — Quota signals & windows

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M1-08, M2-03 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/sdk`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, `apps/daemon` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step the daemon maintains, for every enabled provider, one `WindowState` per `(account, limit bucket, window kind)` the provider actually reports, built exclusively from official in-band signals — and it keeps **two measurement kinds strictly apart**:

- **`QuotaObservation`** — what the vendor itself reported (`unit: percent | credits | requests | tokens`, with `used`, optional `limit` / `remaining` / `resetAt`, an `accountId` when reported, a `bucketId` naming the limit bucket or model family, and a `source`). Codex app-server `account/rateLimits/read` / `account/rateLimits/updated`, rate-limit messages (429 with `resetAt`), and — only if the agy adapter is enabled — a `/usage` probe.
- **`TokenConsumption`** — our own samples, **tokens only**, per session and model, from Claude Code stream-json / session JSONL usage fields and Codex `turn.completed` usage.

The two are **never added together**. A token sample is folded into `used` only when the observation it sits on top of is itself in tokens; otherwise it is reported alongside as `consumedTokens` and the vendor figure stays untouched. States are persisted in `provider_windows`, every change is published as `quota.window_updated`, and every number carries `confidence: official | estimate | unknown` and its `source`. The user can call `GET /providers/:id/windows`, trigger a quota-free refresh (where a documented quota-free probe exists), and watch the `quota` WS topic. The Fleet visualisation comes in M4-07.

## 2. Why
- G4 (read here as *reduce avoidable interruptions; pause clearly when no eligible capacity exists*) and G2 (≥ 80 % of each paid window used productively) both need a trustworthy per-bucket ledger; this step is the data source for M4-02…M4-07, M6-02 and M8-06.
- D4 (structured state from official channels only) and D5 (provider = plugin): parsing lives in each `packages/providers/<id>`; core sees only `WindowState`, `QuotaObservation`, `TokenConsumption`, `RateLimitSignal`.
- C2 (no vendor API calls), C3 (no credential stores), C7 (no screen-scraping: PTY bytes are never parsed for usage), C8 (probes use documented flags only), C11 (agy work only when the adapter is enabled, i.e. after the ADR-008 terms resolution *and* its M0-09 evidence row).
- UX principle 4 "truth labelling": confidence, unit, account and bucket are domain fields, not UI decoration. A number in one unit is never converted into another to make a bar look complete.
- Risk R6 (agy numerics undocumented) and R18 (provider capability assumptions unproven until M0-09) are contained by capability states (`verified | limited | manual-only | unsupported | unverified`) per provider + CLI version + execution mode: an `unverified` signal source is not consumed as `official`.

## 3. Scope
### In scope
- Core value objects `WindowState`, `QuotaObservation`, `TokenConsumption`, `RateLimitSignal`, `WindowKind`, `Confidence`, `UsageUnit`, `ResetSemantics`, `QuotaSource`, `BucketId` and the pure `WindowLedger` domain service (fold observations / token samples / signals into a per-`(account, bucket, kind)` state; rollover only where reset semantics are documented).
- SDK: `NormalizedEvent` gains kinds `usage` (token consumption) and `quota_observation` (vendor-reported); `QuotaProbe` and `RateLimitParser` get a contract spec (`quota.contract.spec.ts`) and FakeProvider support.
- Adapter work: Claude (`TokenConsumption` from stream-json `result` and session JSONL; rate-limit from exit/stream fixtures and the `Notification` hook `quota_auto_resume_*` matchers), Codex (`QuotaObservation` from the app-server account rate-limit surfaces `account/rateLimits/read` and `account/rateLimits/updated`, which report **multiple buckets** — https://developers.openai.com/codex/app-server/, documented (vendor docs, 2026-09), *verify against Codex docs and the pinned app-server schema at step start*; `TokenConsumption` from `turn.completed` usage; 429 from app-server errors and `exec --json` error lines).
- agy **only if the adapter is enabled** (ADR-008 amended: written terms resolution in `DECISIONS.md` **and** an M0-09 evidence-matrix row): a `QuotaProbe` wrapper over `agy -p "/usage"` / `/credits`, shipped behind `providers.agy.enabled` and recorded in the evidence matrix as capability state `unverified` until a real-CLI check shows the command yields structured output rather than an interactive panel (https://www.antigravity.google/docs/cli/commands/usage/). No acceptance criterion, test gate or exit criterion in this milestone depends on it.
- Daemon: `IngestTokenConsumption`, `IngestQuotaObservation`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows` use cases; `QuotaProbeScheduler`; migration for `provider_windows` columns (account + bucket + reset semantics), the new `quota_observations` table and the new `usage_samples` (`TokenConsumption`) table; events `quota.window_updated`, `quota.observed`, `quota.rate_limited`; HTTP + WS surface.
- Dev-only fixture replay script (`fixtures:replay`) behind `features.devTools`.
### Out of scope (deferred to …)
- Burn rate, time-to-limit, thresholds → M4-02.
- Cooling state, retries, rerouting on a signal → M4-03 (this step only records the signal and updates the window).
- Reserves and budgets → M4-04. Fleet UI → M4-07.
- Kimi / OpenCode quota parsers → M10-04 / M10-05. Cloud-session usage → M7-07.
- Drift handling when a usage payload stops parsing → M6-02 (this step only counts `ParseError`s).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/quota/{window-state.ts, quota-observation.ts, token-consumption.ts, rate-limit-signal.ts, window-ledger.ts}`.

Rules (100 % branch-covered in `window-ledger.spec.ts`):
- **R-W1 Two measurement kinds, never summed.** A `QuotaObservation` is vendor-reported and carries its own `unit`; a `TokenConsumption` is our own sample and is always in tokens. The ledger adds a token sample into `used` **only** when the governing observation's `unit === 'tokens'`. For `percent`, `credits` or `requests` windows, `used` stays exactly as the vendor reported it and the samples are surfaced separately as `consumedTokens` with `consumedTokensAreComparable: false`. No conversion factor is ever invented (that would need a documented vendor conversion; none is assumed).
- **R-W2 Official supersedes, estimates accumulate within one unit.** An observation replaces the state for `(provider, accountId, bucketId, kind)`; `confidence = 'official'` only while the state is exactly what the vendor reported. Adding token samples on top (tokens-unit windows only) degrades it to `estimate` until the next observation.
- **R-W3 Rollover only on documented reset semantics.** Each declared window carries `resetSemantics: 'fixed-period' | 'rolling' | 'unknown'` from `manifest.limits.windows[]` (M2-03; a missing value reads as `unknown`). When `now ≥ resetAt`:
  - `fixed-period` ⇒ `used = 0`, `windowStartedAt = resetAt`, `resetAt = resetAt + period(kind)`, `confidence = 'estimate'`;
  - `rolling` ⇒ no fresh allowance is inferred; the state keeps the last observation and is marked `stale: true` until the next observation;
  - `unknown` ⇒ `used = undefined`, `confidence = 'unknown'`, `stale: true`. **A fresh allowance is never inferred from an elapsed `resetAt` alone.** Downstream (M4-02) treats `confidence: 'unknown'` exactly like "no window signal": level `unknown`, no pre-emptive routing change.
- **R-W4 Never fabricate.** No `limit`, `remaining` or post-reset `used` is ever guessed; a declared window with no signal has no row (API returns `state: null`, "no signal yet").
- **R-W5 Pure.** `WindowLedger.apply(prev: WindowState | null, input: LedgerInput, now): WindowState` is deterministic; time and ids come from `Clock`/`IdGenerator` ports.
- **R-W6 Model attribution.** `TokenConsumption.modelId` is recorded when the payload carries it; otherwise the session's current model (after `session.model_switched`) is used.
- **R-W7 Account and bucket identity.** Every observation, sample and state is keyed by `(providerId, accountId ?? 'default', bucketId ?? 'default', kind)`. A provider that reports several limit buckets (Codex `account/rateLimits/*`) produces one state per bucket; buckets are never merged, summed or averaged into a single "provider window", and the UI names the bucket. `'default'` is used only when the provider reports no identity, and it is recorded as such — not asserted to be the user's only account.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/quota/window-state.ts
export type WindowKind = '5h' | 'weekly' | 'daily' | 'tokens';
export type Confidence = 'official' | 'estimate' | 'unknown';
export type UsageUnit = 'tokens' | 'percent' | 'requests' | 'credits';
export type ResetSemantics = 'fixed-period' | 'rolling' | 'unknown';
export type QuotaSource = 'stream-json' | 'session-log' | 'app-server' | 'hook' | 'probe' | 'exit' | 'fake';
export type BucketId = string;        // the vendor's limit-bucket / model-family id; 'default' when it reports none
export type AccountId = string;       // the vendor's account/org id when reported; 'default' otherwise

/** Vendor-reported measurement, stored verbatim. Never derived from our own counting. */
export interface QuotaObservation {
  id: string; providerId: ProviderId; accountId: AccountId; bucketId: BucketId; kind: WindowKind;
  unit: UsageUnit;                                              // as reported; never converted
  used?: number; limit?: number; remaining?: number;
  resetAt?: string; resetSemantics: ResetSemantics;
  source: QuotaSource; observedAt: string; externalId?: string; // idempotency key with source
  raw?: Record<string, unknown>;                                // redacted payload excerpt for audit
}

/** Our own sample of what a session spent. Tokens only. Never added to an observation in another unit (R-W1). */
export interface TokenConsumption {
  id: string; providerId: ProviderId; accountId: AccountId; bucketId: BucketId;
  sessionId: string; modelId?: ModelId; ts: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  source: QuotaSource; externalId?: string;                     // idempotency key with source
}
/** @deprecated name kept for one milestone so the M4-02 / M4-06 contracts compile unchanged. */
export type UsageSample = TokenConsumption;

export interface WindowState {
  providerId: ProviderId; accountId: AccountId; bucketId: BucketId; kind: WindowKind;
  unit: UsageUnit;                                              // unit of used/limit/remaining
  used?: number;                                                // undefined ⇒ unknown (R-W3/R-W4), never 0-by-assumption
  limit?: number; remaining?: number;
  resetAt?: string; resetSemantics: ResetSemantics; windowStartedAt?: string;   // ISO-8601 UTC
  observed?: { used?: number; limit?: number; remaining?: number; unit: UsageUnit; observedAt: string; source: QuotaSource };
  consumedTokens: number;                                       // Σ TokenConsumption since `observed.observedAt`
  consumedTokensAreComparable: boolean;                         // false ⇒ unit ≠ tokens ⇒ not folded into `used`
  stale: boolean;                                               // resetAt elapsed without documented semantics (R-W3)
  confidence: Confidence; source: QuotaSource; observedAt: string;
}
export interface RateLimitSignal {                              // extends 05 §1 shape
  providerId: ProviderId; accountId?: AccountId; bucketId?: BucketId; sessionId?: string; windowKind?: WindowKind;
  resetAt?: string; retryAfterMs?: number; confidence: Confidence; source: QuotaSource;
  observedAt: string; raw?: { code?: string; message?: string };
}
export type LedgerInput =
  | { kind: 'consumption'; sample: TokenConsumption }
  | { kind: 'observation'; observation: QuotaObservation }       // probe result, app-server rateLimits, vendor payload
  | { kind: 'signal'; signal: RateLimitSignal };

// packages/sdk/src/telemetry.ts (addition)
export type UsageEvent = { kind: 'usage'; sessionId: string; ts: string; modelId?: ModelId; externalId?: string;
  accountId?: AccountId; bucketId?: BucketId;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } };
export type QuotaObservationEvent = { kind: 'quota_observation'; sessionId?: string; ts: string; externalId?: string;
  observations: Array<Omit<QuotaObservation, 'id' | 'providerId' | 'observedAt'>> };   // one entry per reported bucket

// apps/daemon/src/application/ports/quota.ports.ts
export interface ProviderWindowRepository {
  upsert(state: WindowState): Promise<Result<void, StorageError>>;                 // keyed by provider+account+bucket+kind
  list(q?: { providerId?: ProviderId; accountId?: AccountId; bucketId?: BucketId }): Promise<Result<WindowState[], StorageError>>;
}
export interface QuotaObservationRepository {
  append(o: QuotaObservation): Promise<Result<'inserted' | 'duplicate', StorageError>>;
  latest(providerId: ProviderId, accountId: AccountId, bucketId: BucketId, kind: WindowKind): Promise<Result<QuotaObservation | null, StorageError>>;
}
export interface TokenConsumptionRepository {                                      // was UsageSampleRepository
  append(s: TokenConsumption): Promise<Result<'inserted' | 'duplicate', StorageError>>;
  since(providerId: ProviderId, fromTs: string, scope?: { accountId?: AccountId; bucketId?: BucketId }): Promise<Result<TokenConsumption[], StorageError>>;
}
export interface QuotaProbeRegistry { get(providerId: ProviderId): QuotaProbe | undefined; }   // DI map, no switch
```
Use cases (one class each, `apps/daemon/src/application/quota/`): `IngestTokenConsumption`, `IngestQuotaObservation`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows`. All return `Result<_, QuotaError>` with `QuotaError = ProviderNotEnabled | ProbeNotQuotaFree | ProbeFailed | ProbeUnverified | StorageError`.

### 4.3 Data / schema changes
Migration `apps/daemon/src/infrastructure/persistence/migrations/<next>-m4-01-quota-windows.ts` (additive; shipped migrations untouched):
- `provider_windows` (04-domain-model.md §4) + `account_id TEXT NOT NULL DEFAULT 'default'`, `bucket_id TEXT NOT NULL DEFAULT 'default'`, `unit TEXT NOT NULL DEFAULT 'tokens'`, `used REAL NULL` (nullable — `NULL` means unknown, R-W3/R-W4), `remaining REAL NULL`, `reset_semantics TEXT NOT NULL DEFAULT 'unknown'`, `observed_json TEXT NULL`, `consumed_tokens INTEGER NOT NULL DEFAULT 0`, `consumed_tokens_comparable INTEGER NOT NULL DEFAULT 1`, `stale INTEGER NOT NULL DEFAULT 0`, `source TEXT NOT NULL DEFAULT 'estimate'`, `observed_at TEXT`, `window_started_at TEXT`; unique index **`(provider_row_id, account_id, bucket_id, kind)`** (replaces the `(provider_row_id, kind)` uniqueness — a provider with several account or limit buckets gets one row each).
- New `quota_observations`: `id, provider_row_id, account_id, bucket_id, kind, unit, used, limit, remaining, reset_at, reset_semantics, source, observed_at, external_id, raw_json`; unique `(source, external_id)` where `external_id IS NOT NULL`; index `(provider_row_id, account_id, bucket_id, kind, observed_at)`. Append-only; `raw_json` is a redacted excerpt for audit and drift diagnosis (M6-02).
- New `usage_samples` (rows of `TokenConsumption`, tokens only): `id, provider_row_id, account_id, bucket_id, session_id, model_id, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, source, external_id`; unique `(source, external_id)` where `external_id IS NOT NULL`; index `(provider_row_id, ts)`. Retention 30 days (daily purge job; folded into M5-06 TTL later).
- Events: `quota.window_updated` payload = `WindowState`; `quota.observed` payload = `QuotaObservation`; `quota.rate_limited` payload = `RateLimitSignal`; all Zod-validated on write.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Claude** (`packages/providers/claude/src/quota/`): `TelemetryParser` emits `TokenConsumption` from stream-json `result` messages (headless) and from session JSONL usage fields (interactive, source `session-log`; file path from the manifest `paths`, never from credential dirs). `RateLimitParser` recognises the recorded 429 exit fixture, stream error lines and the `Notification` hook with `quota_auto_resume_*` matchers (exact field names: verify against Claude Code docs at step start, M0-09 row). Windows: `5h`, `weekly` (05 §3), bucket `default` unless a payload names one. No scheduled probe: `/usage` is an interactive slash command; whether its result reaches hooks/stream-json is to be verified against Claude Code docs at step start — if it is PTY text only it is **not** parsed (C7) and Claude's windows stay token-estimates with no `limit`.
- **Codex** (`packages/providers/codex/src/quota/`): `QuotaObservation[]` from the documented app-server account rate-limit surfaces — the `account/rateLimits/read` request and the `account/rateLimits/updated` notification, which report **several limit buckets** (https://developers.openai.com/codex/app-server/, documented (vendor docs, 2026-09) — *verify method names, bucket identity, units and reset semantics against Codex docs and the pinned `generate-json-schema` fixture at step start*). Each reported bucket becomes its own `(accountId, bucketId, kind)` state; the units and `resetSemantics` come from the payload and the manifest, never from an assumption. `TokenConsumption` from `turn.completed` usage. Rate-limit from app-server error responses and `exec --json` error lines. `account/rateLimits/read` is registered as a scheduled probe **only** if the M0-09 evidence row records it as quota-free on a real CLI; until then it is consumed opportunistically from the notification stream only. App-server transport surfaces carry experimental caveats (R3, ADR-009), so the capability is keyed by CLI version + execution mode.
- **agy** (`packages/providers/agy/src/quota/`) — **only if the adapter is enabled**: `QuotaProbe.probe` runs `agy -p "/usage"` / `/credits` via the launcher's headless argv builder and Zod-parses the output into `QuotaObservation[]`. The cited command documentation describes an **interactive panel**, not a structured, quota-free probe (https://www.antigravity.google/docs/cli/commands/usage/), so this path ships as capability state `unverified`: `isQuotaFree` is `false` and the scheduler never runs it until an M0-09 evidence row records a real-CLI check; a manual refresh returns `422 ProbeUnverified` with that reason. The adapter itself is gated by ADR-008 (amended): a written terms resolution in `DECISIONS.md` **and** an evidence-matrix row, not merely `tos_acknowledged_at` (C11, R17). Nothing in M4 depends on it.
- **FakeProvider** (`packages/sdk/src/fake/`): scenario steps `emit-usage {input, output, model?, bucket?}`, `emit-quota-observation {account?, bucket, kind, unit, used, limit?, remaining?, resetAt?, resetSemantics}`, `emit-rate-limit {windowKind, resetAt | retryAfterMs}`, probe result `observations: [...]`. New scenarios `usage-steady.yaml`, `rate-limit-429.yaml`, `probe-official.yaml`, `multi-bucket-percent.yaml` (two buckets, one in `percent` with `resetSemantics: unknown`, so the non-summation and no-rollover rules are exercised end to end).
- **Scheduler** (`apps/daemon/src/infrastructure/quota/quota-probe.scheduler.ts`): boot + 30 s, every 15 min ± 2 min jitter, after each `quota.rate_limited`, on manual refresh; ≥ 5 min between automatic probes per provider; one in-flight probe per provider; probes run through the daemon's allowlisted `ProcessRunner` with the env allowlist (09-engineering-standards), never inside tmux. A probe is scheduled only when the provider's evidence-matrix capability state for `quotaProbe` is `verified` or `limited`; `unverified`, `manual-only` and `unsupported` are skipped with the state as the log reason.
- **Fixture replay** (`tools/scripts/fixtures-replay.ts`, `pnpm --filter @orchestra/daemon fixtures:replay <provider> <fixture> --session <id>`): posts a recorded fixture into the telemetry pipeline of a running session; refused unless `features.devTools` and bound to 127.0.0.1.

### 4.5 API / UI surface
- `GET /providers/:id/windows` → `{ declared: Array<{ kind: WindowKind; resetSemantics: ResetSemantics }>, windows: Array<{ accountId, bucketId, kind, state: WindowState | null }> }` — one entry per reported bucket, each carrying its own `unit`, `confidence` and (when `unit ≠ 'tokens'`) `consumedTokens` reported separately.
- `POST /providers/:id/windows/refresh` (`Idempotency-Key`) → `202 { probeId }`; `422 ProbeNotQuotaFree` when the adapter has no quota-free probe; `422 ProbeUnverified` when the probe exists but its evidence-matrix state is `unverified` (body names the missing M0-09 row); `409 ProbeInFlight`.
- `GET /providers/:id/usage?from=&to=&bucket=` → `TokenConsumption[]` (paginated). `GET /providers/:id/observations?from=&to=&bucket=` → `QuotaObservation[]`.
- WS `/ws` topic `quota`: `quota.window_updated`, `quota.observed`, `quota.rate_limited`.
- No UI change (M4-07); audit rows for manual refresh via the audit interceptor.

### 4.6 Flow / sequence
```
claude pane ─stream-json result─▶ hooks/stream receiver ─▶ TelemetryParser(claude).parse ─▶ NormalizedEvent{usage}
   ─▶ IngestTokenConsumption: append (idempotent by source+externalId) ─▶ WindowLedger.apply(prev, {consumption})
       └─ unit === 'tokens' ? used += tokens (confidence→estimate) : consumedTokens += tokens, used untouched   (R-W1)
   ─▶ ProviderWindowRepository.upsert ─▶ emit quota.window_updated ─▶ /ws topic quota
codex app-server ─account/rateLimits/updated (n buckets)─▶ parse ─▶ QuotaObservation[] (one per bucket)
   ─▶ IngestQuotaObservation ─▶ per (account, bucket, kind): ledger.apply(prev, {observation}) ─▶ upsert + quota.observed
codex app-server ─429 error─▶ RateLimitParser(codex).parse ─▶ RateLimitSignal ─▶ ApplyRateLimitSignal:
   emit quota.rate_limited; ledger.apply(prev, signal) sets resetAt/confidence official ─▶ upsert + event
resetAt elapsed ─▶ ledger.apply(prev, now): fixed-period ⇒ used = 0 · rolling ⇒ keep + stale · unknown ⇒ used = ⌀,
   confidence = 'unknown', stale = true                                                                        (R-W3)
agy (only if enabled) ─(manual refresh)─▶ RunQuotaProbe ─▶ 422 ProbeUnverified until an M0-09 evidence row exists
```

### 4.7 Review reconciliation contract (2026-09-15)
Even when both observations use tokens, add a sample only when account/bucket scope, counting semantics, coverage cursor and time interval prove it is not already included. Otherwise retain it separately and leave the official snapshot unchanged. Anonymous account identities use a local credential-context generation; a login change invalidates observations instead of merging identities. Rate-limit reset time is optional; absence does not invalidate a genuine limit signal.

## 5. Tasks
- [ ] Confirm the M0-09 evidence-matrix rows this step consumes (Claude usage channel, Codex `account/rateLimits/*`, any agy probe) and record the capability state per provider + CLI version + execution mode before writing parser code.
- [ ] Record missing fixtures on real CLIs: Claude stream-json completion with usage, session JSONL excerpt, 429 exit; Codex `account/rateLimits/read` response and `account/rateLimits/updated` notification with **more than one bucket**, `turn.completed`, 429; agy `/usage` and `/credits` output only if the adapter is enabled (redacted, `RECORDED.md` updated).
- [ ] `packages/core/src/quota/`: `QuotaObservation`, `TokenConsumption`, `WindowState` + `WindowLedger` with rules R-W1…R-W7; unit tests at 100 % branch.
- [ ] `packages/sdk`: `usage` and `quota_observation` `NormalizedEvent` kinds; Zod schemas for `WindowState`, `QuotaObservation`, `TokenConsumption`, `RateLimitSignal`; `quota.contract.spec.ts` (probe never returns secret-shaped fields, `isQuotaFree` honoured, capability state honoured, 429 fixtures yield `resetAt` or `retryAfterMs`, observations always carry a `unit` and a `bucketId`).
- [ ] FakeProvider: `emit-usage`, `emit-quota-observation`, `emit-rate-limit`, scripted probe; four scenarios incl. `multi-bucket-percent.yaml`.
- [ ] Claude adapter: token consumption from stream-json + session JSONL; rate-limit parser incl. `Notification` `quota_auto_resume_*`; fixtures pinned.
- [ ] Codex adapter: observations from `account/rateLimits/read` + `account/rateLimits/updated` (one per bucket, units and reset semantics from the payload/manifest); token consumption from `turn.completed`; rate-limit parser for app-server + `exec --json`; schema fixture check.
- [ ] agy adapter (skip entirely unless the adapter is enabled): `QuotaProbe` (`-p "/usage"`, `/credits`), Zod output schema, `unverified` capability gate, ADR-008 enablement gate.
- [ ] Migration + Kysely repositories (`ProviderWindowRepository`, `QuotaObservationRepository`, `TokenConsumptionRepository`) + in-memory doubles; the new `(provider, account, bucket, kind)` unique index.
- [ ] Use cases `IngestTokenConsumption`, `IngestQuotaObservation`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows`; wire to telemetry pipeline via event bus.
- [ ] `QuotaProbeScheduler` with jitter, min interval, in-flight guard, `features.quota` flag.
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS topic `quota`; audit on refresh.
- [ ] `fixtures:replay` dev script behind `features.devTools`.
- [ ] Daily purge of `usage_samples` older than 30 d.
- [ ] Docs: `packages/providers/*/README.md` "Quota signals" section (measurement kind, unit, bucket identity, reset semantics, capability state per CLI version + mode); update `05-provider-contract.md` fixture list only if new fixture kinds were added (ADR not needed); add the observed `resetSemantics` per bucket to the provider's row in `docs/providers/evidence-matrix.md` (M0-09).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-01-01 | unit | `WindowLedger` official probe then two samples | `used = official + Σ`, confidence flips to `estimate`, source of last input |
| UT-M4-01-02 | unit | rollover at `resetAt` for each kind | `used = 0`, next `resetAt` = +period, `tokens` kind keeps `resetAt` undefined |
| UT-M4-01-03 | unit (property, fast-check) | random sequences of samples/probes/signals | never throws, `used ≥ 0`, `limit` never set unless input carried it |
| CT-M4-01-01 | contract | every 429 fixture of claude/codex/agy/fake through `RateLimitParser` | signal with `resetAt` or `retryAfterMs`; `confidence` set |
| CT-M4-01-02 | contract | `QuotaProbe.probe` results for agy/fake | Zod-valid `WindowState[]`; no field matching `/token\|secret\|key\|cookie\|authorization/i` |
| AT-M4-01-01 | application | `IngestUsageSample` twice with same `(source, externalId)` | second returns `duplicate`; one `quota.window_updated` |
| AT-M4-01-02 | application | scheduler with fake clock: boot, 15 min ticks, signal, manual refresh | ≤ 1 probe per 5 min per provider except manual; no probe for non-quota-free adapter |
| IT-M4-01-01 | integration | migration on a DB with pre-M4 `provider_windows` rows | columns added with defaults; unique index created; existing rows readable |
| E2E-M4-01-01 | e2e (Playwright, FakeProvider) | run `usage-steady.yaml`, poll `GET /providers/fake/windows` | window `used` grows monotonically; `confidence: estimate`; `source: fake` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-01-01 | Claude headless usage → window | 1. Quick Delegate a `quick` task to Claude Code headless in `~/orchestra-scratch/`. 2. Wait for completion. 3. `GET /providers/claude/windows`. | `5h` and `weekly` entries exist with `used > 0`, `unit: tokens`, `confidence: estimate`, `source: stream-json`, `observedAt` within the last minute. | ⬜ |
| TC-M4-01-02 | Claude interactive usage from session JSONL | 1. Start an interactive Claude session from Fleet. 2. Send one short prompt in the terminal. 3. Watch WS topic `quota`. | A `quota.window_updated` arrives with `source: session-log`; `used` increased by the JSONL usage figures; no PTY-derived data (verify `source` ≠ anything else). | ⬜ |
| TC-M4-01-03 | Codex app-server usage | 1. Start a Codex session (app-server transport). 2. Complete one turn. 3. `GET /providers/codex/usage`. | One `UsageSample` per turn with `source: app-server` and an `externalId`; window updated; `confidence: estimate` unless the notification carried an official figure. | ⬜ |
| TC-M4-01-04 | agy official probe (only if opted in) | 1. Ensure ToS acknowledged. 2. `POST /providers/agy/windows/refresh`. 3. Read the window. | `202`; within 10 s window(s) with `confidence: official`, `source: probe`, `resetAt` set if reported; audit row for the refresh. | ⬜ |
| TC-M4-01-05 | Negative: refresh on a provider without a quota-free probe | 1. `POST /providers/claude/windows/refresh`. | `422 ProbeNotQuotaFree`; no child process spawned (check daemon log); no window change. | ⬜ |
| TC-M4-01-06 | Negative: agy probe blocked without ToS | 1. Clear `tos_acknowledged_at` for agy. 2. Wait for the scheduler tick or trigger refresh. | Probe skipped with log reason `tos_not_acknowledged`; no `agy` process launched. | ⬜ |
| TC-M4-01-07 | Replayed 429 fixture | 1. Start FakeProvider session or real Claude session. 2. `fixtures:replay claude exit/429.txt --session <id>`. | `quota.rate_limited` event with `resetAt` from the fixture; window `resetAt` updated, `confidence: official`, `source: exit`. | ⬜ |
| TC-M4-01-08 | Restart resilience | 1. After TC-01 and TC-07, `kill -9` the daemon. 2. Restart. 3. `GET /providers/*/windows`. | Identical states (same `used`, `resetAt`, `confidence`); scheduler resumes; no duplicate `quota.window_updated` for old samples (idempotent replay of backlog). | ⬜ |

### 6.3 Review regression scenarios
- [ ] Token usage already included in a fresh official observation is not double-counted.
- [ ] Login/account context switch never inherits an old allowance.
- [ ] Rate-limit signal without resetAt pauses according to policy and stays unknown.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] For claude, codex, fake (and agy when opted in) every manifest-declared window has a `WindowState` after one session or one probe, with `confidence` and `source` populated.
- [ ] `WindowLedger` 100 % branch coverage; property test UT-M4-01-03 green with ≥ 1 000 runs.
- [ ] `quota.contract.spec.ts` passes for all adapters against pinned fixtures; contract asserts no secret-shaped fields.
- [ ] No adapter reads PTY bytes for usage (ESLint `no-pty-regex` green); no new egress (`no-vendor-endpoints` green).
- [ ] Automatic probes run only for `isQuotaFree` adapters, at most once per 5 min per provider, and never for agy without ToS acknowledgement.
- [ ] Ingestion is idempotent by `(source, externalId)`; restart replays produce no duplicate samples.
- [ ] All TC-M4-01-01…08 pass and are recorded with build hash and date.
- [ ] No new lint / dependency-cruiser / architecture violations; `packages/core` still imports nothing.
- [ ] `PROGRESS.md` row updated; provider READMEs document quota signals.

## 8. Risks / open questions
- Claude session JSONL location and usage field names (verify against Claude Code docs at step start); if the file moves between versions, M6-02 must treat it as drift.
- Whether Claude `/usage` output is available via any structured channel (verify against Claude Code docs at step start). Default assumption: no → Claude stays `estimate` for `used`, `official` only for `resetAt` from rate-limit messages.
- Codex app-server usage notification names and whether they include window-level figures (verify against Codex docs / pinned schema at step start); app-server is experimental (R3, ADR-009).
- agy `/usage` JSON shape and which window kinds it reports (verify against Antigravity docs at step start); credits vs tokens unit mapping.
- Rollover rule R-W3 assumes fixed periods; vendors may use rolling windows. Estimates after rollover are conservative (`used = 0` labelled estimate) — M4-02 treats them as low-confidence.
- Fixture recording of a real 429 cannot be forced (C5); if none exists at step start, the contract test runs on a hand-built fixture marked `synthetic: true` in `RECORDED.md` until a real one is captured.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
