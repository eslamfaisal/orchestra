# Step M3-08 — Missions screen

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-04 |
| Estimated effort | 3 days |
| Packages touched | `apps/web` (screens/missions), `packages/ui`, `apps/daemon` (interface/http, interface/ws, application/missions) |
| Risk | Medium |
| Owner | |

## 1. Goal
The **Missions** screen (IA position 4) replaces the M3-02 placeholder list with the operational view of a mission: a DAG of its tasks with live state, each node showing the assigned provider/model **and the reason it was chosen** (from `routing_decisions`), review rounds with verdicts and reviewer vendor, accumulated cost/usage per task and per mission, and per-task **Cancel** / **Retry** actions plus mission-level Cancel. A details pane shows the plan (`PLAN.md` version N) and the mission's event stream. A **Simulate** button is rendered disabled with its wiring point documented — M4-06 fills it in. After this step, a user who started a mission can answer "what is running, on what, why, how far, and what did it cost" without opening a terminal or the database.

## 2. Why
- `12-ux-principles.md` lists Missions as shipping in M3-08 with "plan, DAG, assignments + reasons, review rounds, cost, simulate"; it is the screen that makes D3 (two-tier orchestration) legible — the human sees the Lead's decomposition and the engine's assignments side by side.
- G2 is only credible if the "why this model" reasons are visible per task, not buried in `routing_decisions` (M2-09 built the panel; this screen is where it belongs for mission tasks).
- G3: review rounds and reviewer vendor per node are how cross-vendor review becomes an observable property rather than a claim.
- UX principle 1 (attention over information): the DAG must make the *blocking* node obvious — the node waiting on a human, a gate, or a failed review.
- UX principle 4: every cost number is labelled `official` or `estimate` (usage confidence from M3-03).
- R11: a Lead that loops or over-decomposes is visible here (round counts, task count, cost curve) and cancellable in one click.

## 3. Scope
### In scope
- Missions list: title, playbook, state, progress (`n/m` tasks done), cost estimate, PR badge (M3-06), created/updated.
- Mission detail: header (state, integration branch, Lead session link, budget), DAG canvas, task inspector drawer, plan tab, events tab.
- DAG view: nodes = tasks, edges = `depends_on`; node content = title, taskType, provider/model badge, state chip, round chip, verdict; layout = deterministic layered (Sugiyama-lite) top-down.
- Rendering decision: `react-flow` if bundle + RTL + reduced-motion checks pass, else a custom SVG renderer in `packages/ui` (the layout algorithm lives in `packages/ui` either way so it is testable headlessly).
- "Why this model" popover per node from `routing_decisions` (score, reasons, top-3 alternatives).
- Per-task actions: Cancel, Retry, Open in Review (deep link, M3-05), Open terminal (M1-09), Collect result.
- Mission actions: Cancel mission, Open PR (M3-06), Resume blocked task, Simulate (disabled placeholder).
- Cost/usage roll-up with confidence labelling and a per-provider breakdown.
- Live updates over the existing `mission.<id>` / `task.<id>` WS topics.
### Out of scope (deferred to …)
- Dry-run window-impact simulation behind the Simulate button — deferred to M4-06 (this step only ships the button, the route and the empty modal).
- Budget bars and reserve breach warnings — deferred to M4-04 (cost is displayed, not enforced).
- Editing the DAG by hand (add/remove/re-order tasks after approval) — deferred to M8-07 (playbook editor) / a later step; the plan is edited at approval time (M3-02).
- Timeline scrubber and recording replay from a node — deferred to M5-04 (a "Replay" affordance is stubbed behind a feature flag).
- Mission templates / scheduling / triggers — deferred to M9-07.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain entities. Two pure view-model rules, placed in `packages/ui/src/dag/` so they are unit-testable without a browser:
- `layoutDag(nodes, edges) → { nodes: PositionedNode[]; edges: RoutedEdge[]; layers: number }` — deterministic layered layout: longest-path layering, barycentre ordering within a layer, fixed node size, stable tie-breaking by task `order` then `id` (so the same mission always draws the same shape).
- `criticalPath(nodes, edges) → taskId[]` and `blockingNodes(nodes) → taskId[]` — a node is *blocking* when its state is `blocked`, `changes_requested` past `maxRounds`, or `approved` awaiting a `human` gate. The header summarises: "waiting on you: 1 · running: 2 · queued: 3".
- A cycle in the persisted DAG is impossible (validated in M3-01/M3-02), but the layout function still returns `Result.err(DagCycle)` rather than looping forever — defensive, tested with a fabricated cycle.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/interface/http/dto/mission-graph.dto.ts  (Zod-validated response)
export interface MissionGraphResponse {
  mission: { id: string; title: string; state: MissionState; playbook: { id: string; version: string };
             integrationBranch: string; leadSessionId?: string; planVersion: number;
             prUrl?: string; prState?: string; createdAt: string; updatedAt: string };
  totals: { tasks: number; done: number; running: number; queued: number; blocked: number;
            costEstimateUsd?: number; confidence: 'official' | 'estimate' | 'mixed';
            byProvider: { provider: ProviderId; tasks: number; costEstimateUsd?: number }[] };
  nodes: MissionGraphNode[];
  edges: { from: string; to: string }[];          // taskId → taskId
}
export interface MissionGraphNode {
  taskId: string; planTaskId?: string; stepId?: string; title: string; taskType: TaskType; role: RoleName;
  state: TaskState; verdict?: TaskVerdict;
  assignment?: { provider: ProviderId; model: ModelId; score: number; reasons: string[];
                 alternatives: { provider: ProviderId; model: ModelId; score: number }[] };
  reviews: { round: number; mode: 'primary'|'secondary'; reviewer: { provider: ProviderId; model: ModelId };
             verdict: ReviewVerdict | null; degraded: boolean; openFindings: number }[];
  roundsUsed: number; maxRounds: number;
  usage?: { costEstimateUsd?: number; wallClockMs: number; confidence: 'official' | 'estimate' };
  sessionId?: string; worktreeBranch?: string; isolation?: { port?: number; dbSuffix?: string };
  blockedReason?: string; gate: Gate; gateSatisfied: boolean;
}

// packages/ui/src/dag/types.ts
export interface PositionedNode { id: string; x: number; y: number; w: number; h: number; layer: number; }
export interface RoutedEdge { from: string; to: string; points: { x: number; y: number }[]; }
```
The response is assembled by one read-model query (`MissionGraphQuery`) joining `missions`, `tasks`, `task_results`, `reviews`, `routing_decisions`, `worktrees` — a read model, not a use case, so it lives in `application/missions/queries/` and returns a DTO directly.

### 4.3 Data / schema changes
- None. This step is a read model over M3-02..M3-07 tables plus `routing_decisions` (M2-04/M2-09).
- One index for performance: migration `m3_08_indexes` adds `idx_tasks_mission_id` on `tasks(mission_id)`, `idx_reviews_task_id` on `reviews(task_id)`, `idx_routing_task_id` on `routing_decisions(task_id)`.
- Events consumed only (`mission.*`, `task.*`, `review.*`, `routing.*`, `isolation.*`); none emitted except `audit.*` for the cancel/retry mutations, which already exist.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No new infrastructure. The screen uses existing endpoints and WS topics; cancel/retry call the M3-03 use cases; "Open terminal" deep-links to the M1-09 grid filtered to the task's pane.
- Snapshot + delta protocol per `03-architecture.md §5`: initial `GET /missions/:id/graph`, then `mission.<id>` and `task.<id>` deltas patch the store (Zustand). A missed-sequence gap triggers a re-snapshot.

### 4.5 API / UI surface
- `GET /missions?state=&limit=&cursor=` → list rows (adds `totals` per mission).
- `GET /missions/:id/graph` → `MissionGraphResponse`.
- `GET /missions/:id/events?after=` → paged event stream for the events tab.
- `POST /missions/:id/cancel` (exists, M3-02), `POST /tasks/:id/cancel`, `POST /tasks/:id/retry` (exist, M3-03) — surfaced here with a confirm dialog that states what will be stopped (C10).
- `POST /missions/:id/simulate` → `501 NotImplemented { ships: 'M4-06' }` (route reserved so the UI wiring is final).
- WS topics reused: `missions`, `mission.<id>`, `task.<id>`, `review.<id>`.
- **UI components** (`apps/web/src/screens/missions/`):
  | Component | States |
  |---|---|
  | `MissionsList` | loading · empty ("no missions yet — start one") · rows · filtered by state |
  | `MissionHeader` | state chip, progress ring, cost with confidence label, integration branch (copy), PR badge, actions menu |
  | `MissionDag` | loading skeleton · laid out · pan/zoom · fit-to-view · focus node (deep link `?task=`) · cycle error (defensive) · reduced-motion (no transitions) |
  | `DagNode` | queued · running (pulse, suppressed under `prefers-reduced-motion`) · review_pending · in_review (round chip) · changes_requested · approved · merged · failed · blocked (badge "waiting on you") · cancelled |
  | `WhyThisModelPopover` | score, ordered reasons, top-3 alternatives, link to the decision log (M2-09) |
  | `TaskInspector` | spec · result (diffstat, tests) · reviews (rounds, findings count, degraded badge) · isolation (port, suffix) · actions (Review, Terminal, Retry, Cancel, Collect) |
  | `PlanTab` | rendered `PLAN.md` v N with a version selector |
  | `EventsTab` | virtualised event list with correlation filters |
  | `SimulateButton` | disabled with tooltip "window-impact simulation ships in M4-06" |
- Accessibility: the DAG has an equivalent **list view** toggle (same data, keyboard navigable, screen-reader friendly) — the canvas is never the only way to reach a node. Status by shape + text, never colour alone. RTL: the DAG flows top-down (direction-neutral); labels and panels mirror.

### 4.6 Flow / sequence
```
open /missions ─ GET /missions ─▶ rows  (WS `missions` keeps states live)
open /missions/:id ─ GET /missions/:id/graph ─▶ MissionGraphResponse
   └─ layoutDag(nodes, edges) [pure, in packages/ui] ─▶ PositionedNode[] + RoutedEdge[]
WS mission.<id> / task.<id> / review.<id> deltas ─▶ patch store ─▶ re-render node only (no relayout unless nodes/edges change)
click node ─▶ TaskInspector (data already in the graph response; result/diff fetched lazily)
hover provider badge ─▶ WhyThisModelPopover (routing_decisions reasons + alternatives)
click Retry ─▶ confirm ("this starts a new session on <provider/model> and spends quota") ─▶ POST /tasks/:id/retry ─▶ node returns to running
click Cancel (task) ─▶ confirm ─▶ POST /tasks/:id/cancel ─▶ session stopped, result collected with verdict failed (M3-03)
click Cancel (mission) ─▶ confirm listing every running session ─▶ POST /missions/:id/cancel ─▶ all panes stopped, leases released (M3-07)
click Simulate ─▶ modal "ships in M4-06" (route returns 501)
```

## 5. Tasks
- [ ] `layoutDag`, `criticalPath`, `blockingNodes` in `packages/ui/src/dag/` (pure, unit-tested, deterministic).
- [ ] Decide `react-flow` vs custom SVG against bundle budget + RTL + reduced-motion; record the outcome in the log.
- [ ] `MissionGraphQuery` read model + DTO + Zod response schema; migration `m3_08_indexes`.
- [ ] `GET /missions/:id/graph`, `GET /missions/:id/events`, list `totals`; reserve `POST /missions/:id/simulate` → 501.
- [ ] WS delta handling in the web store with snapshot re-fetch on sequence gap.
- [ ] `MissionsList` + filters + empty state.
- [ ] `MissionHeader` with progress, cost (confidence label), branch, PR badge, actions menu.
- [ ] `MissionDag` canvas: pan/zoom, fit-to-view, deep-link focus, reduced-motion path.
- [ ] `DagNode` with all ten states, round chip, degraded badge, provider/model badge.
- [ ] **List view** toggle with full keyboard navigation and equivalent actions (accessibility requirement).
- [ ] `WhyThisModelPopover` fed from `routing_decisions`.
- [ ] `TaskInspector` drawer reusing the M3-03 result components and M3-04 findings summary.
- [ ] `PlanTab` (version selector) and `EventsTab` (virtualised).
- [ ] Confirm dialogs for Retry / Cancel stating quota impact (C10) and what will be stopped.
- [ ] ⌘K actions: "Open mission", "Cancel mission", "Retry task", "Go to blocking task".
- [ ] Perf: 40-node mission lays out and renders within the M0-07 interaction budget; virtualise or simplify nodes at > 60 nodes.
- [ ] Playwright E2E over a FakeProvider mission fixture covering every node state.
- [ ] Docs: Missions screen page; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-08-01 | unit | `layoutDag` on the `new-feature-fullstack` shape (diamond + fan-out) | stable layers; no node overlap; identical output across 100 runs (determinism) |
| UT-M3-08-02 | unit | `layoutDag` on a fabricated cycle | `Result.err(DagCycle)`, no infinite loop, returns within 50 ms |
| UT-M3-08-03 | unit | `blockingNodes` with a human gate, an escalated review, a failed task | exactly those three ids, ordered by task order |
| UT-M3-08-04 | unit | `criticalPath` on a 12-node DAG with known longest path | matches the expected id sequence |
| AT-M3-08-01 | application | `MissionGraphQuery` for a mission with 3 tasks, 2 reviews, 1 degraded | one query round-trip per table (no N+1); degraded flag and reasons present; totals match the rows |
| AT-M3-08-02 | application | graph for a mission where a task has no `routing_decisions` row (manual override) | `assignment` present with `reasons: ['manual override']`, no crash |
| IT-M3-08-01 | integration | WS deltas: task goes running → review_pending → approved | three patches applied without a re-snapshot; layout not recomputed (node set unchanged) |
| E2E-M3-08-01 | e2e (Playwright) | FakeProvider mission fixture with all node states | every state chip renders with text (asserted by accessible name); blocking node highlighted; header counts correct |
| E2E-M3-08-02 | e2e (Playwright) | Retry from the inspector | confirm dialog names the provider/model and quota impact; after confirm the node returns to `running` |
| E2E-M3-08-03 | e2e (Playwright) | list-view toggle keyboard path | every node reachable by Tab/arrow keys; the same actions available; no canvas required |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-08-01 | Live DAG of a real mission | 1. Start a `new-feature-fullstack` mission on the scratch repo 2. Open **Missions** → the mission | DAG matches the approved plan; running nodes update within 500 ms of the event; provider/model badges are correct per node | ⬜ |
| TC-M3-08-02 | Why this model | 1. Hover/click a node's provider badge | Popover shows score, ordered reasons (e.g. `capabilityFit 0.82 · costEfficiency preferred tier 2 · constraint:cross-vendor`) and 3 alternatives; matches `routing_decisions` in the DB | ⬜ |
| TC-M3-08-03 | Review rounds visible | 1. Let a task go through a `changes_requested` round | Node shows `round 2/2` and the reviewer's vendor badge; inspector lists findings count and verdict per round | ⬜ |
| TC-M3-08-04 | Blocking node obvious | 1. Let a task reach a `human` gate | Header says "waiting on you: 1"; that node is visually and textually flagged; ⌘K "Go to blocking task" focuses it | ⬜ |
| TC-M3-08-05 | Cost roll-up with confidence | 1. Open a mission with tasks on two providers | Per-provider breakdown sums to the mission total; every number carries `official`/`estimate`/`mixed`; a provider without usage data shows "estimate" and not a fake 0 | ⬜ |
| TC-M3-08-06 | Cancel one task (negative path) | 1. Cancel a running task from the inspector | Confirm dialog names the session and pane; after confirm the pane stops, the result is collected with verdict `failed`, the port lease is released, and dependents show `queued (blocked)` | ⬜ |
| TC-M3-08-07 | Retry a failed task | 1. Retry a `tests_failed` task | New attempt starts on the same provider/model; node returns to running; the previous attempt is still visible in the inspector | ⬜ |
| TC-M3-08-08 | Cancel the mission | 1. Cancel a mission with 2 running tasks | Dialog lists both sessions; after confirm both panes stop, all leases release, mission state `cancelled`, Lead session stopped | ⬜ |
| TC-M3-08-09 | Simulate placeholder | 1. Click *Simulate* | Disabled control with tooltip naming M4-06; if invoked via the API it returns 501 with `{ships: 'M4-06'}`; nothing is started | ⬜ |
| TC-M3-08-10 | Large mission perf | 1. Generate a 40-task mission fixture 2. Open it | Layout + first paint within the M0-07 interaction budget; pan/zoom stays smooth; memory within the web budget | ⬜ |
| TC-M3-08-11 | RTL + reduced motion + a11y | 1. Switch to Arabic 2. Enable `prefers-reduced-motion` 3. Navigate with the keyboard in list view | Panels mirror, DAG remains readable, no pulsing animation, every node and action reachable by keyboard with an accessible name | ⬜ |
| TC-M3-08-12 | Restart while viewing (resilience) | 1. Keep the mission open 2. `kill -9` the daemon 3. Restart | UI shows disconnected, then re-snapshots on reconnect; node states match reality (agents kept running in tmux); no stale "running" node for a stopped session | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] A mission's full shape — tasks, dependencies, assignments with reasons, review rounds, cost — is visible without touching the database or a terminal (TC-M3-08-01..05).
- [ ] The blocking node is identified in text in the header and focusable in one keystroke (TC-M3-08-04).
- [ ] `layoutDag` is deterministic, cycle-safe and 100 % covered on its branches (UT-M3-08-01, -02).
- [ ] Cancel and Retry are preview-confirmed with their quota impact and are audited (TC-M3-08-06, -07, -08; C10).
- [ ] Cost is always confidence-labelled; a provider without usage never displays a fabricated number (TC-M3-08-05).
- [ ] A keyboard-only, screen-reader-usable list view offers the same data and actions as the canvas (E2E-M3-08-03, TC-M3-08-11).
- [ ] The Simulate route and button exist, do nothing, and name M4-06 (TC-M3-08-09).
- [ ] 40-node mission meets the M0-07 interaction budget (TC-M3-08-10).
- [ ] All TC-M3-08-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations; `apps/web` imports only `packages/ui` + `packages/sdk` types.

## 8. Risks / open questions
- `react-flow` brings a sizeable bundle and its own interaction model; if it fails the RTL or reduced-motion checks, the custom SVG renderer is the fallback. Decide early — a late swap costs a day.
- Deterministic layout matters more than pretty layout: a mission whose DAG re-arranges on every poll is unusable. The barycentre pass must have fixed tie-breaking, asserted by UT-M3-08-01.
- Cost per task depends on provider usage reporting, which is partial (M3-03). Showing `mixed` confidence for a mission is honest but may read as vague; revisit the wording with M4-07's KPI labels.
- The graph response can get large for 40+ node missions with many findings; if it exceeds ~300 KB, split findings out into the lazily loaded inspector fetch.
- Editing a DAG after approval is a real user need (drop a task, add one) but it conflicts with the frozen `TaskSpec` model (M3-03); deliberately deferred rather than half-built here.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
