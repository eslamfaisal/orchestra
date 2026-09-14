# Step M2-09 — Routing policy file & decision log

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-04 |
| Estimated effort | 1 day |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `apps/cli` |
| Risk | Low |
| Owner | |

## 1. Goal
After this step routing is configurable without touching code: a `routing:` block in `<repo>/.orchestra/workspace.yaml` overrides the shipped default matrix per task type (`primary`, `fallback`, `reviewer`, `allow`, `deny`) and per workspace (`allow`, `deny`, `epsilon`, `leadReserve`), validated by a Zod schema, hot-reloaded within 2 s, and never replacing the last-known-good policy when invalid. Every decision the engine has ever made is browsable in a **Decisions** log (filterable by task type, provider, outcome, dry-run, date) with a "why this model" panel showing the score breakdown, the ordered reasons, the alternatives and every excluded candidate with its reason — plus the full decision history of a single task (initial assignment, overrides, reassignments, future automatic reroutes).

## 2. Why
- D7: routing policy is data. A user must be able to say "in this repo, `test-gen` goes to Sonnet" and have it take effect without a release, a restart, or a code change.
- D3: a deterministic engine is only trustworthy if its inputs and outputs are inspectable; the decision log is the accountability half of the two-tier design.
- G2: the KPI "≥ 60 % of tasks routed off the top-tier model" is computed from `routing_decisions`; this screen is where it is verified per task and, from M4-07, aggregated.
- C10: decisions are part of the audit trail for spend; an override or reassignment must be attributable (`actor`) and explainable after the fact.
- G7: the policy file is the first user-editable versioned artifact of the intelligence layer; M8-01/M8-02 layer user and org scopes on the exact schema defined here.

## 3. Scope
### In scope
- Zod schema `packages/catalog/schemas/routing-policy.schema.ts` for the `routing:` block (shared by the shipped default matrix and the workspace file) + exported JSON Schema for editor completion.
- `WorkspacePolicyLoader` + chokidar watcher on `<repo>/.orchestra/workspace.yaml` per registered repo; last-known-good semantics; `policy.reloaded` / `policy.invalid` events.
- `LayeredPolicyResolver` implementing `PolicyPort` (M2-04): `workspace` over `default-matrix`, with per-task-type merge rules and a recorded provenance per field.
- Decision log: `GET /api/routing/decisions` (filters + cursor), `GET /api/tasks/:id/decisions`, Decisions screen with list + "why this model" detail panel, reachable from the Board card menu, the task drawer and Models.
- `orch routing explain <taskId|decisionId>` and `orch routing policy show|validate`.
### Out of scope (deferred to …)
- User-, org- and task-scoped layers and the precedence diff view → M8-01.
- Editing the policy from the UI (form + YAML editor with live "what runs where") → M8-02.
- Aggregated KPI charts over decisions (off-top-tier %, window utilisation) → M4-07.
- Automatic reroute decisions on 429 → M4-03 (they appear in this log for free via `routing.rerouted`).
- Outcome-driven weight adjustment and scorecards → M8-06.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `PolicySet` (M2-04) gains `provenance: Record<field, 'default-matrix' | 'workspace'>` so every reason chip can say where the rule came from (`policy-primary (workspace)`).
- Merge rules in `LayeredPolicyResolver` (pure, `packages/core/src/intelligence/policy/`):
  - Per task type, a layer that defines `primary` **replaces** the lower layer's `primary` (no concatenation — a partial override would be unpredictable). Same for `fallback` and `reviewer`.
  - `allow` / `deny` **accumulate** across layers; `deny` always wins over `allow` at any layer (a workspace cannot re-allow what a higher layer denies — relevant once M8-01 adds org scope).
  - Scalars (`epsilon`, `leadReserve`) take the nearest defining layer.
  - A task type absent from the workspace file inherits the default matrix row unchanged.
  - Refs are `<provider>/<model>` with `*` allowed in the model position for `allow`/`deny` patterns only (`claude/*`), never for `primary`/`fallback`/`reviewer`.
- Validation rules (schema + refinements): unknown task-type id ⇒ error; ref that matches no model in the catalog ⇒ **warning** (a profile may arrive later, and a policy must not break when a provider is temporarily uninstalled); `primary ∩ deny ≠ ∅` ⇒ error (self-contradiction); `epsilon ∈ [0, 0.2]`.
- Compliance: the policy file can narrow but never widen a compliance gate. `deny` is honoured; `allow` cannot re-enable a candidate excluded by `excluded:provider-cooling`, `excluded:concurrency-limit`, `excluded:same-vendor-as-author` (when the task type requires cross-vendor review) or a ToS-gated provider (C5, C6, G3, C11). Enforced by evaluating policy allow/deny as one constraint strategy among the seven, never as a bypass.

### 4.2 Interfaces / contracts
```yaml
# <repo>/.orchestra/workspace.yaml   (routing block only; other keys belong to M8-01)
routing:
  version: 1
  epsilon: 0.03
  allow: ["claude/*", "codex/*"]        # optional workspace-wide narrowing
  deny:  ["agy/*"]                      # e.g. this repo must not leave the two opted-in vendors
  leadReserve: { refs: ["claude/opus"], minFreeSessions: 1 }
  taskTypes:
    test-gen:
      primary:  ["claude/sonnet"]
      fallback: ["codex/gpt-5-codex"]
    security-audit:
      reviewer: ["claude/opus", "codex/gpt-5"]
      deny: ["agy/gemini-flash"]
```
```ts
// packages/core/src/intelligence/policy/layered-policy-resolver.ts
export type PolicyLayerId = 'default-matrix' | 'workspace';          // M8-01 adds 'org' | 'user' | 'task'
export interface PolicyLayer { id: PolicyLayerId; version: string; policy: PolicySetInput }
export class LayeredPolicyResolver implements PolicyPort {
  constructor(private readonly layers: readonly PolicyLayer[]) {}     // ordered lowest → highest
  resolve(taskTypeId: TaskTypeId): PolicySet;                          // with provenance per field
  version(): string;                                                   // hash over all layer versions
}

// packages/catalog/src/loaders/routing-policy-loader.ts
export type PolicyLoadError =
  | { code: 'YAML_PARSE'; file: string; message: string }
  | { code: 'SCHEMA'; file: string; issues: ZodIssue[] }
  | { code: 'UNKNOWN_TASK_TYPE'; id: string; file: string }
  | { code: 'CONTRADICTION'; detail: string; file: string };          // primary ∩ deny
export type PolicyLoadWarning = { code: 'UNKNOWN_MODEL_REF'; ref: string; file: string };
export function loadRoutingPolicy(fs: FileSource, file: string, taxonomy: TaxonomyPort):
  Promise<Result<{ policy: PolicySetInput; warnings: PolicyLoadWarning[] }, PolicyLoadError[]>>;

// apps/daemon/src/application/routing/list-decisions.use-case.ts
export class ListRoutingDecisions {
  execute(q: { taskTypeId?: TaskTypeId; provider?: ProviderId; dryRun?: boolean; actorKind?: ActorKind;
               from?: string; to?: string; cursor?: string; limit: number }): Promise<Result<DecisionPage, never>>;
}
```

### 4.3 Data / schema changes
No new tables — `routing_decisions` (extended in M2-04) already stores `breakdown_json`, `excluded_json`, `reasons_json`, `alternatives_json`, `policy_version`, `catalog_version`, `engine_version`, `actor_json`, `inputs_hash`, `dry_run`. Migration `m2_09_decisions_index`: indexes `routing_decisions(created_at DESC)`, `(task_id, created_at)`, `(task_type, created_at DESC)`, `(chosen_provider, created_at DESC)`. New events: `policy.reloaded {scope:'workspace', repoPath, version, warnings}` and `policy.invalid {scope, repoPath, errors[], keptVersion}` (mirroring the `catalog.*` pair from M2-01 so the Fleet health row treats them the same way).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- One `WorkspacePolicyWatcher` per repo registered in the M1-03 repo registry; chokidar with `awaitWriteFinish`, 250 ms debounce; a repo added at runtime gets a watcher immediately, a removed repo's watcher is disposed.
- Missing `workspace.yaml` or missing `routing:` key is the normal case, not an error: the resolver runs with the default-matrix layer only.
- Invalid file: keep the last-known-good workspace layer (or none), emit `policy.invalid`, show a Fleet health warning and a banner on the Decisions screen. The daemon never fails a preview because a policy file is broken — it routes with the last good policy and says so in the decision's provenance.
- No network. The file is read-only to the daemon in M2 (writing it is M8-02).

### 4.5 API / UI surface
- `GET /api/routing/decisions?taskType=&provider=&dryRun=&actorKind=&from=&to=&cursor=&limit=` → `{ decisions: DecisionRowDto[], nextCursor }`.
- `GET /api/routing/decisions/:id` (from M2-04) → full decision incl. breakdown/excluded.
- `GET /api/tasks/:id/decisions` → chronological history for one task (`assigned → override → reassigned → rerouted`).
- `GET /api/routing/policy?repo=` → the resolved `PolicySet` with per-field provenance, layer versions, warnings and the source file path.
- CLI: `orch routing policy show [--repo <path>] [--task-type <id>] [--json]` prints the effective policy with provenance; `orch routing policy validate [--repo <path>]` exits 0/2/3 like `orch catalog validate`; `orch routing explain <taskId|decisionId> [--json]` prints the "why this model" panel as a table.
- Decisions screen (`apps/web/src/features/routing/decisions/`), reached from the nav under **Models → Decisions**, from a Board card menu ("Open decision") and from the task drawer: `DecisionsScreen` (filter bar + virtualized list: time, task type, chosen ref, score, top reason, actor, dry-run marker, task link), `WhyThisModelPanel` (reuses `RoutingPreview` from M2-06 in read-only mode and adds: per-weight breakdown table with weight × dimension = product and the sum, provenance line "policy: workspace (`.orchestra/workspace.yaml`) · catalog 2026.09.1 · engine 1.0.0", excluded table, alternatives, and a "policy at that time" note when the current policy version differs), `TaskDecisionHistory` (timeline of the task's decisions with from → to arrows).
- States: `loading`, `empty` ("no decisions yet"), `filtered-empty`, `policy-invalid` banner, `error`. Dry-run rows are visually distinct by an explicit *preview* label (not colour alone) and are filtered out by default.

### 4.6 Flow / sequence
```
boot / file change ─▶ WorkspacePolicyWatcher ─▶ loadRoutingPolicy(fs, <repo>/.orchestra/workspace.yaml, taxonomy)
   ├─ ok  ─▶ LayeredPolicyResolver.swap([default-matrix, workspace]) ─▶ emit policy.reloaded(+warnings)
   └─ err ─▶ keep last-known-good ─▶ emit policy.invalid ─▶ Fleet health + Decisions banner

any preview/decision (M2-04/06/07, M2-05 delegate, M4-03 reroute)
   ─▶ PolicyPort.resolve(taskTypeId) ─▶ PolicySet{…, provenance} ─▶ AssignmentEngine.decide
   ─▶ RoutingDecision.reasons include 'policy-primary' with detail = provenance layer
   ─▶ persisted with policy_version ─▶ routing.decided|dry_run

Decisions screen ─▶ GET /api/routing/decisions?filters ─▶ list
   ─▶ select row ─▶ GET /api/routing/decisions/:id ─▶ WhyThisModelPanel
        breakdown table · reasons · alternatives · excluded(N) · provenance · "policy changed since" note
Board card ─▶ "Open decision" ─▶ same panel   |   task drawer ─▶ GET /api/tasks/:id/decisions ─▶ history timeline
```

## 5. Tasks
- [ ] `routing-policy.schema.ts` (Zod) covering the `routing:` block + refinements (contradiction, epsilon range, ref patterns) + JSON Schema export.
- [ ] `loadRoutingPolicy()` with taxonomy cross-check, error/warning split; unit tests with an in-memory `FileSource`.
- [ ] `LayeredPolicyResolver` with the merge rules of §4.1 and per-field provenance; 100 % branch tests (it feeds the engine's coverage gate).
- [ ] Replace M2-04's default-matrix-only `PolicyPort` binding with the layered resolver (DI swap, no engine change).
- [ ] `WorkspacePolicyWatcher` per registered repo; add/remove on repo registry changes; `policy.reloaded` / `policy.invalid` event schemas; Fleet health row.
- [ ] Policy-allow/deny implemented as the existing allowlist constraint strategy so it can never bypass a hard gate; test that `allow` cannot re-enable a cooling or cross-vendor-excluded candidate.
- [ ] Migration `m2_09_decisions_index`; `ListRoutingDecisions` + `GetTaskDecisions` use cases; controllers + OpenAPI.
- [ ] `GET /api/routing/policy` returning the resolved set with provenance, warnings and file path.
- [ ] `apps/web`: `DecisionsScreen`, filter bar with URL sync, virtualized list, `WhyThisModelPanel` (read-only `RoutingPreview` + breakdown table + provenance), `TaskDecisionHistory`.
- [ ] Entry points: nav item under Models, Board card menu action, task drawer link.
- [ ] CLI: `orch routing policy show|validate`, `orch routing explain`.
- [ ] Docs: `packages/catalog/README.md` section "Routing overrides in workspace.yaml" with the annotated example and the merge rules.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-09-01 | unit | merge: workspace defines `primary` for one task type | that type's primary replaced; all other types identical to the default matrix; provenance says `workspace` |
| UT-M2-09-02 | unit | `allow`/`deny` accumulation with a conflicting pair | `deny` wins; a candidate denied at any layer stays excluded (`excluded:denied-by-policy`) |
| UT-M2-09-03 | unit | `primary` containing a ref that is also in `deny` | `Err([CONTRADICTION])`; loader rejects the file |
| UT-M2-09-04 | unit | unknown task-type id vs unknown model ref | error vs warning (policy still loads with the warning) |
| UT-M2-09-05 | unit | policy `allow` for a cooling provider / for the author's vendor on a cross-vendor task type | candidate still excluded — policy cannot widen a compliance gate (C5, G3) |
| AT-M2-09-01 | application | `ListRoutingDecisions` with filters + cursor | correct rows, stable ordering, no duplicates across pages; dry-runs excluded unless requested |
| IT-M2-09-01 | integration | write a `routing:` block at runtime | `policy.reloaded` within 2 s; the next `POST /api/routing/preview` chooses the overridden model with reason detail `workspace` |
| IT-M2-09-02 | integration | corrupt the block (sum of nonsense keys / bad YAML) | `policy.invalid` emitted; previews keep using the last-known-good policy; daemon alive; Fleet row warns |
| IT-M2-09-03 | integration | delete the `routing:` block | falls back to default matrix within 2 s; provenance returns to `default-matrix` |
| E2E-M2-09-01 | e2e | Decisions screen with seeded decisions | list filters by task type and provider; detail panel shows breakdown summing to `capabilityFit` ± 0.001 and every candidate accounted for |
| E2E-M2-09-02 | e2e | task history after an override and a reassignment | three chronological entries with from → to and actor labels |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-09-01 | Workspace override takes effect | 1. Preview a `test-gen` task, note the chosen model 2. Add `routing: { taskTypes: { test-gen: { primary: ["claude/sonnet"] } } }` to `~/orchestra-scratch/.orchestra/workspace.yaml` 3. Save 4. Preview again | Second preview chooses `claude/sonnet` within 2 s with reason `policy-primary` and detail `workspace`; no daemon restart | ⬜ |
| TC-M2-09-02 | Provenance visible end-to-end | 1. Run the overridden task 2. Open Models → Decisions → the newest row | "Why this model" shows the workspace provenance line with the file path, the per-weight breakdown, alternatives and the excluded table | ⬜ |
| TC-M2-09-03 | Deny narrows, allow cannot widen | 1. Add `deny: ["agy/*"]` 2. Preview a task whose default primary is an agy model 3. Then add `allow: ["agy/*"]` alongside the deny and repeat | First: agy excluded with `excluded:denied-by-policy` and the fallback chosen. Second: still excluded — deny wins (C-compliance rule holds) | ⬜ |
| TC-M2-09-04 | Negative: broken policy file | 1. Set `epsilon: 3` and an unknown task type in the block 2. Save | Fleet health shows *routing policy invalid (2 errors)*; Decisions screen shows the banner; previews keep working with the previous policy; `orch routing policy validate` exits non-zero naming both problems | ⬜ |
| TC-M2-09-05 | Task decision history | 1. Delegate a task, override the model in the preview 2. Let it fail, reassign it from the Board to another provider 3. Open the task drawer → Decisions | Three entries in order (initial, user-override, reassignment) each with actor, from → to and the reason list; opening any shows its own "why this model" panel | ⬜ |
| TC-M2-09-06 | CLI parity | 1. `orch routing policy show --task-type test-gen` 2. `orch routing explain <taskId>` | The effective policy matches what the UI shows, with provenance per field; `explain` prints the same chosen/score/reasons/alternatives as the Decisions panel | ⬜ |
| TC-M2-09-07 | Restart / resilience | 1. With a valid workspace override in place, `kill -9` the daemon 2. Restart 3. Preview the same task type | Override still applied after boot (watcher re-established); decision log shows both previews; policy version hash unchanged across the restart | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] A `routing:` block in `.orchestra/workspace.yaml` changes the next preview within 2 s, with no restart, and its provenance is visible in the decision (TC-M2-09-01/02).
- [ ] An invalid policy file never replaces the last-known-good policy and never fails a preview (IT-M2-09-02, TC-M2-09-04).
- [ ] Policy can narrow but never widen a compliance gate: `allow` cannot re-enable cooling, concurrency-capped, ToS-gated or cross-vendor-excluded candidates (UT-M2-09-05, TC-M2-09-03).
- [ ] Every decision in the log answers "why this model" completely: breakdown, reasons with provenance, alternatives, excluded with reasons, catalog/policy/engine versions.
- [ ] `GET /api/tasks/:id/decisions` returns the full chronology including overrides and reassignments, and renders as a timeline (TC-M2-09-05).
- [ ] `LayeredPolicyResolver` at 100 % branch coverage; the engine itself is unchanged (DI swap only) and its golden suite still passes with the default-matrix-only layer.
- [ ] Decisions screen is keyboard-operable, axe-clean in light/dark and RTL, and dry-run rows are labelled with text, not colour.
- [ ] All TC-M2-09-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Two files now shape routing (`packages/catalog/routing/default-matrix.yaml`, `<repo>/.orchestra/workspace.yaml`) and M8-01 will add three more layers. The merge rules must stay boring and printable; `orch routing policy show` exists precisely so "which rule won" is never guesswork. If the provenance output proves hard to read in TC-M2-09-06, fix the output, not the rules.
- Replace-not-merge for `primary` lists is a deliberate choice that will surprise someone who expected to append one model. Documented in the catalog README and shown in the provenance line; revisit only with an ADR.
- `deny` beating `allow` at every layer means a workspace cannot recover from an over-broad org deny once M8-01 lands. That is the intended direction for enterprise (M9), but note it in the M8-01 step so the escalation path (an admin edits the org layer) is designed, not discovered.
- The policy file lives inside the repo and is therefore editable by any agent working in a worktree. In M2 the worktrees are per task and the file read is from the main repo path, but a malicious or careless agent could still commit a policy change. Mitigation for now: the loader reads the repo's main checkout (not a worktree), and every reload is an event in the audit trail; a proper guard (policy files in the Repair Agent deny list, C12) belongs to M10-01.
- Decision volume grows with every preview. Dry-runs are purged after 7 days (M2-04); if the Decisions list still feels heavy before M5-06 retention lands, add a `dryRun=false` default filter (already the default here) rather than deleting rows.
- `policy_version` recorded on a decision is a hash, not a snapshot: after a policy edit the old decision cannot be re-derived exactly. The panel therefore shows "policy has changed since this decision" instead of pretending to reconstruct it; storing full policy snapshots per decision is an M8-01 question.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
