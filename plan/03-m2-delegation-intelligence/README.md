# Milestone M2 — Delegation & intelligence

| Field | Value |
|---|---|
| Folder | `plan/03-m2-delegation-intelligence/` |
| Steps | 9 (M2-01 … M2-09) |
| Effort | 20 working days (sum of step estimates; optional work included) |
| Entry gate | M1-13 ✅ (MVP tag) — see "Entry criteria" for the two steps that may start earlier |
| Feature flags | `features.intelligence`, `features.mcpDelegation`, `features.board`, `features.chat` (all default `false` until M2 acceptance) |

## Goal

After M2 the platform stops being "terminals with a prompt inbox" and becomes an orchestrator: a typed task (`TaskType` from the catalog) is scored by a deterministic **Assignment Engine** against every installed provider/model, the user sees **why** a model was chosen (reasons, score, top-3 alternatives) and can override before anything spends quota, the task runs through the M1-12 execution path, and the result shows up on a **Board**. A **Lead** agent (any provider) gets the same power through an MCP server (`capabilities / delegate / status / collect / ask_user`) registered per Lead session. Manifests become complete (commands discovery, prompt protocol per kind, update sources), the model catalog ships with local overrides and a Models screen, and a **Chat** screen renders every session's conversation with a `/` command palette built from the manifest. Every routing decision is persisted in `routing_decisions` and inspectable in a decision log; a workspace YAML file can override routing per task type with hot reload.

## Why this milestone now

- D3 (two-tier orchestration) and D7 (intelligence as data) are unproven until an engine routes a real task on real CLIs. M1 proved the substrate (tmux, worktrees, adapters, prompt round-trips); M2 proves the decision layer on top of it without touching M0/M1 interfaces (D11).
- M3 (missions) and M4 (quota reroute) both consume `AssignmentEngine.decide()`; they cannot start without a stable `RoutingDecision` contract and the MCP delegation surface (M3-02 launches the Lead through M2-05).
- G2 ("right model for the job", ≥ 60 % of tasks off the top-tier model) is only measurable once decisions are logged (M2-09).
- C10 ("every spend action previewed, permissioned, audited") needs the preview dialog (M2-06/07) and the MCP audit path (M2-05) before Leads are allowed to delegate autonomously in M3.

## Entry criteria

| Requirement | Why |
|---|---|
| M1-13 ✅ (MVP acceptance, tag pushed) | all M2 steps except the two below assume real Claude Code + Codex sessions run from the web |
| M1-05, M1-06 ✅ (M1-07 only if the optional agy adapter is enabled) | M2-03 (manifests) may start as soon as the required adapters (claude, codex) and their fixtures exist; an enabled optional adapter adds its manifest to the same step |
| M1-11 ✅ | M2-08 (Chat) may start as soon as `AgentPrompt` + Attention components exist |
| M1-08 ✅ | `NormalizedEvent` stream feeds Chat (M2-08) and provider health for the engine (M2-04) |
| M0-08 CI gates green on `main` | coverage thresholds for `packages/core` (100 % branches) are extended to the engine |
| ENVIRONMENT.md updated with the installed Codex version | M2-03 pins `cliVersionRange` per provider |

## Exit criteria (measurable)

- [ ] `orch catalog validate` exits 0 on the shipped catalog; all 38 task types from `06-intelligence-layer.md §1` present; every `weights` block sums to 1.0 ± 0.001.
- [ ] ≥ 6 model profiles across the required adapters (claude, codex) load, plus any enabled optional adapter; a local override in `~/.orchestra/catalog-overrides/` is reflected in the Models screen within 2 s without daemon restart.
- [ ] `manifest.contract.spec.ts` + new `commands-discovery` and `prompt-protocol` contract specs pass for the required adapters (claude, codex) plus any enabled optional adapter, on the pinned CLI versions. The specs assert that each capability record is *present and well-formed* for its `provider + cliVersion + executionMode` key; they do not promote any capability to `verified` (only an M0-09 evidence-matrix row does that).
- [ ] `AssignmentEngine` has 100 % branch coverage; the golden suite reproduces every row of the default matrix (primary, fallback, reviewer) and every "provider unhealthy ⇒ fallback" variant.
- [ ] Quick Delegate v2 on real Claude Code and real Codex: preview → (optional override) → run → branch + diffstat; the persisted `routing_decisions` row matches what the dialog showed.
- [ ] A Claude Code Lead completes `capabilities → delegate → status → collect → ask_user` on real CLIs; every tool call appears in `audit_log` with `actor.kind = agent`.
- [ ] Board shows tasks from Quick Delegate and MCP delegations in the correct state column within 500 ms of the event; drag-to-reassign always shows a preview before any session starts.
- [ ] Chat renders a live conversation for Claude Code and Codex sessions; a `/` command from the manifest is sent through `PaneController.sendCommand` and acked on both providers.
- [ ] Editing `.orchestra/workspace.yaml#routing` changes the next preview within 2 s; the decision log shows the old and new decision with a "why this model" panel each.
- [ ] Daemon restart during M2 flows: every decision and task row survives, and every open `ask_user` request resolves to an explicit outcome (`answered | expired | cancelled`) with no duplicate delegation created (see M2-05 request-handle semantics).
- [ ] All TC-M2-* manual cases ✅; no new ESLint / dependency-cruiser violations; `PROGRESS.md` rows updated.

## Steps

| ID | File | Title | Effort | Depends on |
|---|---|---|---|---|
| M2-01 | [step-01](step-01-task-taxonomy-catalog.md) | Task taxonomy catalog | 2 d | M1-13 |
| M2-02 | [step-02](step-02-model-catalog-and-profiles-v1.md) | Model catalog & profiles v1 | 2.5 d | M2-01 |
| M2-03 | [step-03](step-03-capability-manifests-v1-full.md) | Capability manifests v1 (full) | 2.5 d | M1-05, M1-06 |
| M2-04 | [step-04](step-04-assignment-engine.md) | Assignment engine | 3 d | M2-02, M2-03 |
| M2-05 | [step-05](step-05-mcp-delegation-server.md) | MCP delegation server | 3 d | M2-04, M1-11 |
| M2-06 | [step-06](step-06-quick-delegate-v2.md) | Quick Delegate v2 | 1.5 d | M2-04, M1-12 |
| M2-07 | [step-07](step-07-board-kanban.md) | Board (kanban) | 2 d | M2-06 |
| M2-08 | [step-08](step-08-chat-screen.md) | Chat screen | 2.5 d | M1-11, M2-03 |
| M2-09 | [step-09](step-09-routing-policy-file-and-decision-log.md) | Routing policy file & decision log | 1 d | M2-04 |

## What you can test after this milestone

| Scenario | Where |
|---|---|
| Type a goal, pick `changelog`, see the engine propose agy Gemini Flash (or Claude Sonnet when agy is not opted in) with reasons and 3 alternatives; override to Codex; run; get a branch | Quick Delegate dialog (M2-06) |
| Same task with `codex` cooling (simulated via FakeProvider scenario or a policy `deny`) reroutes to the fallback with reason `excluded:provider-unhealthy` | Quick Delegate preview / decision log |
| Kanban of every task across providers; filter by provider; drag a `draft` card to another provider swimlane → preview → confirm | Board (M2-07) |
| Rendered conversation of a running Claude Code session; `/` palette shows native + workspace commands; a permission prompt appears inline and is answered from Chat | Chat (M2-08) |
| A Claude Code Lead calls `delegate` → a confirm prompt appears in Attention → approve → task runs on Codex → Lead `collect`s branch + diffstat; Lead `ask_user` shows a question in Attention and Chat | Terminals + Attention + Board (M2-05) |
| Break a taxonomy YAML (weights sum 1.2) → `catalog.invalid` event, Fleet health warning, last-known-good stays active | `orch catalog validate`, Fleet (M2-01) |
| Mark a model deprecated via local override → Models screen badge; engine excludes it with reason `excluded:deprecated` | Models (M2-02), preview (M2-04) |
| Add a workspace routing override → next preview obeys it; decision log shows `policy-primary (workspace)` | workspace.yaml, decision log (M2-09) |

## Demo script (run end-to-end on real tools)

Preconditions: M1-13 demo passes; `claude` and `codex` logged in; `agy` opted in with ToS acknowledged (optional); scratch repo `~/orchestra-scratch/`; feature flags `intelligence`, `mcpDelegation`, `board`, `chat` set to `true` in `~/.orchestra/config.yaml`.

1. `orch catalog validate` → prints `taxonomy: 38 task types OK · models: N profiles OK · routing: default matrix OK`, exit 0.
2. Open **Models** → filter provider `claude` → open `claude/opus` → radar shows 6 dimensions, evidence list, validity. Copy any shipped profile (`packages/catalog/models/claude/sonnet.yaml`, or the optional `agy/gemini-flash.yaml` when agy is enabled) into the matching path under `~/.orchestra/catalog-overrides/models/`, set `validTo: 2026-01-01` → within 2 s the row shows a *deprecated* badge and *local* source.
3. Open **Board** (empty) and **Attention** in a second tab.
4. **Quick Delegate**: goal "Add a `## Unreleased` section to CHANGELOG.md with today's date", task type `changelog` → **Assign** → preview: chosen `claude/sonnet` (agy Flash excluded with `excluded:deprecated`), score, reasons, alternatives (`codex/…`, `claude/opus`) → **Delegate** → Board card appears in `assigned`, then `running`, then `done` with branch + diffstat.
5. Delete the override file → Models badge disappears; repeat step 4 preview → the default-matrix primary for `changelog` is chosen again with reason `policy-primary (default)` (that is the optional `agy/gemini-flash` only when agy is enabled; otherwise the claude/codex primary). Cancel without running.
6. **Chat**: open the Claude Code session from step 4 (or start an interactive one from Fleet) → conversation renders; type `/` → palette lists manifest commands plus a workspace custom command placed in the workspace commands dir; send one → composer shows *acked*. Trigger a permission prompt (ask the agent to run `ls`) → prompt renders inline → answer → agent continues.
7. **MCP**: from Fleet start an interactive Claude Code session with role *Lead* → in its pane type: "Use the orchestra MCP tools: call capabilities, then delegate a `test-gen` task for `src/date.ts` with goal 'unit tests for formatDate', then poll status until done and collect the result." → Attention shows *Lead requests delegation → codex/gpt-5-codex (score 0.81)* → Approve → Board shows the task on Codex → when done the Lead prints the branch and diffstat. Then ask the Lead to "ask the user which test runner to use" → question appears in Attention and in the Lead's Chat → answer "vitest" → Lead echoes it.
8. **Routing policy**: append to `~/orchestra-scratch/.orchestra/workspace.yaml`: `routing: { taskTypes: { test-gen: { primary: [claude/sonnet] } } }` → repeat a `test-gen` preview → chosen `claude/sonnet`, reason `policy-primary (workspace)`. Open **Models → Decisions** → both `test-gen` decisions listed; open the older one → "why this model" shows the default-matrix reasons.
9. **Resilience**: while a Lead `ask_user` is open, `kill -9` the daemon, restart it → the request row and its `requestId` survive; the question is still in Attention; answer it → the Lead's re-call of `ask_user` with the same `requestId` returns `{ state: 'answered', answer }` (no second question is created, no duplicate Attention item). If nobody answers within the request's `expiresAt`, the re-call returns `{ state: 'expired' }` and the Lead is told to proceed or re-ask. Board and Chat reconnect without reload.
10. `pnpm test` + `pnpm lint` + `pnpm depcruise` green; tag `m2-acceptance`.

## Milestone risks

| Risk | Impact | Mitigation |
|---|---|---|
| Model ids / labels in profiles and the default matrix drift from what the adapters report in `manifest.models` | engine excludes candidates silently | catalog validation cross-checks profile ids against manifests (M2-02); unmatched profiles are a validation warning, unmatched manifest models get a synthesized minimal profile with `source: synthesized` |
| MCP tasks extension / elicitation semantics differ from the spec revision assumed here | `ask_user` or long `delegate` misbehave on a real Lead | M2-05 ships the deterministic `AttentionAskStrategy` (tool-return) as default; elicitation and tasks extension are opt-in behind flags and marked *(verify)* |
| Codex `app-server` is experimental (R3) — `/` commands over RPC may lack a stable ack | Chat palette ack timeouts on Codex | manifest marks such commands `ackEvent: none` → UI shows *sent (no ack available)*; contract test pins schema |
| Profiles tuned to reproduce the default matrix are opinion, not evidence | wrong routing until M8-06 learning loop | matrix shipped as *policy data*; scoring is tie-break + fallback; every decision explains which source won |
| Scope creep into missions (R10) | M2 slips | plan cards are read-only, `collect` returns the M1-12 result shape only; mission lifecycle stays in M3 |
| Board/Chat rendering with hundreds of tasks / thousands of messages | UX budgets (12-ux-principles) blown | virtualized lists, WS snapshot+delta, perf tests in M2-07/08 |

## Parallelization

```
Lane A (catalog → engine):   M2-01 → M2-02 → M2-04 → M2-06 → M2-07
                                               └────→ M2-09
Lane B (providers):          M2-03 (starts after M1-05..07; must finish before M2-04)
Lane C (delegation plane):   M2-05 (after M2-04 + M1-11)   — can overlap with M2-06/07
Lane D (UI):                 M2-08 (after M1-11; palette upgraded when M2-03 lands)
```

- One engineer: A then B is the critical path (≈ 7.5 d to M2-04). Do M2-03 while M2-02's Models screen is being polished; do M2-08 while waiting on real-CLI manual tests of M2-05.
- Shared files to watch for conflicts: `packages/core/src/intelligence/*` (M2-01, M2-02, M2-04), `apps/daemon/src/interface/http/routing.controller.ts` (M2-04, M2-06, M2-09), `apps/web/src/features/routing/*` (M2-06, M2-07, M2-09).

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
