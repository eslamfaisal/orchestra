# Step M8-07 — Playbook editor

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M3-01, M8-01 |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core`, `packages/catalog`, `packages/sdk`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step a workspace owns its mission shapes. Settings › Playbooks lists shipped, user and workspace playbooks; a user can duplicate a shipped playbook into `<repo>/.orchestra/playbooks/`, edit it as YAML with a live **DAG preview** beside it, require skills (from M8-04) and gates per step, validate against the M3-01 schema and DAG rules with errors pinned to the offending step, diff it against the shipped original, bump its version on save, and **test-run** it end to end with `FakeProvider` — no quota, no real CLI, no repo changes — watching the simulated DAG advance and stop at the first gate.

## 2. Why
- **D7** — playbooks are the last shipped catalog family without an editor (taxonomy and routing got theirs in M8-02, skills in M8-04, prompts in M8-03). Mission shapes change per team and per repo; they must not require a release.
- **G7** — playbooks are a publishable artifact family (M10-03). Editing, versioning and validating them locally is the prerequisite for publishing them.
- **G3** — `reviewRounds` and `gate` per step are how cross-vendor review becomes mandatory by construction (M3-01 §2). An editor that lets a user quietly set `reviewRounds: 0` on a high-risk step would undo that; the raise-only rules from M8-02 apply here too.
- **C9 / C10** — the test-run is the cheap way to answer "does this playbook do what I think": `FakeProvider` only, nothing spent, nothing merged. A real dry-run against the assignment engine is already available via M4-06 simulation and is linked from here.
- **UX principle 5 (zero-surprise control)** — a mission is the most expensive thing Orchestra starts. Seeing the DAG, the gates and a simulated pass before the first real run is the preview for that spend.

## 3. Scope
### In scope
- Playbook scopes and precedence, reusing the M3-01 loader: shipped (`packages/catalog/playbooks/`) → user (`~/.orchestra/catalog-overrides/playbooks/`) → workspace (`<repo>/.orchestra/playbooks/`); same `id` in a higher scope shadows the lower, with provenance.
- Editor: YAML pane (CodeMirror 6 + JSON Schema completion from the M3-01 schema) beside a **DAG preview** (deterministic layered layout, SVG) that highlights the step under the cursor and vice versa.
- Live validation using M3-01's `validateDag`, `validateBudget`, `crossCheck` plus new editor-only checks (skill ids exist and are attachable, role exists in the M8-02 `roles` section, gate raise-only, `reviewRounds` raise-only on high-risk types).
- Step form for the selected node: title, task type, role, executor, `dependsOn` multiselect, `requiredSkills` picker (from the M8-04 library, showing trust), `gate`, `reviewRounds`, `budgetShare`, `multiplicity`, `goalTemplate`.
- Duplicate-from-shipped, rename/new, delete-to-trash, version bump on save, diff vs the shipped original (or vs the previous saved version).
- Test-run with `FakeProvider`: instantiate the playbook as a mission in a **sandbox mission** mode, run every step with `FakeProvider` scenarios, stop at gates, report per-step results and total simulated budget; never writes to a real repo.
- `orch playbook edit|duplicate|diff|test-run` on top of M3-01's `validate|list|show`.
### Out of scope (deferred to …)
- Changing playbook *execution* semantics — M3-02 owns the mission lifecycle; this step only edits the artifact and drives a sandbox run through the existing lifecycle.
- Real dry-run cost/window simulation of a playbook against the live fleet → M4-06 already does this for a planned mission; the editor links to it rather than reimplementing it.
- `4-eyes` gate semantics (two distinct approvers) → still M9-04; the schema accepts it and the editor shows the M3-01 load-time warning.
- Publishing/installing playbooks from a registry → M10-03.
- A graphical drag-to-connect DAG builder → not planned; the DAG is a *preview*, the YAML (and the step form) is the editor. Revisit only with an ADR.
- Per-user permissions on who may edit workspace playbooks → M9-01.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
All DAG and budget rules already exist in `packages/core/src/playbook/` (M3-01) and are reused unchanged. This step adds pure editor-side validation and a diff, both in core:

- `validateEditable(playbook, ctx)` — additional checks beyond M3-01's loader:
  - every `requiredSkills[]` id resolves in the skill library for the repo, and at least one installed provider can attach it (`W_SKILL_NOT_ATTACHABLE` — a warning, since a skill may be installed later);
  - every `role` exists in the resolved `roles` section (M8-02) or in the shipped role set (`E_UNKNOWN_ROLE`);
  - **raise-only** gate: a workspace/user playbook may not lower a step's gate below the shipped playbook's gate for the same step id (`E_GATE_WEAKENED`), and may not set `reviewRounds: 0` on a task type whose taxonomy says `reviewRequired` (`E_REVIEW_REQUIRED`, already M3-01's rule, surfaced per step here);
  - `budgetShare` sum ≤ 1.0 (M3-01) with the `W_BUDGET_LOW` warning rendered as a chip, not an error.
- `diffPlaybooks(a, b)` — pure, step-keyed: `added | removed | changed(field-level) | reordered`, stable ordering, used for both "vs shipped" and "vs previous version".
- `layoutDag(steps)` — pure, deterministic layered layout (longest-path layering + barycentre ordering within a layer, ties broken by step id). Returns `{ nodes: {id, layer, index}, edges }`; the SVG renderer is presentation only. Determinism matters: the preview must not reshuffle while typing.
- Version rule: saving a changed playbook requires a semver bump; the UI bumps the patch automatically, the CLI refuses (`E_VERSION_NOT_BUMPED`) — same rule as prompt templates (M8-03) for consistency.
- A cycle is reported as the **path** (M3-01's Kahn implementation already returns it), mapped to node highlights in the preview.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/playbook/editor.ts
export type PlaybookIssueCode =
  | 'E_CYCLE' | 'E_UNKNOWN_STEP_REF' | 'E_UNKNOWN_TASK_TYPE' | 'E_UNKNOWN_ROLE'
  | 'E_REVIEW_REQUIRED' | 'E_GATE_WEAKENED' | 'E_BUDGET_OVER' | 'E_VERSION_NOT_BUMPED'
  | 'W_BUDGET_LOW' | 'W_SKILL_NOT_ATTACHABLE' | 'W_FOUR_EYES_UNSUPPORTED';
export interface PlaybookIssue {
  code: PlaybookIssueCode; severity: 'error' | 'warning';
  stepId?: string; field?: string; line?: number; message: string; path?: readonly string[];  // cycle path
}
export interface EditorContext {
  taxonomy: TaxonomyPort; roles: readonly RoleName[];
  skills: readonly { id: string; attachableBy: readonly ProviderId[] }[];
  shipped?: Playbook;                                   // for raise-only comparison and diff
}
export function validateEditable(p: Playbook, ctx: EditorContext): readonly PlaybookIssue[];

export interface PlaybookDiffEntry {
  stepId: string; kind: 'added' | 'removed' | 'changed' | 'reordered';
  fields?: readonly { field: string; from: unknown; to: unknown }[];
}
export function diffPlaybooks(a: Playbook, b: Playbook): readonly PlaybookDiffEntry[];

export interface DagLayout {
  nodes: readonly { id: string; layer: number; index: number; gate: Gate; reviewRounds: number }[];
  edges: readonly { from: string; to: string }[];
}
export function layoutDag(steps: readonly PlaybookStep[]): DagLayout;      // deterministic

// apps/daemon/src/application/playbooks/*.use-case.ts
export class SavePlaybook {
  execute(cmd: { scope: 'user' | 'workspace'; repoPath?: string; yaml: string;
                 ifMatchHash: string; actor: Actor }):
    Promise<Result<{ id: string; version: string; warnings: readonly PlaybookIssue[] },
      readonly PlaybookIssue[] | { code: 'E_VERSION_CONFLICT'; currentHash: string; currentYaml: string }>>;
}
export class DuplicatePlaybook {
  execute(cmd: { sourceId: string; newId: string; scope: 'user' | 'workspace'; repoPath?: string; actor: Actor }):
    Promise<Result<{ id: string; file: string }, DomainError>>;
}
export class TestRunPlaybook {
  /** FakeProvider only. Creates a sandbox mission; never touches a real repo or a vendor binary. */
  execute(cmd: { yaml: string; repoPath?: string; scenario?: string; stopAtFirstGate?: boolean; actor: Actor }):
    Promise<Result<{ runId: string }, { code: 'E_INVALID_PLAYBOOK'; issues: readonly PlaybookIssue[] }
                                     | { code: 'E_FAKE_PROVIDER_UNAVAILABLE' }>>;
}
```

### 4.3 Data / schema changes
- `playbooks` table exists (`04 §4`: `id, name, version, scope, yaml`). Migration `m8_07_playbooks_ext` adds `file TEXT`, `content_hash TEXT NOT NULL`, `based_on_id TEXT NULL`, `based_on_version TEXT NULL`, `updated_at TEXT`, `updated_by TEXT`; unique index `(scope, id)`.
- New table `playbook_test_runs`: `id, playbook_id, playbook_version, started_at, ended_at, status ('running'|'done'|'stopped-at-gate'|'failed'|'cancelled'), mission_id, steps_json, actor_json` — small, purged with the sandbox mission.
- `missions` gains `sandbox INTEGER NOT NULL DEFAULT 0` (migration `m8_07_sandbox_mission`) so a test run is a real mission through the M3-02 lifecycle but is excluded from the Missions list, the Board and every KPI by default. **Every place that aggregates missions must filter `sandbox = 0`** — asserted by a test.
- New events: `playbook.saved {id, scope, version, file, actor}`, `playbook.deleted {id, scope}`, `playbook.test_run_started {runId, playbookId, missionId}`, `playbook.test_run_finished {runId, status, stoppedAtStep?}`.
- `audit_log` rows for save, delete and duplicate.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Files are written with M8-02's `AtomicYamlWriter` (temp + rename, single `.bak`, `If-Match` hash); delete moves to `<scope>/playbooks/.trash/` like M8-03's templates.
- Watchers: M3-01's `PlaybookLoader` already hot-reloads all three scopes; this step adds self-write suppression so a UI save produces one reload, not two.
- Test run: creates a throwaway repo under `~/.orchestra/playbook-test-runs/<runId>/` (copy of a minimal fixture, `git init`, one commit) and runs the mission with the `FakeProvider` adapter forced for every task, `$ORCH_PORT` / `$ORCH_DB_SUFFIX` from M3-07. Gate steps produce real `AgentPrompt`s (kind `planApproval` / `confirm`) so the gate behaviour is genuinely exercised in the Attention queue; `stopAtFirstGate` (default true) stops there and reports.
- `FakeProvider` scenario selection: the playbook's step task types map to shipped scenarios (`fixtures/scenarios/*.yaml`); an unmapped task type falls back to a generic `succeeds-with-diff` scenario, and the run report says which steps used the fallback.
- Cleanup: the sandbox mission, its worktrees and the run directory are deleted on completion; kept on `failed` for inspection with the path shown, purged by TTL (7 d).
- Refusal: `TestRunPlaybook` asserts the resolved adapter is `FakeProvider` for every task and aborts with `E_FAKE_PROVIDER_UNAVAILABLE` otherwise — a test run can never reach a vendor binary (C9 by construction, not by convention).
- No network.

### 4.5 API / UI surface
- `GET /api/playbooks?repo=` (M3-01) extended with `scope`, `contentHash`, `basedOn`, `shadows[]`.
- `POST /api/playbooks/validate` — body `{ yaml, repo? }` → `{ issues: PlaybookIssue[] }` (editor gutter, debounced 300 ms).
- `POST /api/playbooks/layout` — body `{ yaml }` → `DagLayout` (or computed client-side from the same core function shipped in `packages/sdk`; prefer client-side, server endpoint for the CLI).
- `PUT /api/playbooks/:id?scope=&repo=` — body `{ yaml }`, `If-Match: <contentHash>`; `409` on conflict, `422` with issues.
- `POST /api/playbooks/:id/duplicate` — body `{ newId, scope, repo? }`.
- `DELETE /api/playbooks/:id?scope=&repo=` → trash move.
- `GET /api/playbooks/:id/diff?against=shipped|previous` → `PlaybookDiffEntry[]`.
- `POST /api/playbooks/test-run` — body `{ yaml, repo?, scenario?, stopAtFirstGate? }` → `202 { runId }`; `GET /api/playbooks/test-runs/:runId`; `POST /api/playbooks/test-runs/:runId/cancel`. WS topic `playbooks`.
- CLI: `orch playbook duplicate <id> --to <newId> --scope workspace`, `orch playbook edit <id> --scope workspace` (`$EDITOR`, validate on close, refuse invalid), `orch playbook diff <id> --against shipped`, `orch playbook test-run <id> [--no-stop-at-gate] [--json]`.
- UI `apps/web/src/features/settings/playbooks/`:
  - `PlaybookList` — shipped/user/workspace grouping, scope chip, version, shadowing indicator, "Duplicate to workspace" action on shipped rows (shipped rows are read-only, editing one offers the duplicate).
  - `PlaybookEditor` — YAML pane (CodeMirror + schema completion + issue gutter) | `DagPreview` (SVG, nodes labelled with step id, task type, role; gate badges as icon + word; `reviewRounds` chip; error nodes outlined and listed) | `StepForm` for the selected node (task type combobox from the taxonomy, role select from the resolved roles, `dependsOn` multiselect, `requiredSkills` picker showing each skill's trust badge and an *installable?* hint, gate select with lowering options disabled, `reviewRounds`, `budgetShare` with a running total).
  - `PlaybookDiff` — vs shipped or vs previous version, step-keyed with field-level rows.
  - `TestRunPanel` — Run button (labelled *FakeProvider — spends nothing*), live step list (queued · running · reviewing · gate · done · skipped), the gate prompt rendered inline with a link to Attention, per-step simulated budget, total, and the fallback-scenario note.
  - States: `loading`, `read-only` (shipped), `clean`, `dirty`, `invalid` (Save disabled, gutter + node highlights), `conflict`, `saving`, `saved`, `test-running`, `stopped-at-gate`, `test-failed`.
- Accessibility: the DAG has an equivalent ordered list view (toggle) for screen readers; gates and states are icon + word; `prefers-reduced-motion` disables the layout transition; RTL mirrors the DAG's flow direction.

### 4.6 Flow / sequence
```
Settings › Playbooks ─▶ GET /api/playbooks ─▶ list (shipped read-only, user/workspace editable)
Duplicate shipped ─▶ POST /duplicate ─▶ file written in scope ─▶ based_on_id/version recorded ─▶ editor opens

keystroke ─┬─▶ layoutDag(steps) (client, deterministic) ─▶ DagPreview
           └─▶ 300 ms debounce ─▶ POST /api/playbooks/validate
                 ├─ M3-01: validateDag · validateBudget · crossCheck
                 └─ M8-07: validateEditable (skills · roles · raise-only gates/rounds)
                 ─▶ issues ─▶ gutter markers + highlighted nodes + issue list (cycle rendered as a path)

Save ─▶ PUT /api/playbooks/:id (If-Match)
   ├─ 409 ─▶ "changed on disk" banner ─▶ Reload / Overwrite
   └─ 200 ─▶ atomic write + version bump ─▶ playbook.saved + audit ─▶ loader reload (self-write suppressed)

Test run ─▶ POST /api/playbooks/test-run
   ─▶ assert FakeProvider for every step (else E_FAKE_PROVIDER_UNAVAILABLE)
   ─▶ sandbox repo under ~/.orchestra/playbook-test-runs/<runId>/ (git init + commit)
   ─▶ missions row (sandbox = 1) ─▶ M3-02 lifecycle ─▶ per step: FakeProvider task ─▶ result ─▶ review round
   ─▶ gate step ─▶ AgentPrompt in Attention ─▶ stopAtFirstGate ⇒ stop, status 'stopped-at-gate'
   ─▶ playbook.test_run_finished ─▶ report (per-step status, simulated budget, fallback scenarios)
   ─▶ cleanup (kept on failure, path shown)
```

## 5. Tasks
- [ ] `validateEditable` (skills, roles, raise-only gate and review rounds) in `packages/core/src/playbook/editor.ts`; reuse M3-01 rules unchanged.
- [ ] `diffPlaybooks` (step-keyed, field-level, reorder detection) + `layoutDag` (deterministic layering) in core; export both through `packages/sdk` for the web client.
- [ ] `SavePlaybook` / `DuplicatePlaybook` / `DeletePlaybook` use cases with atomic write, `If-Match`, version-bump enforcement, trash move, audit.
- [ ] Self-write suppression in the M3-01 `PlaybookLoader`; test that one UI save yields one reload.
- [ ] Migrations `m8_07_playbooks_ext`, `m8_07_playbook_test_runs`, `m8_07_sandbox_mission`; repositories; `sandbox = 0` filter in every mission aggregation with a test that enumerates the call sites.
- [ ] `TestRunPlaybook`: sandbox repo builder, forced `FakeProvider` assertion, scenario mapping with fallback note, gate handling via real `AgentPrompt`s, cancel, cleanup/keep-on-failure.
- [ ] Event schemas `playbook.*`; WS topic `playbooks`.
- [ ] Controllers: validate, layout, put, duplicate, delete, diff, test-run, test-run get/cancel + OpenAPI.
- [ ] `PlaybookList` with scope grouping, shadowing and duplicate-from-shipped.
- [ ] `PlaybookEditor`: YAML pane with schema completion and issue gutter; `DagPreview` SVG with cursor↔node sync, gate badges, error highlighting, and an ordered-list alternative view.
- [ ] `StepForm` with taxonomy/role/skill pickers (skill trust badges), raise-only gate control, budget running total.
- [ ] `PlaybookDiff` view (vs shipped / vs previous).
- [ ] `TestRunPanel` with live step states, inline gate prompt, simulated budget and fallback-scenario notes.
- [ ] CLI `orch playbook duplicate|edit|diff|test-run`.
- [ ] Docs: "Editing playbooks" — scopes, raise-only rules, required skills, test runs.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-07-01 | unit | playbook with a cycle `a→b→c→a` | `E_CYCLE` with the full path; `layoutDag` still returns a layout (no infinite loop) with the cycle edges flagged |
| UT-M8-07-02 | unit | step requiring a skill id that does not exist / exists but no installed provider can attach it | error naming the step / `W_SKILL_NOT_ATTACHABLE` warning, save still allowed |
| UT-M8-07-03 | unit | workspace copy lowering a shipped step's gate `human → none`; `reviewRounds: 0` on a `reviewRequired` task type | `E_GATE_WEAKENED` / `E_REVIEW_REQUIRED`, both pinned to the step id |
| UT-M8-07-04 | unit | `layoutDag` called 100× on the same steps and on a shuffled input | identical layout both times (deterministic layering and tie-breaks) |
| UT-M8-07-05 | unit | `diffPlaybooks` with an added step, a removed step, a changed `budgetShare` and a reorder | four correctly classified entries with field-level from/to; stable ordering |
| UT-M8-07-06 | unit | budget shares summing to 1.2 / to 0.4 | `E_BUDGET_OVER` / `W_BUDGET_LOW` chip, save allowed for the warning |
| AT-M8-07-01 | application | `SavePlaybook` on a shipped id/scope | refused (shipped is read-only); catalog file byte-identical |
| AT-M8-07-02 | application | `SavePlaybook` with a stale `If-Match` / without a version bump | conflict with the on-disk YAML / `E_VERSION_NOT_BUMPED`; file untouched |
| AT-M8-07-03 | application | `TestRunPlaybook` when a step would resolve to a real provider | `E_FAKE_PROVIDER_UNAVAILABLE`; no worktree, no session, no vendor binary launched (C9) |
| IT-M8-07-01 | integration | test-run a shipped playbook with FakeProvider | sandbox mission created with `sandbox = 1`; every step runs; the run stops at the first `human` gate with a real `AgentPrompt` in Attention |
| IT-M8-07-02 | integration | sandbox exclusion | the sandbox mission does not appear in Missions, Board, KPIs or the G2 off-top-tier computation |
| IT-M8-07-03 | integration | save a workspace playbook | atomic write with `.bak`; one reload; `GET /api/playbooks` shows the new version within 1 s; `playbook.saved` + audit row |
| IT-M8-07-04 | integration | cancel a test run, then `kill -9` the daemon during another | sessions stopped and sandbox worktrees cleaned; after restart the interrupted run is `failed` with its steps intact and no orphan tmux panes |
| E2E-M8-07-01 | e2e | introduce a cycle in the editor | gutter marker, issue list with the cycle path, the offending nodes outlined in the preview, Save disabled; fixing it clears all three |
| E2E-M8-07-02 | e2e | diff vs shipped after adding a step | the added step appears in the diff with its fields; the DAG preview shows it connected; the list view alternative renders the same order |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-07-01 | Duplicate and edit | 1. Settings › Playbooks 2. Duplicate `new-feature-fullstack` to the workspace scope 3. Add a step `migrate` with task type `schema-migration`, `requiredSkills: [flyway-migration]` and `gate: human` 4. Wire `dependsOn` | The file appears in `<repo>/.orchestra/playbooks/`; the DAG preview adds the node immediately; the skill picker shows `flyway-migration` with its trust badge; validation passes | ⬜ |
| TC-M8-07-02 | Save and version | 1. Save 2. `orch playbook show <id> --scope workspace` 3. Edit again and save | Patch version bumped on each save; `based_on_id`/`based_on_version` point at the shipped playbook; audit rows present | ⬜ |
| TC-M8-07-03 | Test run stops at the gate | 1. Test run the edited playbook (FakeProvider) 2. Watch the panel and the Attention queue | Steps advance live; at `migrate` the run stops with status *stopped at gate*; a real prompt sits in Attention; no quota consumed, no real CLI launched; total simulated budget shown | ⬜ |
| TC-M8-07-04 | Diff vs shipped | 1. Open Diff → vs shipped | The added step and any changed fields are listed; unchanged steps are not; the diff matches `orch playbook diff --against shipped` | ⬜ |
| TC-M8-07-05 | Negative: cycle | 1. Make `test` depend on `docs` and `docs` depend on `test` 2. Save | Validation error names both steps and prints the cycle path; the two nodes are outlined in the preview; Save is disabled; the file on disk is unchanged | ⬜ |
| TC-M8-07-06 | Negative: invalid YAML | 1. Break the YAML indentation mid-file 2. Observe the preview and Save | Gutter marker on the line; the DAG preview keeps the last valid layout labelled *stale*; Save disabled; switching to the step form is refused with "fix the YAML first" | ⬜ |
| TC-M8-07-07 | Negative: weakening a gate / untrusted skill | 1. Try to change the shipped `release` step's gate from `human` to `none` 2. Add an untrusted skill to a step's `requiredSkills` | Gate lowering is refused with `E_GATE_WEAKENED` and the control is disabled with a tooltip; the untrusted skill is accepted with a warning that it cannot be installed until reviewed (M8-04) and the test run reports that step's skill as not attached | ⬜ |
| TC-M8-07-08 | Conflict / resilience | 1. Open the editor 2. Edit the same file from a terminal and save 3. Press Save in the UI, choose Reload, re-apply, Save 4. `kill -9` the daemon and restart | Step 3 shows the conflict banner with the on-disk content; Reload then Save succeeds and `.bak` holds the previous content; after the restart the playbook, its version and the test-run history are intact | ⬜ |
| TC-M8-07-09 | Sandbox isolation | 1. After TC-M8-07-03, open Missions, the Board and Fleet KPIs 2. `ls ~/orchestra-scratch` | The test run appears nowhere except the playbook test-run history; the scratch repo has no new branches, worktrees or commits from the run | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Shipped playbooks are read-only; duplicating one into user or workspace scope is a one-click path that records `based_on` (TC-M8-07-01, AT-M8-07-01).
- [ ] Editing validates against the M3-01 schema and DAG rules plus the editor rules, with every issue pinned to a step and rendered in the YAML gutter, the issue list and the DAG preview (E2E-M8-07-01, TC-M8-07-05).
- [ ] The DAG layout is deterministic — no reshuffling while typing (UT-M8-07-04).
- [ ] Gates and review rounds can be strengthened, never weakened, relative to the shipped playbook and the taxonomy (UT-M8-07-03, TC-M8-07-07).
- [ ] Saves are atomic, `If-Match`-guarded, version-bump-enforced, audited and hot-reloaded once within 1 s (IT-M8-07-03, TC-M8-07-02/08).
- [ ] A test run uses `FakeProvider` for every step, creates a sandbox mission excluded from all aggregations, exercises real gates through Attention, spends nothing and touches no user repo (AT-M8-07-03, IT-M8-07-01/02, TC-M8-07-03/09).
- [ ] Diff vs shipped and vs the previous version is available in the UI and the CLI and agrees between them (TC-M8-07-04).
- [ ] The DAG preview has a screen-reader-equivalent ordered list; gate and status are icon + word; axe-clean in dark/light and RTL; `prefers-reduced-motion` respected.
- [ ] All TC-M8-07-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **The DAG preview is a rendering problem masquerading as a small feature.** A 20-step playbook with crossing edges gets unreadable fast. Mitigation: layered layout with deterministic ordering, edge bundling only if needed, and the list view as the accessible (and always-correct) fallback. Do not adopt a heavyweight graph library for this; if the hand-rolled layout is inadequate, that is an ADR, not a quiet dependency.
- **`sandbox` missions leak into aggregations** if any query forgets the filter — KPIs, budgets, the Board, M4-07 charts, M8-06 outcomes. Mitigation: one repository-level scope helper plus a test that enumerates every mission query; IT-M8-07-02 is the canary. A sandbox mission writing `outcomes` rows would quietly poison the learning loop, so the outcome writer must also filter (coordinate with M8-06).
- **`FakeProvider` scenario coverage** determines how honest a test run is. Task types without a scenario fall back to a generic success, which can make a broken playbook look fine. Mitigation: the report names every fallback step explicitly; adding scenarios for the shipped playbooks' task types is part of this step's task list.
- **Gate prompts in a test run** appear in the real Attention queue, which could be confusing mid-workday. Mitigation: prompts from a sandbox mission carry a *test run* badge and are filtered out of the default Attention view; verify in TC-M8-07-03 that they are findable but not intrusive.
- **Raise-only comparison needs a shipped counterpart.** A brand-new playbook has no shipped original, so gate lowering is unconstrained there — that is correct (nothing was weakened) but means the protection only applies to derivatives. The taxonomy's `reviewRequired` rule still applies to every playbook, which is the actual G3 guarantee.
- **Workspace playbooks live in the repo** and are therefore editable by an agent in a worktree — same exposure noted in M2-09 §8 and M8-02 §8. Same mitigation: main-checkout reads, audited reloads, Repair Agent deny list in M10-01 (C12).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
