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
After this step the daemon maintains, for every enabled provider, one `WindowState` per manifest-declared quota window (`5h`, `weekly`, `daily`, `tokens`), built exclusively from official in-band signals: Claude Code usage in stream-json and session JSONL, Codex app-server usage notifications and `turn.completed` usage, `agy -p "/usage"` / `/credits`, plus vendor rate-limit messages (429 with `resetAt`). States are persisted in `provider_windows`, every change is published as `quota.window_updated`, and every number carries `confidence: official | estimate` and its `source`. The user can call `GET /providers/:id/windows`, trigger a quota-free refresh, and watch the `quota` WS topic. The Fleet visualisation comes in M4-07.

## 2. Why
- G4 (never blocked) and G2 (≥ 80 % of each paid window used productively) both need a trustworthy per-window ledger; this step is the data source for M4-02…M4-07, M6-02 and M8-06.
- D4 (structured state from official channels only) and D5 (provider = plugin): parsing lives in each `packages/providers/<id>`; core sees only `WindowState`, `UsageSample`, `RateLimitSignal`.
- C2 (no vendor API calls), C3 (no credential stores), C7 (no screen-scraping: PTY bytes are never parsed for usage), C8 (probes use documented flags only), C11 (agy probe only after ToS acknowledgement).
- UX principle 4 "truth labelling": confidence and source are domain fields, not UI decoration.
- Risk R6 (agy numerics undocumented) is contained by labelling everything unverified as `estimate`.

## 3. Scope
### In scope
- Core value objects `WindowState`, `UsageSample`, `RateLimitSignal`, `WindowKind`, `Confidence`, `UsageUnit`, `QuotaSource` and the pure `WindowLedger` domain service (fold samples / probes / signals into a state; window rollover).
- SDK: `NormalizedEvent` gains kind `usage`; `QuotaProbe` and `RateLimitParser` get a contract spec (`quota.contract.spec.ts`) and FakeProvider support.
- Adapter work: Claude (`usage` from stream-json `result` and session JSONL; rate-limit from exit/stream fixtures and the `Notification` hook `quota_auto_resume_*` matchers), Codex (app-server usage notifications + `turn.completed` usage; 429 from app-server errors and `exec --json` error lines), agy (`QuotaProbe` running `agy -p "/usage"`, `/credits`).
- Daemon: `IngestUsageSample`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows` use cases; `QuotaProbeScheduler`; migration for `provider_windows` columns and new `usage_samples` table; events `quota.window_updated`, `quota.rate_limited`; HTTP + WS surface.
- Dev-only fixture replay script (`fixtures:replay`) behind `features.devTools`.
### Out of scope (deferred to …)
- Burn rate, time-to-limit, thresholds → M4-02.
- Cooling state, retries, rerouting on a signal → M4-03 (this step only records the signal and updates the window).
- Reserves and budgets → M4-04. Fleet UI → M4-07.
- Kimi / OpenCode quota parsers → M10-04 / M10-05. Cloud-session usage → M7-07.
- Drift handling when a usage payload stops parsing → M6-02 (this step only counts `ParseError`s).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/quota/{window-state.ts, usage-sample.ts, rate-limit-signal.ts, window-ledger.ts}`.

Rules (100 % branch-covered in `window-ledger.spec.ts`):
- **R-W1 Official means vendor-reported.** `confidence = 'official'` only when `used` (or a percent/remaining figure) and at least one of `limit`/`resetAt` come verbatim from a vendor payload (probe result, app-server notification, rate-limit message). A sum of our own token samples is always `estimate`.
- **R-W2 Official supersedes, estimates accumulate.** An official observation replaces the state for `(provider, kind)`; later usage samples add on top (`used = official.used + Σ samples since observedAt`) and the state degrades to `estimate` until the next official observation.
- **R-W3 Rollover.** When `now ≥ resetAt`: `used = 0`, `windowStartedAt = resetAt`, `resetAt = resetAt + period(kind)` (`5h` → 5 h, `daily` → 24 h, `weekly` → 7 d, `tokens` → undefined), `confidence = 'estimate'`.
- **R-W4 Never fabricate.** No `limit` is ever guessed; a declared window with no signal has no row (API returns `state: null`, "no signal yet").
- **R-W5 Pure.** `WindowLedger.apply(prev: WindowState | null, input: LedgerInput, now): WindowState` is deterministic; time and ids come from `Clock`/`IdGenerator` ports.
- **R-W6 Model attribution.** `UsageSample.modelId` is recorded when the payload carries it; otherwise the session's current model (after `session.model_switched`) is used.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/quota/window-state.ts
export type WindowKind = '5h' | 'weekly' | 'daily' | 'tokens';
export type Confidence = 'official' | 'estimate';
export type UsageUnit = 'tokens' | 'percent' | 'requests' | 'credits';
export type QuotaSource = 'stream-json' | 'session-log' | 'app-server' | 'hook' | 'probe' | 'exit' | 'fake';

export interface WindowState {
  providerId: ProviderId; kind: WindowKind;
  used: number; unit: UsageUnit;
  limit?: number; resetAt?: string; windowStartedAt?: string;   // ISO-8601 UTC
  confidence: Confidence; source: QuotaSource; observedAt: string;
}
export interface UsageSample {
  id: string; providerId: ProviderId; sessionId: string; modelId?: ModelId; ts: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  source: QuotaSource; externalId?: string;                     // idempotency key with source
}
export interface RateLimitSignal {                              // extends 05 §1 shape
  providerId: ProviderId; sessionId?: string; windowKind?: WindowKind;
  resetAt?: string; retryAfterMs?: number; confidence: Confidence; source: QuotaSource;
  observedAt: string; raw?: { code?: string; message?: string };
}
export type LedgerInput =
  | { kind: 'sample'; sample: UsageSample }
  | { kind: 'probe'; state: Omit<WindowState, 'providerId' | 'observedAt'> }
  | { kind: 'signal'; signal: RateLimitSignal };

// packages/sdk/src/telemetry.ts (addition)
export type UsageEvent = { kind: 'usage'; sessionId: string; ts: string; modelId?: ModelId; externalId?: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  windowHints?: Array<Partial<Pick<WindowState, 'kind' | 'used' | 'limit' | 'resetAt' | 'unit'>>> };

// apps/daemon/src/application/ports/quota.ports.ts
export interface ProviderWindowRepository {
  upsert(state: WindowState): Promise<Result<void, StorageError>>;
  list(providerId?: ProviderId): Promise<Result<WindowState[], StorageError>>;
}
export interface UsageSampleRepository {
  append(s: UsageSample): Promise<Result<'inserted' | 'duplicate', StorageError>>;
  since(providerId: ProviderId, fromTs: string): Promise<Result<UsageSample[], StorageError>>;
}
export interface QuotaProbeRegistry { get(providerId: ProviderId): QuotaProbe | undefined; }   // DI map, no switch
```
Use cases (one class each, `apps/daemon/src/application/quota/`): `IngestUsageSample`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows`. All return `Result<_, QuotaError>` with `QuotaError = ProviderNotEnabled | ProbeNotQuotaFree | ProbeFailed | StorageError`.

### 4.3 Data / schema changes
Migration `apps/daemon/src/infrastructure/persistence/migrations/<next>-m4-01-quota-windows.ts` (additive; shipped migrations untouched):
- `provider_windows` (04-domain-model.md §4) + `unit TEXT NOT NULL DEFAULT 'tokens'`, `source TEXT NOT NULL DEFAULT 'estimate'`, `observed_at TEXT`, `window_started_at TEXT`; unique index `(provider_row_id, kind)`.
- New `usage_samples`: `id, provider_row_id, session_id, model_id, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, source, external_id`; unique `(source, external_id)` where `external_id IS NOT NULL`; index `(provider_row_id, ts)`. Retention 30 days (daily purge job; folded into M5-06 TTL later).
- Events: `quota.window_updated` payload = `WindowState`; `quota.rate_limited` payload = `RateLimitSignal`; both Zod-validated on write.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Claude** (`packages/providers/claude/src/quota/`): `TelemetryParser` emits `usage` from stream-json `result` messages (headless) and from session JSONL usage fields (interactive, source `session-log`; file path from the manifest `paths`, never from credential dirs). `RateLimitParser` recognises the recorded 429 exit fixture, stream error lines and the `Notification` hook with `quota_auto_resume_*` matchers (exact field names: verify against Claude Code docs at step start). Windows: `5h`, `weekly` (05 §3). No scheduled probe: `/usage` is an interactive slash command; whether its result reaches hooks/stream-json is to be verified against Claude Code docs at step start — if it is PTY text only it is **not** parsed (C7).
- **Codex** (`packages/providers/codex/src/quota/`): `usage` from app-server token/usage notifications and `turn.completed` usage (method names per the pinned `generate-json-schema` fixture; verify against Codex docs at step start); rate-limit from app-server error responses and `exec --json` error lines. Window kinds as declared in `manifest.limits.windows` (verify against Codex docs at step start). Scheduled probe only if an official quota-free RPC exists (verify).
- **agy** (`packages/providers/agy/src/quota/`): `QuotaProbe.probe` runs `agy -p "/usage"` (structured, quota-free per 05 §3) via the launcher's headless argv builder, Zod-parses the output into `WindowState[]` with `confidence: 'official'`; `/credits` mapped to `unit: 'credits'`. `isQuotaFree = true`. Skipped unless `providers.agy.tos_acknowledged_at` is set (C11). Exact JSON shape: verify against Antigravity docs at step start.
- **FakeProvider** (`packages/sdk/src/fake/`): scenario steps `emit-usage {input, output, model?}`, `emit-rate-limit {windowKind, resetAt | retryAfterMs}`, probe result `windows: [...]`. New scenarios `usage-steady.yaml`, `rate-limit-429.yaml`, `probe-official.yaml`.
- **Scheduler** (`apps/daemon/src/infrastructure/quota/quota-probe.scheduler.ts`): boot + 30 s, every 15 min ± 2 min jitter, after each `quota.rate_limited`, on manual refresh; ≥ 5 min between automatic probes per provider; one in-flight probe per provider; probes run through the daemon's allowlisted `ProcessRunner` with the env allowlist (09-engineering-standards), never inside tmux.
- **Fixture replay** (`tools/scripts/fixtures-replay.ts`, `pnpm --filter @orchestra/daemon fixtures:replay <provider> <fixture> --session <id>`): posts a recorded fixture into the telemetry pipeline of a running session; refused unless `features.devTools` and bound to 127.0.0.1.

### 4.5 API / UI surface
- `GET /providers/:id/windows` → `{ declared: WindowKind[], windows: Array<{ kind, state: WindowState | null }> }`.
- `POST /providers/:id/windows/refresh` (`Idempotency-Key`) → `202 { probeId }`; `422 ProbeNotQuotaFree` when the adapter has no quota-free probe; `409 ProbeInFlight`.
- `GET /providers/:id/usage?from=&to=` → `UsageSample[]` (paginated).
- WS `/ws` topic `quota`: `quota.window_updated`, `quota.rate_limited`.
- No UI change (M4-07); audit rows for manual refresh via the audit interceptor.

### 4.6 Flow / sequence
```
claude pane ─stream-json result─▶ hooks/stream receiver ─▶ TelemetryParser(claude).parse ─▶ NormalizedEvent{usage}
   ─▶ IngestUsageSample: append (idempotent by source+externalId) ─▶ WindowLedger.apply(prev, sample)
   ─▶ ProviderWindowRepository.upsert ─▶ emit quota.window_updated ─▶ /ws topic quota
agy ─(scheduler)─▶ RunQuotaProbe: registry.get('agy').probe() ─▶ WindowState[] official ─▶ upsert + event
codex app-server ─429 error─▶ RateLimitParser(codex).parse ─▶ RateLimitSignal ─▶ ApplyRateLimitSignal:
   emit quota.rate_limited; ledger.apply(prev, signal) sets resetAt/confidence official ─▶ upsert + event
```

## 5. Tasks
- [ ] Record missing fixtures on real CLIs: Claude stream-json completion with usage, session JSONL excerpt, 429 exit; Codex app-server usage notification, `turn.completed`, 429; agy `/usage` and `/credits` output (redacted, `RECORDED.md` updated).
- [ ] `packages/core/src/quota/`: value objects + `WindowLedger` with rules R-W1…R-W6; unit tests at 100 % branch.
- [ ] `packages/sdk`: `usage` `NormalizedEvent` kind; Zod schemas for `WindowState`, `UsageSample`, `RateLimitSignal`; `quota.contract.spec.ts` (probe never returns secret-shaped fields, `isQuotaFree` honoured, 429 fixtures yield `resetAt` or `retryAfterMs`).
- [ ] FakeProvider: `emit-usage`, `emit-rate-limit`, scripted probe; three scenarios.
- [ ] Claude adapter: usage from stream-json + session JSONL; rate-limit parser incl. `Notification` `quota_auto_resume_*`; fixtures pinned.
- [ ] Codex adapter: usage from app-server notifications + `turn.completed`; rate-limit parser for app-server + `exec --json`; schema fixture check.
- [ ] agy adapter: `QuotaProbe` (`-p "/usage"`, `/credits`), Zod output schema, ToS gate.
- [ ] Migration + Kysely repositories (`ProviderWindowRepository`, `UsageSampleRepository`) + in-memory doubles.
- [ ] Use cases `IngestUsageSample`, `ApplyRateLimitSignal`, `RunQuotaProbe`, `GetProviderWindows`; wire to telemetry pipeline via event bus.
- [ ] `QuotaProbeScheduler` with jitter, min interval, in-flight guard, `features.quota` flag.
- [ ] HTTP controller + Zod DTOs + OpenAPI; WS topic `quota`; audit on refresh.
- [ ] `fixtures:replay` dev script behind `features.devTools`.
- [ ] Daily purge of `usage_samples` older than 30 d.
- [ ] Docs: `packages/providers/*/README.md` "Quota signals" section; update `05-provider-contract.md` fixture list only if new fixture kinds were added (ADR not needed).

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

## 7. Acceptance criteria (Definition of Done)
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
