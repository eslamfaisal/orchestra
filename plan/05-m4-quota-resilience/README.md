# Milestone 4 — Quota, budgets, resilience

> Folder: `plan/05-m4-quota-resilience/` · Steps M4-01 … M4-07 · ~14 working days · Status ⬜

## Goal

After M4 Orchestra knows, for every enabled provider, how much of each vendor quota window (5-h, weekly, daily, tokens) has been used, how fast it is burning, and when it will run out — using only official in-band signals — and it acts on that knowledge before the user is blocked: rate-limited providers cool until `resetAt`, affected tasks are rerouted at most once per window to the next capable provider, reserves protect the Lead and the review budget, an exhausted Lead hands its mission over to another provider's Lead through `PLAN.md`, and a mission can be dry-run against the current windows before a single token is spent. Every number the UI shows is labelled *official* or *estimate*.

## Why this milestone now

- G4 ("never blocked") is the second-most-cited pain in `01-vision-scope.md`: one exhausted window stops everything. M1–M3 made the fleet run; M4 makes it keep running.
- G2 KPIs (off-top-tier routing %, window utilisation %) cannot be measured without windows and forecasts; M4-07 is the first place they appear.
- The assignment engine (M2-04) already multiplies by `quotaAvailability(provider)` (`06-intelligence-layer.md` §3) but has nothing real to multiply by until M4-02 exists.
- M6 (drift classifier) and M8-06 (learning loop) consume quota signals; M4-01 is on their critical path (`ROADMAP.md` dependency graph).
- Rate-limit handling is a compliance surface (C5): it must be built once, correctly, with tests that prove "max one retry, no storms", before missions run unattended.

## Entry criteria

- [ ] M1-13 ✅ (MVP accepted on real Claude Code + Codex; FakeProvider scenarios run in CI).
- [ ] M1-08 ✅ telemetry plane normalises hook / stream-json / app-server payloads; `orch fixtures record` works.
- [ ] M2-03 ✅ manifests declare `limits.windows` for claude, codex, agy.
- [ ] M2-04 ✅ assignment engine with `quotaAvailability` and `constraints` hooks and golden tests.
- [ ] For M4-05 only: M3-02 ✅ (Lead session, `PLAN.md`, plan versions). For M4-06 only: M3-08 ✅ (Missions screen, DAG view).
- [ ] Fixtures for each real adapter contain at least one recorded 429 / rate-limit sample (`fixtures/<cliVersion>/exit/*.txt`, `stream/*.jsonl` or `rpc/*.json`); if missing, record them with `orch fixtures record` as the first task of M4-01.

## Exit criteria (all measurable)

- [ ] After one session per provider, `GET /providers/:id/windows` returns a `WindowState` for every manifest-declared window kind of claude, codex, fake (and agy when opted in), each with `confidence` and `source` set.
- [ ] `QuotaForecaster` in `packages/core` has 100 % branch coverage; property tests prove no `NaN`/`Infinity` in any output and monotonic time-to-limit.
- [ ] FakeProvider 429 (`resetAt` = +30 min) ⇒ provider `cooling` until `resetAt`, task rerouted with a persisted `RoutingDecision` whose reason is `rerouted: rate-limited`, Attention item raised, and ≤ 1 retry per task per window proven by `UT-M4-03-*` and a 50-task concurrency test.
- [ ] Reserve breach on FakeProvider emits `quota.reserve_breached`; engine golden test shows non-review tasks excluded from a provider whose remaining capacity is inside the review reserve.
- [ ] Lead handoff on simulated exhaustion completes in < 60 s: `PLAN.md` gains a `## Handoff` section, a new Lead session on the fallback provider is running with the same `missionId`, `lead_handoffs` row is `completed`, audit entries exist.
- [ ] Dry-run of a 10-task mission returns per-task provider/model/estimate, per-provider window impact and "will exhaust" warnings in < 2 s, persisted as `routing_decisions.dry_run = true`.
- [ ] Fleet screen shows windows, forecast bars, confidence chips, cooling badges and the four M4 KPIs; every displayed number has an official/estimate label (axe + visual TC).
- [ ] `kill -9` of the daemon while a provider is cooling: after restart the cooling state, windows and forecasts are restored from the DB and no second reroute is issued.
- [ ] All manual TCs in M4-01…M4-07 ✅; no new ESLint / dependency-cruiser violations; `no-vendor-endpoints` and egress tests green; CI touched no real account (C9).

## Steps

| ID | File | Title | Effort | Depends on |
|---|---|---|---|---|
| M4-01 | [step-01](step-01-quota-signals-and-windows.md) | Quota signals & windows | 2.5 d | M1-08, M2-03 |
| M4-02 | [step-02](step-02-quotaforecaster.md) | QuotaForecaster | 2 d | M4-01 |
| M4-03 | [step-03](step-03-rate-limit-cooling-and-reroute.md) | Rate-limit cooling & reroute | 2.5 d | M4-02, M2-04 |
| M4-04 | [step-04](step-04-budgets-and-reserves.md) | Budgets & reserves | 2 d | M4-02, M3-02 |
| M4-05 | [step-05](step-05-lead-handoff.md) | Lead handoff | 2 d | M4-04, M3-02 |
| M4-06 | [step-06](step-06-dry-run-simulation.md) | Dry-run simulation | 1.5 d | M4-02, M3-08 |
| M4-07 | [step-07](step-07-fleet-windows-forecast-ui-and-kpis.md) | Fleet windows/forecast UI & KPIs | 1.5 d | M4-02, M4-03, M4-04 |

## What you can test after this milestone

- Windows and burn rates for your real Claude Code and Codex accounts (and agy if opted in) in the Fleet screen, each number labelled official or estimate.
- A simulated 429 on FakeProvider: cooling badge with countdown, the task rerouted to another provider, the Attention item explaining why, exactly one retry.
- A naturally occurring real rate limit (never provoked): the same behaviour on a real adapter.
- Reserve warnings when a provider's remaining window drops inside the review or Lead reserve; the engine keeps that capacity for reviews / the Lead.
- Lead handoff: a mission whose Lead provider is exhausted continues under a different provider's Lead with a written handoff in `PLAN.md`.
- "Simulate" on a planned mission: which provider/model each task would get, the window impact per provider, and where a window would run out.
- Daemon restart resilience for all of the above.

## End-to-end demo script (real tools + FakeProvider)

Preconditions: M1–M3 accepted; `tmux` running; `claude` and `codex` logged in (`agy` optional with ToS ack); scratch repo `~/orchestra-scratch/`; `features.quota`, `features.budgets`, `features.leadHandoff`, `features.dryRun`, `features.devTools` all `true` in `~/.orchestra/config.yaml`.

1. Start the daemon (`pnpm --filter @orchestra/daemon dev`), open the web UI, go to **Fleet**. Every declared window shows "No signal yet" with no number (no fabricated limits).
2. Quick Delegate a small `quick` task to Claude Code (headless). When it finishes, Fleet shows the Claude 5-h window with `used` tokens, chip **estimate**, source `stream-json`, "updated n s ago". Repeat on Codex: window from app-server usage, chip **estimate**.
3. If agy is opted in, click **Refresh (official)** on the agy card: the daemon runs `agy -p "/usage"` (quota-free), and the card shows chip **official** with `resetAt`.
4. Run two or three more short tasks on Claude. The forecast bar appears: burn rate (tokens/h), projected exhaust time, level `ok`, all labelled **estimate**. `GET /fleet/forecasts` returns the same numbers.
5. **Simulated rate limit.** Quick Delegate a task to FakeProvider `fake-a` with scenario `rate-limit-429.yaml` (emits a 429 with `resetAt` = now + 30 min after its second tool call). Observe, in order: Fleet `fake-a` shows badge **cooling · resets in 29:xx · official**; Attention shows "fake-a rate-limited — task T rerouted to fake-b (rerouted: rate-limited)"; Board shows T running on `fake-b`; `GET /tasks/T/routing` lists two decisions, the second with reason `rerouted: rate-limited`; `GET /tasks/T/retries` shows exactly one entry for `(fake-a, 5h)`.
6. Start five more `fake-a` tasks from the same scenario at once. All five reroute; the retry ledger still shows ≤ 1 retry per task; `fake-a` receives zero new launches while cooling (check `sessions` for `fake-a` after the signal).
7. **Budgets.** In `workspace.yaml` set `policies.budgets.reviewReserve: [{ provider: fake-b, window: 5h, reservePct: 20 }]`. Run FakeProvider scenario `burn-to-85.yaml` on `fake-b`. Fleet shows the reserve shaded on the bar, then `quota.reserve_breached` and a warning; Quick Delegate preview for a non-review task now excludes `fake-b` with reason `reserve: review`. A `code-review` task still gets `fake-b`.
8. **Lead handoff.** Create a mission with playbook `bugfix`, Lead on FakeProvider `fake-lead` with scenario `lead-exhausted.yaml` (Lead plans, plan approved, then Lead emits exhaustion with `resetAt` = +2 h). Within 60 s: mission banner "Lead handoff in progress", `PLAN.md` in the mission worktree gains `## Handoff`, a new Lead session appears on `fake-b` (or real Codex if you set `leadHandoff.fallback`), Attention item "Lead handed off fake-lead → fake-b", `GET /missions/:id/handoffs` shows one `completed` row.
9. **Dry-run.** Plan a real mission (`new-feature-fullstack`) on Claude + Codex, do not start it. Click **Simulate** in Missions. The drawer lists each task with provider/model, estimated tokens/time (source `taxonomy-default` or `outcomes(n)`), window impact per provider and, if a window is projected to run out, "will exhaust codex weekly at task 7 (test-gen)". Every number is labelled **estimate**.
10. **Real rate limit, observed safely.** Do not provoke one (C5). When one occurs during normal work, verify: `quota.rate_limited` event with the vendor-reported `resetAt`, cooling badge, reroute decision, Attention item. Between occurrences, validate the real parsers by replaying recorded fixtures: `pnpm --filter @orchestra/daemon fixtures:replay claude exit/429.txt --session <running-session-id>` (dev-only, `features.devTools`, localhost). The daemon treats a replayed fixture exactly like a live signal.
11. **Restart.** While `fake-a` is still cooling, `kill -9` the daemon and restart it. Fleet shows the same cooling countdown, windows and forecasts; `events` contain no new `routing.rerouted` for already-rerouted tasks.

## Milestone risks

| Risk | Impact | Mitigation / where |
|---|---|---|
| Vendor usage fields differ from what 05 §3 summarises (R1, R6) | wrong `used` / no `resetAt` | every vendor fact re-verified at step start; fixtures pinned; anything unverified stays `estimate` (M4-01) |
| Claude `/usage` and Codex quota RPC only visible as PTY text | no official numbers for those providers | C7: not parsed; UI shows estimate + "open terminal for official figure" (M4-01, M4-07) |
| Retry storms across many tasks on one provider (C5) | vendor bans, wasted quota | retry ledger + cooling exclusion by construction; 50-task concurrency test (M4-03) |
| Forecast over-confidence on sparse samples | wrong pre-emptive reroutes | `sampleCount` gate, hysteresis, `unknown` level; conservative thresholds (M4-02) |
| Handoff loses Lead context | second Lead re-plans badly (R11) | handoff document is generated from DB, not from the old Lead; plan approval gate stays (M4-05) |
| Dry-run estimates far from reality | false exhaust warnings | estimates labelled with source and sample size; outcomes replace taxonomy defaults as history grows (M4-06, M8-06) |
| M4-05 / M4-06 wait on M3 steps although M4 is a parallel lane after M1 | schedule slip | do M4-01…04, 07 first; 05/06 last (see parallelization) |

## Parallelization notes

- Serial spine: **M4-01 → M4-02 → M4-03**. M4-03 also needs M2-04.
- After M4-02: **M4-04**, **M4-07** and (once M3-08 is ✅) **M4-06** can run in parallel with M4-03; they touch disjoint modules (`budgets/`, `apps/web/screens/fleet`, `simulation/`).
- **M4-05** is last (needs M4-04 and M3-02).
- Fixture recording of real 429s cannot be scheduled; record them opportunistically whenever a real rate limit occurs during M1–M3 work and keep them under `fixtures/<cliVersion>/`.
- Suggested order for one engineer: 01, 02, 07, 03, 04, 06, 05.

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
