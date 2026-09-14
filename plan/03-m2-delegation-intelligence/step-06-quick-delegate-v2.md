# Step M2-06 — Quick Delegate v2

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-04, M1-12 |
| Estimated effort | 1.5 days |
| Packages touched | `apps/web`, `packages/ui`, `apps/daemon`, `apps/cli`, `packages/core` |
| Risk | Low |
| Owner | |

## 1. Goal
After this step Quick Delegate stops asking the user to pick a provider and model. The user types a goal, picks a task type from the taxonomy, and presses **Assign**; the assignment engine (M2-04) returns a dry-run `RoutingDecision` which is shown in a preview dialog — chosen provider/model, score, ordered reasons, the three best alternatives with one-click override, plus worktree/branch, sandbox profile and budget. Pressing **Delegate** runs exactly the M1-12 execution path (worktree → session → result) against the chosen model, records the non-dry-run decision, and hands off to the task detail / Board. Nothing spends quota before the preview is shown and confirmed (C10).

## 2. Why
- G2: this is the first user-facing surface where "right model for the job" happens automatically; the preview is where the ≥ 60 %-off-top-tier KPI becomes visible per task.
- D3: the engine decides, the user confirms — the two-tier design applied to the simplest possible flow, with no Lead involved.
- C10: "every spend action previewed, permissioned, audited" — the preview dialog is that preview for the manual path, as the Attention card is for the MCP path (M2-05).
- UX principle 5 (zero-surprise control) and 4 (truth labelling): the dialog shows *why*, with confidence-labelled window health, before anything runs.
- D11: the execution path from M1-12 is reused unchanged — M2 extends M1 interfaces, never rewrites them.

## 3. Scope
### In scope
- `POST /api/tasks/quick` v2: `mode: 'auto' | 'manual'`, optional `overrideRef`, `Idempotency-Key`, two-phase (`preview` then `commit` via `decisionId`).
- `QuickDelegateDialog` rework in `apps/web`: goal, task-type combobox (taxonomy, grouped, searchable), repo picker, optional language/variant fields, advanced disclosure (sandbox, budget, branch name).
- `RoutingPreview` component in `packages/ui` (chosen card, score bar, reason chips, alternatives table with "Use this", excluded list behind a disclosure) — shared verbatim with M2-07 and M2-09.
- Override path: choosing an alternative (or a manual model) re-decides with `overrideRef`, producing a decision whose reasons include `user-override`.
- `orch delegate --goal … --task-type … [--auto|--model ref] [--yes]` in `apps/cli`.
- Task detail drawer v1: state, assignment + reasons link, session link, worktree/branch, result (branch, diffstat, summary) when done.
### Out of scope (deferred to …)
- Kanban of all tasks, drag-to-reassign, filters → M2-07.
- Decision history list and "why this model" panel outside the dialog → M2-09.
- Multi-task decomposition, playbooks, review rounds, PRs → M3.
- Re-running / retrying a failed task with a different model automatically → M4-03 (manual "Reassign" from the Board is M2-07).
- Editing routing policy from the dialog → M8-02.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new aggregate. `Task` (`04-domain-model.md §1`) gains no new states — the flow walks `draft → assigned → running → done|failed` exactly as M1-12 defined it. Rules added here:
- A task may only leave `draft` with a `routing_decisions` row whose `dry_run = 0` and whose `task_id` is this task; the `assigned_provider`/`assigned_model` columns are written from that row, never from the request body.
- Commit is bound to the preview: `commit` carries the `decisionId` returned by `preview`. If the candidate set changed meanwhile (`inputsHash` mismatch — e.g. the provider went into cooling), the daemon returns `409 StaleDecision` with the fresh decision, and the dialog re-renders the preview instead of silently routing elsewhere (zero surprise).
- An override is always allowed to a *listed alternative*; an override to an **excluded** candidate is refused with the exclusion reason (it may be a ToS/limit gate: C5, C6, C11), except for `excluded:deprecated` and `manifest-unverified`, which are soft and produce a warning banner plus `reasons: ['user-override']`.
- `overrideRef` is recorded on the decision (`actor.kind = 'user'`), so G2 metrics can separate engine choices from human choices.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/interface/http/dto/quick-delegate.dto.ts   (Zod at the edge)
export const QuickDelegatePreview = z.object({
  goal: z.string().min(8).max(4000),
  taskTypeId: z.string(),
  variants: z.record(z.string()).optional(),
  language: z.string().optional(),
  repoPath: z.string(),                       // must be a known repo (M1-03 registry)
  mode: z.enum(['auto','manual']).default('auto'),
  overrideRef: z.string().optional(),         // '<provider>/<model>' — required when mode==='manual'
  sandbox: z.string().optional(),             // defaults to taskType.sandboxDefault
  budget: z.object({ maxTurns: z.number().int().positive().optional(), maxMinutes: z.number().int().positive().optional() }).optional(),
  branchHint: z.string().max(60).optional(),
});
export const QuickDelegateCommit = z.object({
  decisionId: z.string(),
  goal: z.string(), taskTypeId: z.string(), repoPath: z.string(),   // echoed for integrity, compared to the decision
  overrideRef: z.string().optional(),
  acknowledgeWarnings: z.array(z.string()).default([]),             // e.g. ['deprecated-model']
});

// apps/daemon/src/application/tasks/quick-delegate.use-case.ts
export class PreviewQuickDelegate {
  execute(cmd: PreviewCmd): Promise<Result<RoutingDecisionDto, TaxonomyUnknown | UnknownRepo | NoEligibleCandidate>>;
}
export class CommitQuickDelegate {                                  // one use case per class
  execute(cmd: CommitCmd): Promise<Result<{ taskId: TaskId; sessionId: SessionId; decisionId: DecisionId },
    StaleDecision | OverrideRejected | NoEligibleCandidate | WorktreeError | ProviderUnavailable>>;
}

// packages/ui/src/routing/RoutingPreview.tsx  (shared with M2-07, M2-09)
export interface RoutingPreviewProps {
  decision: RoutingDecisionDto;
  onOverride?(ref: ModelRefString): void;      // absent ⇒ read-only rendering (decision log)
  showExcluded?: boolean;                      // default true, collapsed
  busy?: boolean;
}
```

### 4.3 Data / schema changes
No new tables. Migration `m2_06_tasks_decision_link`: `tasks.routing_decision_id TEXT NULL` (FK-ish reference to `routing_decisions.id`), `tasks.override_ref TEXT NULL`, `tasks.idempotency_key TEXT NULL` unique per `(origin, idempotency_key)` (shared with the M2-05 index — whichever migration lands first creates it, the other is a no-op guard). Events reused: `routing.dry_run` (preview), `routing.decided` + `task.created` + `task.assigned` + `task.started` (commit). `audit_log` row on commit with `action: 'task.quick_delegate'`, before/after = `{}` → `{taskId, chosen, override?}`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
Nothing new. Commit calls, in order, the components M1 already delivered: `WorktreeManager.create()` (M1-03) → `SessionSupervisor.start()` (M1-02) with the chosen provider's `Launcher` plan (M1-05..07) → result extraction from the worktree (M1-12). The only new infrastructure code is the preview→commit binding (`StaleDecision` check) and the audit row.

### 4.5 API / UI surface
- `POST /api/tasks/quick/preview` → `RoutingDecisionDto` (`dryRun: true`) or `409 NoEligibleCandidate` with the excluded list.
- `POST /api/tasks/quick` (commit) → `{ taskId, sessionId, decisionId }`, `409 StaleDecision { decision }`, `422 OverrideRejected { ref, reason }`. Honours `Idempotency-Key`.
- `GET /api/tasks/:id` → task detail incl. `decision`, `session`, `worktree`, `result`.
- CLI: `orch delegate --goal "…" --task-type changelog [--repo …] [--auto | --model claude/sonnet] [--yes] [--json]` — without `--yes` it prints the preview table and asks for confirmation on stdin; `--json` prints the decision then the task id.
- UI states of `QuickDelegateDialog`: `form` → `scoring` (skeleton, ≤ 2 s) → `preview` → `committing` → `started` (dialog closes, toast with link to the task drawer and Board) with branches `no-candidates` (renders the excluded table with reasons and a link to Fleet), `stale` (banner "the fleet changed — re-check the assignment" + refreshed preview), `error` (typed `code` mapped to a message + retry).
- Preview layout: chosen model card (provider logo-free text badge, model label, cost tier, window health with *official/estimate* label), score bar with the per-weight breakdown in a popover, reason chips (top 3 visible, rest behind "+N"), alternatives table (model, score, top reason, **Use this**), collapsed "Excluded (N)" table. Keyboard: `⌘↵` delegate, `1–3` pick alternative, `Esc` cancel. RTL-safe via logical properties; status never colour-only; axe-clean.

### 4.6 Flow / sequence
```
User ⌘K "Quick Delegate" ─▶ dialog(form)
  goal + taskType + repo ──▶ POST /api/tasks/quick/preview
        └─ PreviewQuickDelegate ─▶ Taxonomy ─▶ Policy ─▶ CandidateBuilder ─▶ AssignmentEngine.decide(dryRun)
             ├─ Ok  ─▶ persist(dry_run=1) ─▶ routing.dry_run ─▶ 200 decision ─▶ dialog(preview)
             └─ Err ─▶ 409 NoEligibleCandidate{excluded[]} ─▶ dialog(no-candidates)
  [optional] "Use this" on an alternative ─▶ preview again with overrideRef ─▶ reasons += user-override
  Delegate ─▶ POST /api/tasks/quick {decisionId}
        └─ CommitQuickDelegate
             ├─ inputsHash changed? ─▶ 409 StaleDecision{fresh decision} ─▶ dialog(preview, banner)
             ├─ override excluded by a hard gate? ─▶ 422 OverrideRejected{reason}
             └─ ok ─▶ decision(dry_run=0) ─▶ task.created/assigned
                    ─▶ M1-12: worktree ─▶ session ─▶ task.started ─▶ (agent runs) ─▶ task.result_submitted
                    ─▶ WS `tasks` ─▶ dialog(started) ─▶ Board card (M2-07) / task drawer
```

## 5. Tasks
- [ ] `PreviewQuickDelegate` use case reusing `PreviewAssignment` (M2-04) with repo/taxonomy validation.
- [ ] `CommitQuickDelegate` use case: decision binding, `StaleDecision` check on `inputsHash`, override rules (hard vs soft exclusions), audit row, then the unchanged M1-12 path.
- [ ] Migration `m2_06_tasks_decision_link` + repository updates; idempotency index shared with M2-05.
- [ ] HTTP controllers for `preview` / commit / `GET /api/tasks/:id` + OpenAPI + `Idempotency-Key` handling.
- [ ] `packages/ui`: `RoutingPreview`, `ScoreBar` (with per-weight popover), `ReasonChip` (reason-code → label map), `ExcludedTable`; stories for every state incl. empty and 12-candidate overflow.
- [ ] `apps/web`: rework `QuickDelegateDialog` to the state machine in §4.5; task-type combobox from `GET /api/catalog/taxonomy`; repo picker from the M1-03 repo registry.
- [ ] Wire `⌘K` action "Quick Delegate" and the keyboard shortcuts (`⌘↵`, `1–3`, `Esc`).
- [ ] Task detail drawer v1 (state, decision link, session link, worktree/branch, result) reachable from the toast and from Board (M2-07).
- [ ] `orch delegate` command with preview table, confirmation prompt, `--yes`, `--json`.
- [ ] a11y pass (axe), RTL pass, reduced-motion check on the score bar animation.
- [ ] Playwright E2E with FakeProvider: auto path, override path, no-candidates path, stale path.
- [ ] Docs: `apps/web/README.md` "Quick Delegate flow" + screenshot placeholder in `plan/03-m2-delegation-intelligence/evidence/`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-06-01 | unit | override rules: alternative / hard-excluded / soft-excluded (deprecated) candidate | allowed / `OverrideRejected` with reason / allowed with `acknowledgeWarnings` required |
| UT-M2-06-02 | unit | reason-code → label map covers the closed `ReasonCode` union | exhaustiveness test fails to compile/run if a code is added without a label |
| AT-M2-06-01 | application | preview then commit with an unchanged fleet | one `dry_run=1` row and one `dry_run=0` row; task `assigned` with the chosen ref |
| AT-M2-06-02 | application | commit after the chosen provider enters cooling | `Err(StaleDecision)` carrying a fresh decision; no worktree, no session (C5) |
| AT-M2-06-03 | application | commit twice with the same `Idempotency-Key` | one task, one session; second call returns the first result |
| IT-M2-06-01 | integration | daemon + FakeProvider: full commit | worktree exists on disk, session running, `task.started` emitted, audit row present |
| IT-M2-06-02 | integration | commit with `overrideRef` to a valid alternative | decision `chosen` = override, `reasons` contain `user-override`, `tasks.override_ref` set |
| E2E-M2-06-01 | e2e | Playwright: auto path end-to-end | preview shows chosen + 3 alternatives; after Delegate the task drawer shows branch + diffstat when the fake agent finishes |
| E2E-M2-06-02 | e2e | Playwright: no-candidates path (all providers unhealthy in the fake fleet) | dialog shows the excluded table with reasons and a Fleet link; Delegate button disabled |
| E2E-M2-06-03 | e2e | axe scan of the dialog in both themes and RTL | no critical/serious violations |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-06-01 | Auto assignment on real CLIs | 1. `⌘K` → Quick Delegate 2. Goal "Add a `## Unreleased` section to CHANGELOG.md with today's date", task type `changelog`, repo `~/orchestra-scratch` 3. Assign | Preview within 2 s: a low-cost-tier model chosen, reasons listed, 3 alternatives shown; nothing has started yet (no new tmux window) | ⬜ |
| TC-M2-06-02 | Commit and result | 1. Continue from TC-01 → Delegate | Task drawer shows `assigned → running`; a tmux window exists for it; on completion branch + diffstat appear and match `git -C <worktree> log`; `routing_decisions` has exactly one `dry_run = 0` row for the task | ⬜ |
| TC-M2-06-03 | Override to an alternative | 1. Repeat the preview 2. Press **Use this** on alternative #2 3. Delegate | The run uses the overridden model; decision reasons include `user-override`; task drawer names the overridden model, not the engine's first choice | ⬜ |
| TC-M2-06-04 | Negative: override to an excluded candidate | 1. Preview a `code-review` task with an author set so one vendor is excluded 2. Try to override to that vendor via `orch delegate --model <excluded ref>` | Refused with the exclusion reason (`excluded:same-vendor-as-author`); no task created; G3 preserved | ⬜ |
| TC-M2-06-05 | Negative / resilience: stale preview | 1. Open a preview 2. Before confirming, log out (or rate-limit) the chosen provider 3. Press Delegate | Dialog shows the "fleet changed" banner with a fresh preview naming another model; nothing ran on the unavailable provider | ⬜ |
| TC-M2-06-06 | Restart / resilience | 1. Delegate a task 2. `kill -9` the daemon while the agent is running 3. Restart | Task reappears in `running` after reconcile; the agent's tmux window survived; the decision row is unchanged; the result is still collected when the agent finishes | ⬜ |
| TC-M2-06-07 | CLI parity | 1. `orch delegate --goal "…" --task-type quick --json` | Prints the same decision the dialog would show (same `chosen`, `score`, `reasons`); with `--yes` it commits and prints the task id | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] The dialog never starts a session before the preview is confirmed; TC-M2-06-01 verifies no tmux window exists at preview time (C10).
- [ ] Preview → commit is bound by `decisionId`; a changed fleet yields `409 StaleDecision`, never a silent reroute.
- [ ] Every committed task has exactly one non-dry-run `routing_decisions` row and its `assigned_provider`/`assigned_model` come from that row.
- [ ] Override to an alternative works from UI and CLI and is recorded as `user-override`; override to a hard-excluded candidate is impossible from either surface.
- [ ] Execution reuses M1-12 unchanged (no new tmux/git code in this step; dependency-cruiser shows no new infrastructure edges from the tasks module).
- [ ] Dialog is keyboard-complete, axe-clean in light/dark and RTL, and renders within the M0-07 interaction budget (preview round-trip p95 < 2 s on the real fleet).
- [ ] All TC-M2-06-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Task-type choice is still manual here; a wrong task type produces a defensible but useless assignment. Auto-classification of a free-text goal is deliberately not in M2 (it would be an LLM call, i.e. a Lead — M3-02). Mitigation: the combobox shows each type's description, risk and review rule, and defaults to `quick`.
- `repoPath` must come from the M1-03 repo registry; accepting an arbitrary path from the browser would be a traversal surface. Validated server-side against the registry, not by the client.
- The `StaleDecision` check compares `inputsHash`, which includes candidate health. On a busy fleet this can fire often (a sibling session finishing changes `activeSessions`). If it proves noisy in TC-06-05, narrow the hash to the fields that can change the *chosen* candidate and record the decision in the step log — do not weaken it to "ignore health".
- Two surfaces now create tasks (this dialog and MCP `delegate`, M2-05). The idempotency index and the audit action names are shared; whichever step lands first owns the migration, the other guards it. Watch for a merge conflict in `tasks` repository code (noted in the M2 README "shared files" list).
- Budget fields in the dialog are advisory in M2: nothing enforces `maxMinutes` until M4-04. Label them as defaults from the task type and do not imply enforcement.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
