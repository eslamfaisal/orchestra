# Risk register

Score = Likelihood (1–5) × Impact (1–5). Review at every milestone boundary; update Status.

| ID | Risk | L | I | Score | Trigger / early signal | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| R1 | Vendor CLI changes break adapters (hooks, stream formats, app-server schema) | 5 | 4 | 20 | contract-test failures on fixture refresh; Zod parse errors in prod | fixtures pinned per version (M1-05..07); Doctor + drift detector (M6); manifests hot-reloadable; ladder 1–2 | | Open |
| R2 | tmux control-mode edge cases (escape sequences, large output, reconnect) | 4 | 4 | 16 | parser errors; dropped `%output`; stuck panes | fuzz + property tests (M1-01); single supervisor actor (M1-02); backpressure; re-attach tests | | Open |
| R3 | Codex `app-server` is experimental; schema drifts or is removed | 4 | 3 | 12 | `generate-json-schema` diff; RPC errors | `exec --json` fallback transport (ADR-009); transport switch as ladder-1 remediation | | Open |
| R4 | Antigravity ToS comfort; adapter perceived as third-party access | 3 | 5 | 15 | legal review outcome; vendor communication | official binary only, opt-in + ToS ack (C11), no relay/API usage; legal review before public release | | Open |
| R5 | Prompt round-trip reliability (answer delivered but agent didn't act; double answers) | 4 | 4 | 16 | ack timeouts; approval loops | typed answer transports with ack (D14); idempotent answers; fallback `send-keys-acked` with keystroke fixtures; TC per prompt kind | | Open |
| R6 | Quota numerics undocumented (agy) → wrong forecasts | 4 | 2 | 8 | user reports vs reality | label *estimate* with confidence; conservative thresholds; official signals preferred | | Open |
| R7 | Native modules (node-pty, better-sqlite3) vs Node version / Tauri packaging | 3 | 4 | 12 | build failures on Node 26; notarization rejects | pin Node 22 (ADR-003); `PtyPort` abstraction; ADR-005 before M7 | | Open |
| R8 | Memory/perf budgets blown with many panes (xterm, recordings) | 3 | 3 | 9 | > 40 MB/pane; < 60 fps | budgets measured from M0-07; WebGL addon; scrollback caps; load tests nightly (M5) | | Open |
| R9 | Supply-chain compromise (npm worms targeting `.claude/` dirs) | 2 | 5 | 10 | audit alerts; Scorecard drops | pinned deps, `minimumReleaseAge`, provenance, Scorecard, allowlist + ESLint bans as controls (M0-08) | | Open |
| R10 | Scope creep: intelligence layer before substrate is solid | 4 | 3 | 12 | M2 work starting while M1 TCs fail | MVP gate (M1-13) is hard; ROADMAP dependencies enforced in PROGRESS | | Open |
| R11 | Lead LLM produces bad decompositions / loops | 3 | 3 | 9 | rework rounds > N; budget breaches | deterministic engine + budgets + max rounds (M3-04, M4-04); plan approval gate | | Open |
| R12 | Cross-vendor review impossible when only one provider healthy | 3 | 2 | 6 | reroute events | policy: degrade to same-vendor different-model with explicit flag + audit | | Open |
| R13 | Repair Agent modifies something it must not | 2 | 5 | 10 | guard violations in audit | path deny list + CODEOWNERS + assisted-only (C12) | | Open |
| R14 | Name/trademark conflict forces late rename | 3 | 3 | 9 | clearance report | ADR-002 early; keep brand out of package internals (use `orch`/`orchestrad` ids configurable) | | Open |
| R15 | OTel GenAI conventions change | 3 | 1 | 3 | semconv release | pinned snapshot + dual-emit env flag | | Open |
| R16 | Solo-developer bandwidth; estimates slip | 4 | 3 | 12 | milestone end dates missed by > 30 % | parallel lanes after M1; defer M7-07, M9, M10 items; MVP first | | Open |
| R17 | Antigravity terms §6 and headless interaction contract unresolved; wrapper may not be permitted | 4 | 3 | 12 | no written terms resolution; agy evidence row stays `unverified` | ADR-008 amended gate; adapter disabled and outside every dependency/acceptance criterion; 1.0 DoD needs four adapters without agy | | Open |
| R18 | Provider capability assumptions unproven (hook names, approval payloads, app-server reconnect, quota surfaces) until tested on real CLIs | 5 | 4 | 20 | "verify at step start" notes still open when M1-05/06 begin | M0-09 evidence matrix with real-CLI fixtures gates M1-05/M1-06; FakeProvider passes never flip a state to `verified`; capability states disable features, not providers | | Open |
| R19 | Enterprise RBAC mistaken for user isolation; shared OS identity, home, provider auth and tmux across users | 3 | 5 | 15 | multi-tenant pilot request; audit finding | ADR-019: v1 = trusted shared-team install, stated in UI/docs; isolated execution designed post-1.0 with a written trigger | | Open |
| R20 | In-process plugin code executes with daemon privileges; signature proves provenance, not behaviour | 3 | 5 | 15 | first community provider plugin submission | ADR-014 amended: trusted-tier only in-process; community provider plugins not loadable until an isolated plugin host exists | | Open |
| R21 | Estimates optimistic for provider integration, recovery correctness, desktop packaging, enterprise isolation, plugin security | 4 | 3 | 12 | M0-09 or M1-05/06 overrun > 30 % | 30 % contingency on those steps in PROGRESS target dates; ≥ 30-day KPI window scheduled from M8 exit; re-plan at each milestone gate | | Open |

## Retired risks
| ID | Risk | Closed | Why |
|---|---|---|---|
| | | | |
