# Step M2-07 — Board (kanban)

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-06 |
| Estimated effort | 2 days |
| Packages touched | `apps/web`, `packages/ui`, `apps/daemon` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step the **Board** screen shows every task on the host as a card in a column matching its state from the `Task` state machine (`04-domain-model.md §2`), regardless of which surface created it (Quick Delegate, `orch delegate`, or a Lead's MCP `delegate`). Cards carry provider · model · task type · worktree/branch · state · elapsed time and link to the session, the terminal, the decision and the result. The board updates live over WS within 500 ms of the underlying event, can be filtered by mission, provider, state, task type and free text, can be grouped by state or swim-laned by provider, and supports **drag to reassign**: dropping a not-yet-running card on another provider's lane opens the routing preview and applies only after confirmation (C10).

## 2. Why
- G1 ("see and control every agent in one place"): Terminals (M1-09) show *processes*; the Board shows *work*. It is the first screen where cross-provider parallelism is legible.
- G2: the board is where "this chore is on the cheap model and the refactor is on the top model" becomes visible at a glance; provider swimlanes make the KPI physical.
- C10: reassignment spends quota on a different vendor, so it is previewed and audited exactly like a first assignment — the same `RoutingPreview` component from M2-06.
- D3: the Board is the human view of engine output; every card can answer "why here, why this model" by linking into the decision log (M2-09).
- UX principles 2 (calm density) and 3 (keyboard-first): many cards, low noise, full keyboard operation including reassignment without a mouse.

## 3. Scope
### In scope
- `GET /api/tasks` (filter + cursor pagination) and WS topic `tasks` (snapshot + delta) in the daemon.
- Board screen: columns from the `Task` state machine, optional provider swimlanes, virtualized lists, sticky column headers with counts.
- `TaskCard` in `packages/ui` with compact/expanded density and full keyboard semantics.
- Filters (mission, provider, model, task type, state, text) persisted in the URL query string; saved as the user's last view in local storage.
- Drag-to-reassign (pointer + keyboard) with the M2-06 preview; card menu equivalents: Reassign…, Open terminal, Open chat, Open decision, Cancel task.
- Cancel for `draft | assigned | running` (calls the M1-12 stop path); retry for `failed` re-opens the preview.
- Perf: 300 cards at 60 fps; delta patch, never full refetch on every event.
### Out of scope (deferred to …)
- Mission DAG view, dependencies between tasks, plan approval → M3-08.
- Review columns actually populated (`review_pending`, `in_review`, `changes_requested`, `approved`, `merging`) → M3-04/M3-05; in M2 they render but stay empty except via manual state changes in tests.
- Cost and budget per card → M4-04/M4-07.
- Bulk actions across cards (multi-select reassign) → M8-02.
- Board across multiple hosts → M7-05.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain types; the Board is a read model plus one guarded mutation.
- **Column set** is exactly the `Task` states: `draft · assigned · running · review_pending · in_review · changes_requested · approved · merging · done`, with `blocked · cancelled · failed` rendered in a collapsible "Not active" group (never hidden entirely — a failed task must be findable).
- **Reassign rule**: allowed only while the task is in `draft | assigned | blocked | failed`. A `running` task must be stopped first (explicit two-step: Cancel → Retry), because reassigning a live agent would orphan a worktree and a tmux pane. Dropping onto a lane while `running` is refused at the drop target (`aria-disabled`, tooltip "stop the task first").
- **Drag never transitions state**: dropping a card into a different *state* column is not allowed in M2 (the state machine is owned by the daemon, not the UI). Only provider-lane drops mean anything; state columns are drop-inert with an explanatory tooltip. This is deliberate — it keeps `04 §2` the single source of truth.
- **Reassign = re-decide, not re-label**: the daemon runs the engine again with `preferRef` = the target provider's best model and the previous assignment excluded; the result may still be refused (`OverrideRejected`) when a hard gate applies (C5, C6, C11, cross-vendor review).
- Cancel rules mirror M1-12: `draft` cancels immediately; `assigned` releases the reservation; `running` stops the session and keeps the worktree (removal is the M5-06/M3 cleanup path).

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/interface/http/dto/task-list.dto.ts
export const TaskListQuery = z.object({
  state: z.array(z.string()).optional(), provider: z.array(z.string()).optional(),
  taskType: z.array(z.string()).optional(), missionId: z.string().optional(),
  q: z.string().max(200).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(100),
});
export interface TaskCardDto {
  id: TaskId; title: string;                       // goal, first line, trimmed
  taskTypeId: TaskTypeId; taskTypeLabel: string; risk: RiskLevel;
  state: TaskState; origin: 'ui' | 'cli' | 'mcp'; missionId: string | null;
  assigned: { ref: ModelRefString; providerId: ProviderId; modelLabel: string; costTier: 1|2|3|4|5 } | null;
  decisionId: DecisionId | null; score: number | null; topReason: ReasonCode | null;
  sessionId: SessionId | null; paneRef: string | null;
  worktree: { branch: string; path: string } | null;
  result: { branch: string; files: number; insertions: number; deletions: number; testsPassed: boolean | null } | null;
  openPromptCount: number;                          // badge → Attention (M1-11)
  startedAt: string | null; updatedAt: string; elapsedMs: number | null;
}

// apps/web/src/features/board/board.store.ts  (Zustand; WS snapshot + delta)
export interface BoardState {
  cards: ReadonlyMap<TaskId, TaskCardDto>;
  filters: BoardFilters; grouping: 'state' | 'state+provider';
  applyDelta(ev: TaskEvent): void;                  // idempotent by (taskId, updatedAt)
}

// apps/daemon/src/application/tasks/reassign-task.use-case.ts
export class ReassignTask {
  execute(cmd: { taskId: TaskId; targetProvider?: ProviderId; targetRef?: ModelRefString; decisionId?: DecisionId; actor: Actor }):
    Promise<Result<{ decisionId: DecisionId; taskId: TaskId }, TaskNotReassignable | StaleDecision | OverrideRejected | NoEligibleCandidate>>;
}
```

### 4.3 Data / schema changes
No new tables. Migration `m2_07_tasks_board_index`: index `tasks(state, updated_at DESC)` and `tasks(assigned_provider, state)` for the list query; `tasks.updated_at TEXT NOT NULL` added if M1-12 did not create it (guarded). Events consumed (all existing, `04 §3`): `task.created|assigned|started|progress|result_submitted|failed|merged`, `routing.decided`, `session.launched|stopped|crashed`, `prompt.opened|answered`. One new event for the reassignment audit trail: `routing.rerouted {taskId, from, to, decisionId, actorKind}` — the same type M4-03 will emit for automatic reroutes, so the decision log (M2-09) and the timeline (M5-04) need no second code path. Audit row `action: 'task.reassign'` with before/after `{ref}`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No new infrastructure. Reassign reuses: `ReassignTask` → `PreviewAssignment`/`DecideAssignment` (M2-04) → for `draft|assigned` simply rewrites the assignment; for `blocked|failed` re-runs the M1-12 path (new worktree only if the previous one was removed — otherwise the existing branch is reused so work is not lost).
- WS delivery uses the existing gateway (M0-06): the `tasks` topic sends a snapshot on subscribe (filtered server-side to the requested query) then per-event deltas. Backpressure: if a client falls behind by more than 200 deltas the server sends a fresh snapshot and a `resync` marker.

### 4.5 API / UI surface
- `GET /api/tasks?...` (list, cursor), `GET /api/tasks/:id` (detail drawer from M2-06), `POST /api/tasks/:id/reassign/preview`, `POST /api/tasks/:id/reassign`, `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/retry`.
- WS topic `tasks` with `{type:'snapshot'|'delta'|'resync', ...}`.
- Board screen (`apps/web/src/features/board/`): `BoardScreen`, `BoardColumn`, `BoardSwimlane`, `TaskCard`, `BoardFilterBar`, `ReassignDialog` (wraps `RoutingPreview` from M2-06).
- Card anatomy (top → bottom): state pip + label · goal title (2 lines, ellipsis) · task-type chip + risk marker · provider·model badge with cost tier · branch name (monospace, copyable) · footer row: elapsed, open-prompt badge, result diffstat when done, overflow menu. Never colour-only: every state has a distinct pip shape **and** a text label.
- States of the screen: `loading` (skeleton columns), `empty` ("No tasks yet — ⌘K → Quick Delegate"), `populated`, `filtered-empty` (with "clear filters"), `disconnected` (banner, cards frozen, auto-resubscribe), `error`.
- Keyboard: `←/→` between columns, `↑/↓` within a column, `Enter` opens the detail drawer, `t` opens terminal, `c` opens chat, `r` opens Reassign…, `x` cancel (with confirm), `/` focuses the filter box. Drag has a keyboard equivalent: `r` → provider list → `Enter` → preview.
- Accessibility: columns are labelled lists with `aria-live="polite"` count announcements (coalesced, ≤ 1 announcement / 2 s); drag-and-drop uses a library with keyboard + screen-reader support and an explicit "grabbed / dropped on <lane>" announcement; `prefers-reduced-motion` disables card transitions; RTL flips column order via logical properties.

### 4.6 Flow / sequence
```
open Board ─▶ GET /api/tasks?filters ─▶ cards ─▶ WS subscribe `tasks`(filters) ─▶ snapshot ─▶ deltas
task.* / routing.* / session.* event ─▶ delta ─▶ store.applyDelta (idempotent by updatedAt) ─▶ card moves column
                                                   └─ column counts + aria-live announcement (coalesced)

drag card (draft|assigned|blocked|failed) onto provider lane "codex"
   ─▶ POST /api/tasks/:id/reassign/preview {targetProvider:'codex'}
        └─ AssignmentEngine.decide(task, candidates, policy, exclude=currentRef, prefer=codex/*)
             ├─ Ok  ─▶ ReassignDialog(RoutingPreview: from → to, score, reasons, alternatives)
             │         └─ Confirm ─▶ POST /api/tasks/:id/reassign {decisionId}
             │              ├─ StaleDecision ─▶ re-preview with banner
             │              ├─ OverrideRejected(hard gate) ─▶ inline error, card snaps back
             │              └─ Ok ─▶ routing.decided + routing.rerouted + audit ─▶ task.assigned
             │                      └─ (failed|blocked) ─▶ M1-12 execution path restarts on the new provider
             └─ Err NoEligibleCandidate ─▶ dialog shows excluded table; card snaps back, nothing spent
running card dropped on a lane ─▶ drop target refuses ─▶ tooltip "stop the task first" (no request sent)
```

## 5. Tasks
- [ ] `GET /api/tasks` with Zod query validation, cursor pagination and server-side filtering; indexes migration `m2_07_tasks_board_index`.
- [ ] `tasks` WS topic: filtered snapshot on subscribe, deltas, `resync` on backpressure; reuse the M0-06 gateway primitives.
- [ ] `ReassignTask` use case + `POST /api/tasks/:id/reassign[/preview]`, `cancel`, `retry` controllers; `routing.rerouted` event schema; audit action.
- [ ] `packages/ui`: `TaskCard` (compact/expanded), `StatePip` (shape + label), `ProviderModelBadge`, `DiffStat`, stories for every state incl. long goals and missing assignment.
- [ ] `apps/web`: `BoardScreen` with column layout, virtualization (windowed lists per column), sticky headers with counts.
- [ ] Zustand board store with idempotent delta application, resync handling and URL-synced filters.
- [ ] Swimlane grouping (`state+provider`) with lane headers showing active/limit session counts from Fleet data.
- [ ] Drag-and-drop with pointer + keyboard + screen-reader announcements; drop-target rules from §4.1.
- [ ] `ReassignDialog` wrapping `RoutingPreview` (M2-06), incl. `StaleDecision` and `OverrideRejected` handling.
- [ ] Card menu actions wired: open terminal (M1-09), open chat (M2-08 when present, disabled before), open decision (M2-09 when present), cancel, retry.
- [ ] Perf harness: seed 300 tasks via FakeProvider, measure frame time and delta latency; add to the nightly load job.
- [ ] a11y + RTL pass (axe, keyboard-only run-through, reduced motion).
- [ ] Playwright E2E for the five board flows (list, filter, live move, reassign, refuse-running).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-07-01 | unit | `applyDelta` with out-of-order and duplicate events | state converges; older `updatedAt` never overwrites newer; no duplicate cards |
| UT-M2-07-02 | unit | reassignable-state predicate over all `TaskState` values | true only for `draft|assigned|blocked|failed`; exhaustive over the union |
| UT-M2-07-03 | unit | filter reducer ↔ URL query round-trip | every filter combination serialises and parses back identically |
| AT-M2-07-01 | application | `ReassignTask` on a `running` task | `Err(TaskNotReassignable)`; no decision written, no session touched |
| AT-M2-07-02 | application | `ReassignTask` on a `failed` task with the old provider excluded | new decision with `routing.rerouted` emitted; previous branch reused when the worktree still exists |
| IT-M2-07-01 | integration | `GET /api/tasks` with mixed filters + cursor | correct rows, stable ordering across pages, no duplicates at page boundaries |
| IT-M2-07-02 | integration | WS `tasks`: create/assign/start/finish a FakeProvider task | delta for each transition delivered < 500 ms; snapshot after a forced resync matches the DB |
| E2E-M2-07-01 | e2e | drag a `draft` card to another provider lane | preview dialog appears before any mutation; on confirm the card shows the new provider; audit row present |
| E2E-M2-07-02 | e2e | drag a `running` card | drop refused, tooltip shown, no network request issued |
| E2E-M2-07-03 | e2e | 300 seeded cards | initial render < 1.5 s, scroll stays ≥ 55 fps, memory within the M0-07 web budget |
| E2E-M2-07-04 | e2e | axe scan in both themes, LTR + RTL, keyboard-only reassignment | no critical/serious violations; reassignment completable without a pointer |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-07-01 | Board reflects all origins | 1. Create one task via Quick Delegate, one via `orch delegate`, one via a Lead's MCP `delegate` (M2-05) 2. Open Board | Three cards, each with the right origin marker, provider·model badge and branch; states match `GET /api/tasks` | ⬜ |
| TC-M2-07-02 | Live movement | 1. Watch the Board while a real task runs | Card moves `assigned → running → done` without a reload, within ~0.5 s of the terminal showing the same change; done card shows branch + diffstat | ⬜ |
| TC-M2-07-03 | Filters and grouping | 1. Filter by provider `codex` 2. Switch grouping to state+provider 3. Copy the URL to a new tab | Only Codex cards remain; swimlanes show each provider's active/limit counts; the new tab restores the same filtered view | ⬜ |
| TC-M2-07-04 | Drag to reassign with preview | 1. Create a task but let it fail (e.g. point it at a non-existent file) 2. Drag the failed card to another provider lane | Preview dialog shows from → to, new score and reasons; confirming reruns the task on the other provider; `routing.rerouted` visible in the event stream and an audit row exists (C10) | ⬜ |
| TC-M2-07-05 | Negative: reassign a running task | 1. Drag a `running` card to another lane 2. Then try the card menu → Reassign… | Drop refused with an explanatory tooltip; menu item disabled with the same reason; no request in the network tab; the agent is undisturbed | ⬜ |
| TC-M2-07-06 | Negative: no eligible target | 1. Log out of / rate-limit every provider but the current one 2. Attempt a reassignment | Dialog shows the excluded table with reasons; card returns to its column; nothing spent | ⬜ |
| TC-M2-07-07 | Restart / resilience | 1. With several tasks on the Board, `kill -9` the daemon 2. Restart it | Board shows the disconnected banner, then resubscribes automatically; after reconcile every card matches reality (running agents still running); no ghost or duplicate cards | ⬜ |
| TC-M2-07-08 | Density | 1. Seed ~100 tasks (script or repeated Quick Delegates on the scratch repo) 2. Scroll and filter | Scrolling stays smooth; filtering is instant; column counts are correct; no console errors | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Columns are exactly the `Task` states from `04-domain-model.md §2`; no UI-invented state, and the UI never transitions a task by itself.
- [ ] Tasks from all three origins (UI, CLI, MCP) appear with correct provider/model/worktree/state within 500 ms of the event (IT-M2-07-02, TC-M2-07-02).
- [ ] Drag-to-reassign always shows a routing preview before any mutation, and is impossible for `running` tasks (C10, TC-M2-07-04/05).
- [ ] Every reassignment writes a `routing_decisions` row, a `routing.rerouted` event and an `audit_log` row.
- [ ] Board is fully keyboard-operable including reassignment, passes axe in light/dark and RTL, and uses shape+text for every state (never colour alone).
- [ ] 300 cards render within the M0-07 web budgets and scrolling stays ≥ 55 fps (E2E-M2-07-03).
- [ ] Reconnect after a daemon restart resyncs without a page reload and without ghost cards (TC-M2-07-07).
- [ ] All TC-M2-07-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Drag-and-drop libraries vary widely in a11y quality and bundle size. Pick one already compatible with the `packages/ui` stack and with documented keyboard + screen-reader support; if none fits the budget, ship the keyboard/menu path first and treat pointer dragging as the enhancement (the acceptance criteria are written so this is still a pass).
- Two meanings of "moving a card" (change provider vs change state) is a known UX trap. The chosen resolution — state columns are drop-inert, provider lanes are the only drop targets — must be obvious on first use; if TC-M2-07-05 shows users still trying it, add a persistent hint rather than enabling state drags.
- Review columns are visible but empty until M3-04. That risks looking broken; render them with a muted "arrives with missions (M3)" placeholder rather than as empty active columns.
- Reusing an existing worktree/branch on reassignment can hand a second vendor a half-finished tree. In M2 the reuse only happens for `failed|blocked` tasks and the dialog states it explicitly; the clean-slate-vs-reuse policy is properly decided with review rounds in M3-04.
- WS delta volume on a busy fleet (progress events every few hundred ms) could swamp the board. Progress events are coalesced server-side per task to at most one delta per second for the `tasks` topic; the full stream stays available on the session topics.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
