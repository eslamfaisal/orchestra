# Step M8-02 — Policy, roles, task-type editors

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M8-01 |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step the routing policy, the role definitions and the task-type overrides are edited **in the product**, not in a text editor. Settings › Policies, Settings › Roles and Settings › Task types each show a form on the left and the live YAML of the chosen layer on the right (CodeMirror 6, schema-completing, two-way synced); a **"What runs where"** panel underneath re-runs the real assignment engine over a fixed sample-task set on every keystroke (debounced, never persisted, never spending anything) so the user sees the routing table change before saving. Saving writes the layer file atomically with optimistic concurrency, audits before/after, and hot-reloads through M8-01 within 1 s. A role now carries model preferences, a budget cap and an allowed task-type list; a task-type override can change weights, risk, review requirement, default skills and sandbox without touching `packages/catalog`.

## 2. Why
- **D7** — routing, roles and taxonomy are data. M8-01 made them layered; this step makes them *editable by a human who is not reading a schema file*, which is the difference between "configurable" and "customizable".
- **D3** — the deterministic engine's value is that you can predict it. The "what runs where" panel is that prediction made visible: the same `AssignmentEngine.decide()` the daemon uses, run in dry-run over sample tasks.
- **G2** — the ≥ 60 %-off-top-tier target is a policy outcome. The panel shows the off-top-tier share for the sample set as you edit, so tuning it is a five-second loop instead of a week of observation.
- **G7** — roles and task-type overrides are versioned artifacts; this is the editor half of the same artifact story that M8-04 (skills) and M8-07 (playbooks) complete.
- **C10** — an edit to routing changes what spends. Every save is audited with actor and before/after, and the panel is a preview (nothing runs).
- **C5 / C6 / G3** — the editor may narrow but never widen a compliance gate: the panel shows candidates excluded by cooling, concurrency and cross-vendor review as *not selectable*, exactly as M2-09 §4.1 requires.

## 3. Scope
### In scope
- Write path for settings layers: `PutSettingsLayer` use case, atomic write (temp + `rename`), `If-Match` version precondition, `.bak` of the previous content, audit row, `settings.layer_written` event.
- `roles` settings section: role → `modelPrefs` (ordered refs), `budget` (caps reusing M4-04 `Budget`), `allowedTaskTypes`, `sandboxDefault`, `gateOverrides`.
- `taxonomy.overrides` settings section: per task type — `weights`, `risk`, `reviewRequired`, `defaultSkills`, `sandboxDefault`, `defaultBudget` — merged over the shipped taxonomy (M2-01) by the existing loader.
- Three editors sharing one shell: form pane, YAML pane (CodeMirror 6 + `@codemirror/lang-yaml` + JSON Schema completion from `GET /api/settings/schema`), layer selector, validation gutter, unsaved-changes guard.
- `POST /api/routing/preview/batch` — N sample tasks, one candidate set, `persist: false`; returns decisions + an aggregate summary (off-top-tier %, per-provider load, excluded counts).
- Sample-task set: 12 shipped samples in `packages/catalog/settings/sample-tasks.yaml` (one per major task-type group) plus "use my last 20 real tasks" as an alternative source.
- Deprecated-model flagging in the editors (M6-06 lifecycle) — a role listing a deprecated model shows a fix-it chip.
- `orch settings set <key> <value> --layer <id>` and `orch settings edit --layer <id>` (opens `$EDITOR`, validates on close, refuses to save an invalid file).
### Out of scope (deferred to …)
- Editing prompt templates → deferred to M8-03; skills → M8-04; playbooks → M8-07; instruction fragments, auto-answer rules, notification/update channels → M8-08.
- Model *profile* overrides (dimension editing by hand) → deferred to M8-06, where they are produced by evidence rather than typed.
- Permission checks on who may write which layer → deferred to M9-01 (the write path already carries `actor`, so the guard is a decorator later).
- Multi-user concurrent editing with live cursors → not planned; `If-Match` + a "changed on disk" banner is the whole concurrency story.
- Aggregated historical KPI charts (off-top-tier % over time) → M4-07 owns those; this panel is per-edit, not historical.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Role` becomes a first-class value object in `packages/core/src/intelligence/roles/role.ts`. The M3-01 closed set (`lead | architect | researcher | implementer | tester | reviewer | writer | releaser`) remains the *shipped* set; the `roles` section may add roles and override shipped ones, but **never remove a role a shipped playbook references** (`E_ROLE_IN_USE`, reported with the playbook ids).
- Rules (pure, `Result`-returning):
  - `validateRole(role, taxonomy, catalog)`: every `allowedTaskTypes` id exists; every `modelPrefs` ref parses (unknown ref ⇒ **warning**, matching M2-09's rule that a temporarily uninstalled provider must not break a policy); `budget` caps non-negative; `gateOverrides` may only *raise* a gate (`none → lead → human → 4-eyes`), never lower one below the playbook's (`E_GATE_WEAKENED`).
  - `validateTaskTypeOverride(o, shipped)`: `weights` keys ⊆ shipped keys and sum to 1.0 ± 1e-6; `risk` any level; `reviewRequired` may be raised (`false → true → 'two-reviewer'`) but **lowering it for a task type whose shipped `risk` is `high` is an error** (`E_REVIEW_WEAKENED`) — G3 is not a preference.
  - `RoleConstraint` joins the M2-04 constraint registry as an eighth strategy (`allowed-task-types`), so a role restriction is an exclusion reason (`excluded:role-not-permitted`) rather than a silent filter. Registration order places it after `allowlist` and before `lead-reserve`.
- Budget interplay: a role budget is a *cap*, evaluated by M4-04's budget check; the editor shows which sample tasks would be blocked by it, but blocking remains M4-04's code.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/roles/types.ts
export interface RoleDefinition {
  id: RoleName;                                  // shipped set ∪ user-defined
  label: string;
  description?: string;
  modelPrefs: readonly ModelRef[];               // ordered; consulted like policy `primary` for tasks in this role
  allowedTaskTypes?: readonly TaskTypeId[];      // absent = all
  budget?: Budget;                               // M4-04 value object
  sandboxDefault?: SandboxProfileId;
  gateOverrides?: Readonly<Record<TaskTypeId, Gate>>;   // may only raise
}

// packages/core/src/intelligence/taxonomy/override.ts
export interface TaskTypeOverride {
  weights?: Partial<TaskWeights>;                // merged over shipped, then renormalised check (must sum to 1)
  risk?: RiskLevel;
  reviewRequired?: boolean | 'two-reviewer';
  defaultSkills?: readonly string[];             // skill ids; resolved in M8-04, validated as strings here
  sandboxDefault?: SandboxProfileId;
  defaultBudget?: Budget;
}

// apps/daemon/src/application/settings/put-settings-layer.use-case.ts
export class PutSettingsLayer {
  execute(cmd: {
    layer: Exclude<SettingsLayerId, 'defaults' | 'task'>;
    repoPath?: string;                            // required for 'workspace'
    yaml: string;                                 // full layer document
    ifMatchVersion: string;                       // content hash the client last read
    actor: Actor;
  }): Promise<Result<{ version: string; warnings: SettingsWarning[] },
       SettingsError[] | { code: 'E_VERSION_CONFLICT'; currentVersion: string; currentYaml: string }
                     | { code: 'E_LAYER_READONLY'; layer: SettingsLayerId }>>;
}

// apps/daemon/src/application/routing/preview-batch.use-case.ts
export interface SampleTask { id: string; label: string; taskTypeId: TaskTypeId; role: RoleName;
  language?: string; variants?: Record<string, string>; contextEstimateTokens?: number }
export interface BatchPreviewResult {
  rows: readonly { sample: SampleTask; decision: RoutingDecision | { error: 'NoEligibleCandidate';
                     excluded: readonly { ref: ModelRef; reasons: readonly ReasonCode[] }[] } }[];
  summary: { offTopTierPct: number; byProvider: Record<ProviderId, number>;
             unroutable: number; policyVersion: string; settingsVersion: string };
}
export class PreviewAssignmentBatch {
  /** Never persists: no routing_decisions rows, no events, no quota touched. */
  execute(cmd: { repoPath?: string; overlayYaml?: string; overlayLayer?: SettingsLayerId;
                 samples: readonly SampleTask[] }): Promise<Result<BatchPreviewResult, SettingsError[]>>;
}
```

```yaml
# ~/.orchestra/user.yaml  (or org.yaml / workspace.yaml) — sections added by this step
roles:
  reviewer:
    label: Reviewer
    modelPrefs: ["codex/gpt-5", "claude/opus"]
    allowedTaskTypes: [code-review, security-audit]
    budget: { maxTokens: 400000, maxWallClockMs: 1800000 }
  releaser:
    gateOverrides: { release: human }        # may raise, never lower

taxonomy:
  overrides:
    boilerplate:
      weights: { reasoning: 0.10, speed: 0.35, cost: 0.35, context: 0.05, toolReliability: 0.10, platformExpertise: 0.05 }
      defaultSkills: ["clean-arch-flutter-feature"]
    security-audit:
      reviewRequired: two-reviewer           # raising is fine; lowering a high-risk type is E_REVIEW_WEAKENED
```

### 4.3 Data / schema changes
- No new tables. `settings_layers` (M8-01) receives the written YAML on every successful save (mirror in local mode, source of truth in team mode).
- `audit_log` rows: `action: 'settings.put'`, `target: '<layer>:<file>'`, `before_json` / `after_json` = the two YAML documents with secret-shaped values redacted by the standard serializer (they cannot legally be present — M8-01 rejects them — but the redactor stays on).
- `settings.layer_written {layer, file, version, sections[], actor}` event (schema registered in M8-01, first emitted here).
- `routing_decisions` is **not** written by the batch preview. A regression test asserts row count is unchanged after 100 batch previews, because a live panel firing on keystrokes would otherwise flood the decision log.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `AtomicYamlWriter` in `apps/daemon/src/infrastructure/settings/`: write to `<file>.orch-tmp`, `fsync`, `rename` over the target, keep `<file>.bak` (single generation). Mode 0600 for `~/.orchestra/*.yaml`, 0644 for the in-repo `workspace.yaml`.
- Write-then-reload ordering: the watcher will fire on our own write. `SettingsStore` compares the incoming content hash against the just-written one and suppresses the duplicate `settings.reloaded` (idempotency standard) while still swapping the tree.
- `defaults` and `task` layers are read-only (`E_LAYER_READONLY`) — shipped catalog files are never edited in place (M1 "never edit shipped migrations" rule generalised).
- The batch preview uses the same `CandidateBuilder` as M2-04, so provider health, cooling and concurrency counts are real; only the settings tree is overlaid. No process spawn, no network, no tmux.
- The workspace file lives in the repo and may be under version control: after a save the UI offers "copy git command" rather than committing anything itself.

### 4.5 API / UI surface
- `PUT /api/settings/layers/:layer?repo=` — body `{ yaml }`, header `If-Match: <version>`; `200 { version, warnings }`, `409 { code: 'E_VERSION_CONFLICT', currentVersion, currentYaml }`, `422 { errors: SettingsError[] }`.
- `POST /api/settings/validate` — body `{ layer, yaml, repo? }` → `{ errors[], warnings[] }` without writing (used by the editor's gutter, debounced 300 ms).
- `POST /api/routing/preview/batch` — body `{ repo?, overlayYaml?, overlayLayer?, samples? }` → `BatchPreviewResult`. Rate-limited to 10 req/s per connection; `persist` is not a parameter — this endpoint never persists.
- `GET /api/settings/samples?repo=` → shipped samples + (optionally) the last 20 real tasks projected into `SampleTask`.
- CLI: `orch settings set <key> <value> --layer user`, `orch settings edit --layer workspace` (`$EDITOR`, validate on close, refuse invalid), `orch routing simulate --samples <file>` printing the same table as the panel.
- UI `apps/web/src/features/settings/editors/`:
  - `EditorShell` — layer selector (reuses M8-01 `LayerBar`; picking a layer switches which document is edited), split pane (form ⇄ YAML) with a drag handle, toolbar (Validate · Revert · Save), unsaved-changes guard on navigation, "changed on disk" banner with Reload/Overwrite.
  - `PolicyEditor` — workspace/task-type rows, each with primary/fallback/reviewer ref pickers (typeahead over the model catalog, deprecated models flagged), `allow`/`deny` pattern lists with the deny-wins note from M8-01, `epsilon` slider, `leadReserve` fields.
  - `RolesEditor` — role list, per role: model prefs (drag-to-reorder), allowed task types (multiselect), budget caps, sandbox default, gate overrides (raise-only, lower options disabled with a tooltip).
  - `TaskTypeEditor` — task-type list with a shipped/overridden marker; weights as six sliders with a live sum indicator that blocks save when ≠ 1.0; risk, review requirement (lower-disabled where shipped risk is high), default skills, sandbox, budget.
  - `WhatRunsWherePanel` — table (sample task · task type · chosen provider/model · score · top reason · Δ vs saved), header chips (off-top-tier %, per-provider load bars, unroutable count), a per-row "why" popover reusing `RoutingPreview` (M2-06) read-only, and a source toggle (shipped samples ⇄ my last 20 tasks).
  - States: `clean`, `dirty`, `validating`, `invalid` (gutter markers + error list, Save disabled), `saving`, `conflict`, `saved`, `readonly-layer`, `panel-stale` (panel greys while recomputing, never shows stale numbers as current).
- Accessibility: sliders have numeric inputs; the panel is a real `<table>` with row headers; Δ direction is an arrow glyph plus text, not colour.

### 4.6 Flow / sequence
```
open editor ─▶ GET /api/settings/layers + /effective + /schema ─▶ form state ⇄ YAML doc (one source: the YAML CST)
keystroke ─┬─▶ 300 ms debounce ─▶ POST /api/settings/validate ─▶ gutter markers / error list
           └─▶ 300 ms debounce ─▶ POST /api/routing/preview/batch { overlayYaml }
                                     ├─ SettingsResolver.resolve([...layers, overlay]) (in memory)
                                     ├─ CandidateBuilder.build()        (real health, cooling, concurrency)
                                     └─ AssignmentEngine.decide() × 12  ─▶ rows + summary   (nothing persisted)
Save ─▶ PUT /api/settings/layers/:layer  (If-Match)
        ├─ 409 ─▶ "changed on disk" banner ─▶ user picks Reload (discard) or Overwrite (re-PUT with new version)
        └─ 200 ─▶ AtomicYamlWriter ─▶ audit_log + settings.layer_written
                    ─▶ watcher (self-write suppressed) ─▶ SettingsStore.swap ─▶ WS 'settings'
                    ─▶ LayeredPolicyResolver / TaxonomyPort / RoleRegistry re-read ─▶ next real decision uses it
```

## 5. Tasks
- [ ] `RoleDefinition` VO + `validateRole` + `RoleRegistry` (DI, no `switch`) in `packages/core`; register the eighth constraint strategy `allowed-task-types` with reason code `excluded:role-not-permitted`.
- [ ] `TaskTypeOverride` VO + `validateTaskTypeOverride` (weight sum, raise-only review/gate rules) and merge into the M2-01 taxonomy loader.
- [ ] Register `roles` and `taxonomy.overrides` as `SettingsSection`s (schemas, list semantics, `taskOverridable: false`).
- [ ] `PutSettingsLayer` use case: validation → `If-Match` → `AtomicYamlWriter` → audit → event; typed conflict and read-only errors.
- [ ] Self-write suppression in `SettingsStore`; test that a save produces exactly one tree swap and one `settings.layer_written`.
- [ ] `PreviewAssignmentBatch` use case + `packages/catalog/settings/sample-tasks.yaml` (12 samples) + "last 20 real tasks" projection.
- [ ] `settings.controller.ts` additions (`PUT layers/:layer`, `POST validate`, `GET samples`) + `routing.controller.ts` batch endpoint + OpenAPI + rate limit.
- [ ] `EditorShell` in `packages/ui` (split pane, toolbar, dirty guard, conflict banner) with CodeMirror 6 + YAML + JSON Schema completion wired to `GET /api/settings/schema`.
- [ ] Two-way form ⇄ YAML binding over the YAML CST so a form edit preserves comments and key order in the file.
- [ ] `PolicyEditor` with ref typeahead, deprecated-model chips (M6-06), deny-wins explanation on sealed keys.
- [ ] `RolesEditor` with reorderable model prefs, budget caps, raise-only gate overrides.
- [ ] `TaskTypeEditor` with weight sliders + sum guard and raise-only review requirement.
- [ ] `WhatRunsWherePanel` with summary chips, Δ-vs-saved column, per-row why popover, sample-source toggle, stale state.
- [ ] CLI `orch settings set|edit`, `orch routing simulate --samples`.
- [ ] Docs: `docs/` section "Editing policies, roles and task types" incl. the raise-only rules and the deny-wins escalation path.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-02-01 | unit | role with `allowedTaskTypes: [code-review]` scored for a `feature-impl` task | every candidate under that role excluded with `excluded:role-not-permitted`; decision falls back to another role's prefs or `NoEligibleCandidate` with full exclusions |
| UT-M8-02-02 | unit | `gateOverrides` lowering `human → none`; review requirement lowered on a `risk: high` type | `E_GATE_WEAKENED` / `E_REVIEW_WEAKENED`; neither is writable |
| UT-M8-02-03 | unit | task-type weights summing to 0.98 and to 1.0 | reject with the computed sum in the message / accept |
| UT-M8-02-04 | unit | removing a role referenced by a shipped playbook | `E_ROLE_IN_USE` naming the playbook ids |
| UT-M8-02-05 | unit | role `modelPrefs` containing an uninstalled provider ref | warning, not error; the role still loads (M2-09 parity) |
| AT-M8-02-01 | application | `PutSettingsLayer` with a stale `If-Match` | `E_VERSION_CONFLICT` carrying the current version and YAML; file untouched; no audit row |
| AT-M8-02-02 | application | `PutSettingsLayer` with layer `defaults` | `E_LAYER_READONLY`; shipped catalog file byte-identical |
| AT-M8-02-03 | application | 100 × `PreviewAssignmentBatch` | zero new `routing_decisions` rows, zero `routing.*` events, zero sessions started |
| IT-M8-02-01 | integration | save a policy change through the API | file written atomically (`.bak` present), `settings.layer_written` once, next `POST /api/routing/preview` uses the new value within 1 s |
| IT-M8-02-02 | integration | corrupt the layer on disk while the editor is open, then save | `409` conflict with the on-disk content returned; after Reload the editor shows the on-disk version |
| IT-M8-02-03 | integration | batch preview with a provider in `cooling` | that provider's candidates excluded with `excluded:provider-cooling` in every affected row; overlay `allow` cannot re-enable them (C5) |
| E2E-M8-02-01 | e2e | edit primary for `boilerplate` in the form | YAML pane updates, panel re-scores within 1 s, off-top-tier chip changes, Save enabled; after Save the Decisions log shows the new provenance on the next real decision |
| E2E-M8-02-02 | e2e | invalid YAML typed directly in the YAML pane | gutter marker at the line, error list populated, Save disabled, panel shows its last valid result marked *stale* |
| E2E-M8-02-03 | e2e | roles editor budget cap | panel marks the sample tasks that would be blocked by the cap with a text label; axe-clean in dark + RTL; keyboard-only edit and save works |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-02-01 | Live "what runs where" | 1. Settings › Policies, layer `workspace` 2. Set `boilerplate` primary to `agy/gemini-flash` in the form 3. Watch the panel | Panel re-scores all 12 samples in < 1 s; the `boilerplate` row switches model; off-top-tier % rises; YAML pane shows the edit with comments preserved | ⬜ |
| TC-M8-02-02 | Save and effect | 1. Save 2. Open Models › Decisions 3. Quick Delegate a `boilerplate` task | Save succeeds; `settings.layer_written` in History; the new decision picks the edited model with provenance `workspace.yaml:<line>`; an `audit_log` row shows before/after | ⬜ |
| TC-M8-02-03 | Roles with a budget cap | 1. Settings › Roles, give `reviewer` `maxTokens: 50000` 2. Restrict `allowedTaskTypes` to `[code-review, security-audit]` 3. Read the panel | Sample rows in other task types under the reviewer role show *blocked by role* with the reason text; the review samples still route; saving changes nothing about running sessions | ⬜ |
| TC-M8-02-04 | Task-type weights | 1. Settings › Task types › `feature-impl` 2. Drag `cost` up and `reasoning` down 3. Try to save with the sum at 0.97, then fix it | Save is disabled while the sum ≠ 1.0 with the sum displayed; after fixing, the panel's `feature-impl` row moves to a cheaper model and Save succeeds | ⬜ |
| TC-M8-02-05 | Negative: invalid YAML | 1. In the YAML pane delete a closing bracket 2. Observe gutter, error list, Save, panel | Error marker on the exact line; Save disabled; panel keeps its previous result labelled *stale*; switching back to the form pane is refused with "fix the YAML first" | ⬜ |
| TC-M8-02-06 | Negative: raise-only rules | 1. Try to set `security-audit.reviewRequired: false` 2. Try to set a `release` gate from `human` to `none` | Both refused with `E_REVIEW_WEAKENED` / `E_GATE_WEAKENED`; the form controls for the lowering options are disabled with an explanatory tooltip (G3 is not a preference) | ⬜ |
| TC-M8-02-07 | Negative: conflicting layers | 1. Add `deny: ["agy/*"]` to `org.yaml` by hand 2. In the editor (user layer) try to set an agy model as `boilerplate` primary 3. Save and read the panel | The key shows "sealed by org"; the panel's `boilerplate` row excludes agy with `excluded:denied-by-policy` and picks the fallback; the save is allowed but visibly ineffective with a warning chip | ⬜ |
| TC-M8-02-08 | Conflict / resilience | 1. Open the editor 2. In a terminal, append a comment to the same file and save 3. Press Save in the UI 4. Choose Reload, then re-apply and Save | Step 3 shows the "changed on disk" banner and a 409; Reload shows the terminal's comment; the second save succeeds and the `.bak` holds the previous content | ⬜ |
| TC-M8-02-09 | Reload after restart | 1. Save an edit 2. `kill -9` the daemon, restart 3. `orch settings explain roles.reviewer.modelPrefs` | Edit survives; provenance names the layer file and line; the panel reproduces the same table as before the restart | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Policies, roles and task-type overrides are editable from the UI in any writable layer, with form and YAML always in sync and comments/key order preserved on save.
- [ ] The "what runs where" panel re-runs the real assignment engine over the sample set in < 1 s per edit and persists nothing (AT-M8-02-03, TC-M8-02-01).
- [ ] Saves are atomic, `If-Match`-guarded, backed up, audited with before/after, and hot-reloaded within 1 s (IT-M8-02-01, TC-M8-02-02).
- [ ] Raise-only rules hold: review requirement and gates can be strengthened, never weakened; a role in use cannot be deleted (TC-M8-02-06, UT-M8-02-04).
- [ ] Editors can narrow but never widen a compliance gate — cooling, concurrency, cross-vendor and org deny remain effective in the panel and at runtime (IT-M8-02-03, TC-M8-02-07).
- [ ] Invalid input blocks Save, marks the exact line, and never leaves a partially written file on disk (TC-M8-02-05).
- [ ] `defaults` and `task` layers are not writable; shipped catalog files are byte-identical after any editor session (AT-M8-02-02).
- [ ] All three editors are keyboard-operable and axe-clean in dark/light and RTL; Δ and status are icon + text, never colour alone.
- [ ] All TC-M8-02-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Two-way form ⇄ YAML binding is the hard part.** Round-tripping through a CST preserves comments but makes every form control a CST edit. Mitigation: one binding layer, exercised by a property test that applies random form edits and asserts comments and unrelated key order survive. If round-tripping proves unreliable, degrade to "form edits replace the section node" and say so in the UI rather than silently dropping comments.
- **Panel cost.** Twelve `decide()` calls per keystroke is cheap, but `CandidateBuilder` touches provider health and session counts. Mitigation: build candidates once per editor session and refresh on the `fleet` WS topic, not per keystroke; the 10 req/s rate limit is the backstop.
- **Sample tasks are a fiction.** A user tuning against 12 synthetic samples can optimise for the wrong distribution. Mitigation: the "my last 20 tasks" source is one toggle away and is the recommended mode once history exists; the panel labels which source it used.
- **Role budgets overlap M4-04 budgets and M4-04 reserves.** Three caps can interact confusingly ("why was this blocked?"). The panel names *which* cap blocked each sample; if the interaction still confuses in TC-M8-02-03, the fix is a combined "effective caps" readout, not more caps.
- **Saving `workspace.yaml` writes inside the user's repo**, which an agent in a worktree could later commit. M2-09 §8 flagged this; here the surface grows. Mitigation unchanged for M8: the daemon reads the main checkout, every write is audited, and the file belongs on the Repair Agent deny list (C12) in M10-01. Consider a workspace-settings `.gitignore` recommendation in the docs.
- **CodeMirror 6 + JSON Schema completion** depends on the composed schema being accurate for every registered section; sections registered later in M8 must ship their schema with the section or completion silently degrades. Enforced by a test that every registered section has a non-empty JSON Schema.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
