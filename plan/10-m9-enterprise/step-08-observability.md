# Step M9-08 — Observability

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M0-04, M9-03 |
| Estimated effort | 2 days |
| Packages touched | `apps/daemon` (`src/infrastructure/telemetry/{otel,metrics}`, `src/infrastructure/egress`, `src/interface/http/metrics`, `src/interface/config`), `packages/core` (metric name constants only), `deploy/grafana` (new), `deploy/helm/orchestra` (ServiceMonitor, OTLP values), `docs/deployment` |
| Risk | Medium (a metrics endpoint is an information-disclosure surface; cardinality bugs can OOM a scrape target) |
| Owner | |

## 1. Goal
The daemon exports what it is doing in the two standard ways: OpenTelemetry traces and metrics over OTLP to a configured collector, and a Prometheus-format `/metrics` endpoint that exposes the product's own KPIs — live sessions by provider and state, open prompts and their age, time-to-decision and time-to-resolution, quota window usage and forecast, reroutes, restore-lost-prompt counts, audit chain health, automation runs and storage health. A shipped Grafana dashboard JSON renders the G2/G6 KPIs from a FakeProvider run with no hand-editing, and a shipped alert-rules file fires on the failure modes that matter (audit chain broken, sink down, provider unhealthy, restore lost a prompt, window about to exhaust). Structured logs keep their pino shape with correlation ids, and the docs explain how to ship them without Orchestra shipping them itself.

## 2. Why
- Source plan §17: "daemon OTel + Prometheus + health" is an enterprise pillar; `08-tech-stack.md` already pins OpenTelemetry JS with a `gen_ai.*` semconv snapshot and dual-emit via `OTEL_SEMCONV_STABILITY_OPT_IN`, and M0-04 deliberately added the dependency "but no exporter until M9-08" — this step redeems that note.
- G2 and G6 have numeric targets ("≥ 60 % of tasks routed off the top-tier model", "≥ 80 % of each paid window used productively", "drift detected < 60 s", "remediation < 10 s"). Those targets are currently only visible in the Fleet screen (M4-07) and the Health screen (M6-07); as time series they become trends and alerts instead of a snapshot.
- D9/`03-architecture.md` §6 lists OTel traces as cross-cutting with correlation ids (`sessionId`, `taskId`, `missionId`) — the ids already exist in pino; this step makes them trace attributes too, so a slow prompt round-trip can be read as a waterfall.
- M9-06 gives the daemon a stable place to be scraped (Service + ServiceMonitor) and M9-03 gives a security signal worth alerting on (`orchestra_audit_chain_ok`).
- C2: an OTLP endpoint is user-configured outbound egress and must go through the single allowlisted `infrastructure/egress` module, like the IdP (M9-02), SIEM sinks (M9-03) and object store (M9-05).
- C13/C3: metric labels and span attributes are a classic leak path (a prompt title, a file path, a repo name). Redaction and a label allowlist belong here, not in the dashboards.

## 3. Scope
### In scope
- OTel SDK bootstrap: resource attributes, `NodeSDK` with OTLP/HTTP exporters for traces and metrics, sampling config, graceful shutdown flush.
- Instrumentation: HTTP server, WS gateway commands, use-case spans (one span per use case via a Nest interceptor), tmux/PTY operations, DB queries (Kysely plugin), provider adapter calls, prompt round-trips.
- `gen_ai.*` semconv snapshot pinned with dual-emit via `OTEL_SEMCONV_STABILITY_OPT_IN`, per `08-tech-stack.md`.
- Prometheus `/metrics` endpoint (text exposition), guarded by `metrics.read` (M9-01) or a bearer token, with an explicit metric + label catalog and a cardinality budget.
- Metric set covering sessions, prompts, TTD/TTR, window usage/forecast, reroutes, restore, audit chain + sinks, automations, storage, recordings, doctor/drift, and process/runtime basics.
- `deploy/grafana/orchestra-overview.json` dashboard + `deploy/grafana/orchestra-rules.yaml` alert rules; Helm values for `ServiceMonitor` and `PrometheusRule`.
- Log shipping **guidance** (pino → stdout → Fluent Bit / Vector / Loki), not an implementation.
- Redaction/label allowlist and a cardinality guard test.
### Out of scope (deferred to …)
- Shipping logs from the daemon itself (a log exporter) — guidance only; if a team wants it, the OTLP logs signal is a candidate for M10.
- Consuming OTel emitted *by the vendor CLIs* (`/otlp` receiver in `03-architecture.md` §5) — that receiver belongs to the telemetry plane (M1-08) and is not re-scoped here; this step only *exports*.
- A bundled Prometheus/Grafana in the Helm chart — the chart ships a ServiceMonitor and a PrometheusRule and assumes the cluster already has an operator.
- Distributed tracing across multiple hosts (M7-05) — trace context is propagated where the transport allows, but a multi-host trace view is not a deliverable.
- SLO burn-rate alerting and error budgets — M6-07 owns the SLO definitions; this step exposes the raw metrics and one example burn-rate rule.
- Anonymised telemetry leaving the user's infra — M10-02, opt-in, unrelated: nothing here phones home.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain types. Two rules, both test-enforced:
- **R-O1 No high-cardinality labels.** Labels may only take values from a closed set: `provider` (from the registry), `model` (from the catalog), `state` (from a state machine), `task_type` (from the taxonomy), `kind`, `outcome`, `sink`, `driver`, `reason` (from a fixed error-code union). Ids (`sessionId`, `taskId`, `missionId`, `userId`), free text, paths, branch names and repo names are **never** labels; they belong in span attributes or logs. A unit test enumerates every registered metric and fails on a label outside the allowlist.
- **R-O2 Nothing sensitive in telemetry.** Span attributes pass the same redactor as M5-01/M9-03 before export, and a deny list drops attributes whose key matches `token|secret|password|apiKey|authorization|cookie|prompt_text|message`. Prompt *content* is never exported — only kind, risk, priority and timings.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/telemetry/metric-names.ts  (constants only — core stays I/O free)
export const METRICS = {
  sessionsActive:        'orchestra_sessions_active',              // gauge  {provider, model, state}
  sessionStarts:         'orchestra_session_starts_total',         // counter{provider, model, outcome}
  sessionDuration:       'orchestra_session_duration_seconds',     // histogram{provider, outcome}
  promptsOpen:           'orchestra_prompts_open',                 // gauge  {provider, kind, priority}
  promptOpenAge:         'orchestra_prompt_open_age_seconds',      // histogram{kind}
  promptTimeToDecision:  'orchestra_prompt_time_to_decision_seconds', // histogram{kind, answered_by}
  promptTimeToResolution:'orchestra_prompt_time_to_resolution_seconds', // histogram{kind, transport}
  promptExpired:         'orchestra_prompts_expired_total',        // counter{kind, transport}
  windowUsedRatio:       'orchestra_window_used_ratio',            // gauge  {provider, window, confidence}
  windowResetSeconds:    'orchestra_window_reset_seconds',         // gauge  {provider, window}
  forecastTimeToLimit:   'orchestra_forecast_time_to_limit_seconds',// gauge {provider, window, confidence}
  reroutes:              'orchestra_reroutes_total',               // counter{from_provider, to_provider, reason}
  rateLimited:           'orchestra_rate_limited_total',           // counter{provider}
  routingDecisions:      'orchestra_routing_decisions_total',      // counter{provider, model, task_type, top_tier}
  restoreLostPrompts:    'orchestra_restore_lost_prompts_total',   // counter{} — target is always 0
  restoreRuns:           'orchestra_restore_runs_total',           // counter{outcome}
  auditChainOk:          'orchestra_audit_chain_ok',               // gauge  {} 1|0
  auditSinkUp:           'orchestra_audit_sink_up',                // gauge  {sink}
  auditSpoolPending:     'orchestra_audit_spool_pending',          // gauge  {sink}
  gatesOpen:             'orchestra_gates_open',                   // gauge  {kind}
  gateDecisionSeconds:   'orchestra_gate_decision_seconds',        // histogram{kind, outcome}
  automationRuns:        'orchestra_automation_runs_total',        // counter{trigger_kind, state}
  driftDetectSeconds:    'orchestra_drift_detect_seconds',         // histogram{provider, kind}
  remediationSeconds:    'orchestra_remediation_seconds',          // histogram{ladder_step, outcome}
  storageUp:             'orchestra_storage_up',                   // gauge  {driver}
  storageQuerySeconds:   'orchestra_storage_query_seconds',        // histogram{op}
  recordingBytes:        'orchestra_recording_bytes_total',        // counter{driver}
  recordingUploadsPending:'orchestra_recording_uploads_pending',   // gauge  {driver}
  wsClients:             'orchestra_ws_clients',                   // gauge  {topic}
  termInputDropped:      'orchestra_term_input_dropped_total',     // counter{} (from M9-01)
} as const;

// apps/daemon/src/infrastructure/telemetry/metrics.port.ts
export interface MetricsPort {                 // thin facade so application code never imports the OTel SDK
  counter(name: string, labels: Labels, value?: number): void;
  gauge(name: string, labels: Labels, value: number): void;
  observe(name: string, labels: Labels, seconds: number): void;
  registerGaugeCallback(name: string, fn: () => Array<{ labels: Labels; value: number }>): void;   // for live gauges
}
export type Labels = Readonly<Record<string, string>>;   // values validated against the allowlist in dev/test

// apps/daemon/src/infrastructure/telemetry/tracing.ts
export interface TracingPort {
  span<T>(name: string, attrs: Attrs, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  currentTraceId(): string | undefined;        // injected into pino logs as `traceId`
}
export type TelemetryError = { code: 'ExporterUnreachable' | 'EgressBlocked' | 'ConfigInvalid'; message: string };
```
`MetricsPort` is implemented by an OTel meter-backed adapter and a no-op adapter (`observability.metrics.enabled: false`), registered in a DI strategy map. Application code depends on the port only, so `dependency-cruiser` rules are unaffected.

### 4.3 Data / schema changes
None. Metrics are derived from existing tables and the in-process event bus:
- Live gauges (`sessionsActive`, `promptsOpen`, `gatesOpen`, `windowUsedRatio`, `recordingUploadsPending`) are **callback gauges** computed on scrape from the repositories with a 5 s memoisation, so `/metrics` never runs an unbounded query per scrape.
- Counters and histograms are fed by `EventBus` subscriptions (M0-05): `session.*`, `prompt.*`, `routing.*`, `quota.*`, `gate.*`, `automation.*`, `doctor.*` each map to one metric update in a single `MetricsProjector` — one place to audit, one place to test.
- Counter durability across restarts: Prometheus counters are allowed to reset; the projector does not attempt to restore them. `restoreLostPrompts` is the exception — it is read from the M5-05 restore-run records so a restart cannot hide a lost prompt.
- Config:

| Key | Type | Default | Notes |
|---|---|---|---|
| `observability.metrics.enabled` | boolean | `true` | no-op adapter when false |
| `observability.metrics.path` | string | `/metrics` | |
| `observability.metrics.auth` | `permission \| token \| none` | `permission` | `none` refused unless `server.bind` is loopback or `features.container` |
| `observability.metrics.tokenEnv` | string | `ORCH_METRICS_TOKEN` | for `auth: token` (Prometheus bearer) |
| `observability.traces.enabled` | boolean | `false` | opt-in |
| `observability.otlp.endpoint` | url | — | e.g. `http://otel-collector:4318`; required when traces enabled |
| `observability.otlp.headers` | record | `{}` | values from env refs only |
| `observability.otlp.protocol` | `http/protobuf \| grpc` | `http/protobuf` | |
| `observability.traces.sampleRatio` | number | `0.1` | parent-based ratio; 1.0 for debugging |
| `observability.serviceName` | string | `orchestrad` | resource attribute |
| `observability.exportIntervalMs` | number | `15000` | metric export interval to OTLP |

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **SDK bootstrap** happens before the Nest app is created (instrumentations must patch modules first) in `apps/daemon/src/infrastructure/telemetry/bootstrap.ts`, driven by the already-loaded Zod config — so a bad endpoint fails fast with `ConfigInvalid` rather than at first export.
- Resource attributes: `service.name`, `service.version` (daemon version), `service.instance.id` (hostId), `deployment.environment` (config), `host.arch`, plus `orchestra.storage_driver` and `orchestra.auth_mode`. No user identity, no repo path.
- **Instrumentations:** `@opentelemetry/instrumentation-http`, `-fastify`, `-pg` (when driver is postgres), plus a Nest interceptor creating one span per use case named `usecase.<ClassName>` with attributes `{orchestra.session_id?, orchestra.task_id?, orchestra.mission_id?, orchestra.prompt_id?, orchestra.provider?, orchestra.model?}` — the same correlation ids pino already carries, so a log line and a span can be joined. `better-sqlite3` has no instrumentation; the Kysely plugin emits `storageQuerySeconds` and a span per query kind instead.
- **`gen_ai.*` semconv:** provider adapter calls (launch, prompt delivery, usage parse) emit spans using the pinned snapshot with `OTEL_SEMCONV_STABILITY_OPT_IN` dual-emit, per `08-tech-stack.md`. The snapshot version is recorded in a constant and in the docs so a collector-side schema change is traceable. Note: these spans describe *our* orchestration of the CLI, never a vendor API call — there are none (C2/D4).
- **Egress:** the OTLP endpoint host is registered in the `infrastructure/egress` allowlist at boot, with the same vendor-domain assertion as M9-03's sinks. Export failures are logged at `warn` with backoff, raise `orchestra_exporter_up 0`, and never block a request path (exporters run on their own interval).
- **`/metrics` endpoint:** served by the same Fastify instance. Default auth is the M9-01 permission `metrics.read` (Lead/Admin), which works for a human but not for Prometheus — hence `auth: token` with a bearer read from env, which is what the Helm ServiceMonitor uses (`bearerTokenSecret`). `auth: none` is refused unless bound to loopback or inside a container, because `/metrics` leaks provider names, model names, session counts and window usage.
- **Cardinality guard:** a boot-time validation walks the registered metric catalog and asserts every label key is in the allowlist; a dev/test-only wrapper asserts label *values* come from the closed sets and counts distinct series, failing a test above a budget of 2 000 series for a 50-session fleet.
- **Shutdown:** `ShutdownDaemon` (M9-06) calls `sdk.shutdown()` to flush spans and a final metric export within the drain deadline.
- No tmux or git changes.

### 4.5 API / UI surface
- `GET /metrics` — Prometheus text exposition; auth per `observability.metrics.auth`; `Cache-Control: no-store`. Returns 200 with an empty body plus a `# metrics disabled` comment when disabled (so a scrape does not alert on 404).
- `GET /health/ready` (M9-06) gains an `exporter` check when traces are enabled — degraded exporter is **not** a readiness failure (it must not take the daemon out of service), only a metric and a Health card.
- Health screen (M6-07) gains an "Observability" card: exporter state, last successful export, series count, and a "Copy Prometheus scrape config" button.
- Settings → About: the OTLP endpoint (host only, never headers), sample ratio, semconv snapshot version.
- Helm (M9-06 chart): `observability.metrics.serviceMonitor: true` renders a `ServiceMonitor` with the bearer secret; `observability.prometheusRule: true` renders the shipped alert rules; `observability.otlp.endpoint` renders the config and the egress allowlist entry.
- Shipped artifacts: `deploy/grafana/orchestra-overview.json` (rows: Fleet — sessions by provider/state, starts, failures; Attention — open prompts, age heatmap, TTD/TTR quantiles; Quota — window used ratio with `confidence` in the legend, forecast time-to-limit, reroutes, rate limits; Governance — audit chain ok, sink up, spool pending, gates open, gate decision time; Platform — storage up, query p95, recording uploads pending, WS clients, restore lost prompts) and `deploy/grafana/orchestra-rules.yaml`.

Alert rules shipped (examples, all with `for:` windows and runbook links):

| Alert | Expression (sketch) | For | Severity |
|---|---|---|---|
| `AuditChainBroken` | `orchestra_audit_chain_ok == 0` | 1m | critical |
| `AuditSinkDown` | `orchestra_audit_sink_up == 0` | 15m | warning |
| `AuditSpoolBacklog` | `orchestra_audit_spool_pending > 10000` | 10m | warning |
| `RestoreLostPrompt` | `increase(orchestra_restore_lost_prompts_total[1h]) > 0` | 0m | critical |
| `WindowNearExhaustion` | `orchestra_forecast_time_to_limit_seconds < 1800 and orchestra_window_used_ratio > 0.8` | 5m | warning |
| `ProviderUnhealthy` | `orchestra_sessions_active{state="crashed"} > 0` or a doctor gauge | 10m | warning |
| `StorageDown` | `orchestra_storage_up == 0` | 2m | critical |
| `RecordingUploadsStuck` | `orchestra_recording_uploads_pending > 0` unchanged | 15m | warning |
| `PromptsAging` | `histogram_quantile(0.9, orchestra_prompt_open_age_seconds) > 3600` | 15m | warning |

### 4.6 Flow / sequence
```
boot
  loadConfig → telemetry/bootstrap: resource, instrumentations, OTLP exporters (if enabled)
            → MetricsPort adapter (otel | noop) into DI
            → MetricsProjector subscribes to EventBus topics
            → registerGaugeCallback for live gauges (memoised 5 s)
  → Nest app → /metrics route → ready

request path
  HTTP span (auto) → usecase.<Name> span (interceptor, correlation attrs)
      → adapter span (gen_ai.* snapshot, dual-emit) → db span (Kysely plugin)
  pino line carries traceId/spanId → logs and traces join in the collector

event path
  prompt.opened  → promptsOpen gauge callback picks it up; no counter
  prompt.answered→ observe(promptTimeToDecision, answeredAt-openedAt, {kind, answered_by})
  prompt.delivered→observe(promptTimeToResolution, deliveredAt-openedAt, {kind, transport})
  quota.window_updated → gauge windowUsedRatio{provider,window,confidence}
  routing.rerouted → counter reroutes{from,to,reason}
  audit verify job (hourly + on demand) → gauge auditChainOk

scrape
  GET /metrics (bearer) → gauge callbacks run (memoised) → text exposition
  label allowlist assertion is compile/boot-time, not per scrape
```

## 5. Tasks
- [ ] `packages/core/src/telemetry/metric-names.ts` (constants + label allowlist per metric) — no runtime deps.
- [ ] `MetricsPort` + OTel meter adapter + no-op adapter; DI strategy keyed by `observability.metrics.enabled`.
- [ ] `TracingPort` + OTel bootstrap (resource attrs, instrumentations, OTLP exporters, parent-based ratio sampler, shutdown flush) executed before the Nest factory.
- [ ] Nest interceptor emitting one span per use case with correlation attributes; pino formatter injecting `traceId`/`spanId`.
- [ ] Kysely plugin for `storageQuerySeconds` + a span per query kind; `pg` instrumentation enabled only for the postgres driver.
- [ ] `gen_ai.*` semconv snapshot constant + dual-emit env wiring in provider adapter spans; record the snapshot version in the docs.
- [ ] `MetricsProjector`: one subscription set mapping `session.*`, `prompt.*`, `routing.*`, `quota.*`, `gate.*`, `automation.*`, `doctor.*`, `recording.*` to metric updates; unit-tested per event type.
- [ ] Callback gauges with 5 s memoisation for sessions, prompts, gates, windows, uploads, WS clients.
- [ ] `/metrics` endpoint with the three auth modes, the `auth: none` boot assertion, and `no-store`.
- [ ] Redaction of span attributes + attribute deny list; cardinality guard at boot + a series-count test at 50 sessions.
- [ ] Egress allowlist entry for the OTLP endpoint + the vendor-domain boot assertion; exporter failure handling (backoff, `orchestra_exporter_up`, never blocking requests).
- [ ] `deploy/grafana/orchestra-overview.json` (five rows as listed) and `deploy/grafana/orchestra-rules.yaml` (nine alerts with runbook annotations).
- [ ] Helm: `ServiceMonitor`, `PrometheusRule`, OTLP values, metrics bearer secret; wire into the M9-06 kind smoke job.
- [ ] Health "Observability" card + Settings → About fields; "Copy Prometheus scrape config" action.
- [ ] Docs `docs/deployment/observability.md`: metric catalog with meanings and units, dashboard import, alert tuning, log shipping guidance (pino JSON → stdout → Fluent Bit/Vector → Loki/Elastic, with the correlation-id fields to index), and what is deliberately *not* exported.
- [ ] Measure exporter overhead under the M5 load profile (50 panes, 10k events/min) and record p95 deltas in the step log.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-08-01 | unit | label allowlist: every registered metric's labels checked against the catalog; a metric declaring `session_id` | boot assertion fails with the metric name; 100 % of the catalog covered |
| UT-M9-08-02 | unit | `MetricsProjector` for each subscribed event type (one case per type) | exactly the expected metric call with the expected labels; unknown event types are ignored, not thrown on |
| UT-M9-08-03 | unit | span attribute redaction: attrs containing `sk-ant-…`, `authorization`, `prompt_text` | secret replaced, denied keys dropped, remaining attrs intact |
| AT-M9-08-01 | application | metrics disabled (`enabled: false`) | no-op adapter used, `/metrics` returns 200 with the disabled comment, zero OTel objects created |
| AT-M9-08-02 | application | exporter unreachable for 60 s | requests unaffected (p95 unchanged in the test harness), `orchestra_exporter_up` 0, warn logs backed off, no unhandled rejection |
| IT-M9-08-01 | integration | scrape `/metrics` after a scripted FakeProvider run (session, prompt answered, reroute, gate, automation) | every KPI metric present with plausible values; text parses with a Prometheus parser; series count < 2 000 |
| IT-M9-08-02 | integration | auth modes: `permission` as Viewer/Lead, `token` with right/wrong bearer, `none` with a non-loopback bind | 403/200, 200/401, boot refused respectively |
| IT-M9-08-03 | integration | traces to a local OTLP collector: one prompt round-trip | a single trace contains HTTP → `usecase.AnswerPrompt` → adapter → db spans with matching `orchestra.prompt_id` |
| IT-M9-08-04 | integration | cardinality under load: 50 concurrent FakeProvider sessions across 3 providers and 6 models | series count stays under budget; no label takes an id-shaped value (regex assertion over the exposition) |
| E2E-M9-08-01 | e2e | Grafana container provisioned with the shipped dashboard + a Prometheus scraping the daemon during a FakeProvider run | every panel renders non-empty; no "No data" on the five KPI panels; `AuditChainBroken` fires when the chain is broken on purpose |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-08-01 | Prometheus + Grafana on a real run | 1. `docker compose -f deploy/compose/observability.yaml up -d` (Prometheus + Grafana + OTel collector). 2. Run the M8 demo with real CLIs for 20 minutes. 3. Import `deploy/grafana/orchestra-overview.json`. | All five dashboard rows render with real data; window usage panels show the `confidence` label (official vs estimate) so no number is presented as exact; TTD/TTR quantiles look plausible against what you observed in Attention. | ⬜ |
| TC-M9-08-02 | Traces explain a slow prompt | 1. Enable traces with `sampleRatio: 1.0`. 2. Trigger a Claude permission prompt and answer it from the web. 3. Open the trace in the collector's UI (Jaeger/Tempo). | One trace spans the hook receipt → `usecase.OpenPrompt` → WS emit → `usecase.AnswerPrompt` → transport delivery, with `orchestra.session_id` and `orchestra.prompt_id` on each span, and the wall-clock gap attributable to the human is visible as a gap, not a span. | ⬜ |
| TC-M9-08-03 | Alerts fire and recover | 1. Break the audit chain (M9-03 TC-M9-03-02). 2. Stop the SIEM sink for 20 minutes. 3. Fix both. | `AuditChainBroken` fires within 1 minute (critical) and `AuditSinkDown` within 15 minutes (warning); both resolve after the fix; each alert's runbook annotation links to a real docs section. | ⬜ |
| TC-M9-08-04 | Negative: `/metrics` is not open to everyone | 1. With `auth: permission`, scrape as bob (Viewer) and as alice (Lead). 2. With `auth: token`, scrape with a wrong bearer. 3. Set `auth: none` with `server.bind: 0.0.0.0` outside a container and restart. | 403 then 200; 401; the daemon refuses to boot with a message naming `observability.metrics.auth`. No provider, model or window data is served to an unauthenticated caller in any case. | ⬜ |
| TC-M9-08-05 | Negative: no secrets or ids in telemetry | 1. Run a session whose prompt payload contains a JWT and a repo path with a customer name. 2. `curl /metrics \| grep -E 'eyJ\|/Users/\|sk-ant-\|session_id'`. 3. Inspect 20 exported spans in the collector. | Zero matches in `/metrics`; spans carry ids only in `orchestra.*` attributes (not in span names), no prompt text, no file contents; the repo path appears nowhere. | ⬜ |
| TC-M9-08-06 | Cardinality under a real fleet | 1. Start 20 sessions across 3 providers and several models. 2. `curl -s /metrics \| grep -c '^orchestra_'`. 3. Check Prometheus `scrape_samples_scraped` over an hour. | Series count is stable and within the documented budget; it does not grow with the number of sessions started over time (only with distinct label combinations). | ⬜ |
| TC-M9-08-07 | Resilience: collector outage and daemon restart | 1. Start a load run with traces enabled. 2. Stop the OTel collector for 5 minutes, then restart it. 3. `kill -9` the daemon during the outage and restart it. | The daemon stays healthy and responsive throughout; no request latency regression (compare p95 before/during); after the collector returns, exporting resumes; counters reset at restart (expected) but `orchestra_restore_lost_prompts_total` is re-derived from restore records and is `0`. | ⬜ |
| TC-M9-08-08 | Overhead budget | 1. Run the M5 load profile (50 panes, 10k events/min) with observability off, then on. 2. Compare daemon memory, CPU and event-ingest p95. | Added memory ≤ 60 MB, added CPU ≤ 5 %, ingest p95 regression ≤ 10 %; record the actual numbers in the step log. If exceeded, reduce the sample ratio or export interval and re-measure. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `/metrics` exposes the full KPI catalog (sessions, prompts, TTD/TTR, window usage + forecast with `confidence`, reroutes, restore lost prompts, audit chain and sinks, gates, automations, storage, recordings) and parses with a standard Prometheus parser.
- [ ] Label allowlist is enforced at boot and by a test; no id-shaped or free-text label value appears in the exposition under a 50-session load (IT-M9-08-04, TC-M9-08-06).
- [ ] OTLP traces link a full prompt round-trip with `orchestra.*` correlation attributes, using the pinned `gen_ai.*` snapshot with dual-emit (IT-M9-08-03, TC-M9-08-02).
- [ ] `/metrics` is authenticated by default; `auth: none` is refused outside loopback/container (TC-M9-08-04).
- [ ] No secrets, prompt text, file contents or repo paths reach metrics or spans (UT-M9-08-03, TC-M9-08-05).
- [ ] Exporter failures never affect request handling or readiness; they surface as a metric, a Health card and backed-off logs (AT-M9-08-02, TC-M9-08-07).
- [ ] The shipped Grafana dashboard renders every panel from a FakeProvider run with no hand-editing, and the shipped alert rules fire and resolve as specified (E2E-M9-08-01, TC-M9-08-03).
- [ ] Observability overhead is within the documented budget and the measured numbers are recorded (TC-M9-08-08).
- [ ] All TC-M9-08-* pass and are recorded; no new lint/arch violations (application code imports only `MetricsPort`/`TracingPort`); `docs/deployment/observability.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- OTel JS semantic conventions for `gen_ai.*` are still unstable (the reason `08-tech-stack.md` pins a snapshot). Dual-emit doubles attribute volume and the snapshot will drift; re-verify the pinned version and the `OTEL_SEMCONV_STABILITY_OPT_IN` value at step start (verify).
- Callback gauges run repository queries on scrape. With a 15 s scrape interval and a 5 s memoisation this is cheap, but a second scraper (or a low interval) could multiply it. Consider a hard floor on recomputation instead of memoisation if TC-M9-08-08 shows pressure.
- `/metrics` is an information-disclosure surface even when authenticated: provider names, model names, plan labels and window usage describe the team's spend. The docs must say so, and `metrics.read` is deliberately Lead+ in the M9-01 matrix.
- Prometheus counters resetting on restart is normal, but `restoreLostPrompts` must **not** reset to zero and hide an incident — it is re-derived from restore records, which assumes M5-05 persists them; confirm that assumption against M5-05's design (verify).
- Auto-instrumentation patches modules at require time; combined with the Nest DI bootstrap and `tsx watch` in dev this is a classic source of "spans missing in dev, present in prod". Bootstrapping before the Nest factory is the mitigation; verify in dev mode explicitly.
- The ROADMAP lists M9-08 as depending only on M0-04, but the metric catalog above covers audit (M9-03), gates (M9-04), storage (M9-05) and automations (M9-07). Those metric families should be registered but inert until their features land — Lane C can start on day 1 as planned, with a second pass to light them up (inconsistency with the dependency column, not fixed here).
- Log shipping is guidance only. A team that wants logs, traces and metrics in one pipeline may reasonably expect an OTLP logs exporter; if that comes up, it is a small addition but a new scope decision (candidate for M10).
- Alert thresholds in `orchestra-rules.yaml` are guesses until there is real data (especially `PromptsAging` and `WindowNearExhaustion`); they ship as examples with a "tune these" note, not as defaults anyone should trust unmodified.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
