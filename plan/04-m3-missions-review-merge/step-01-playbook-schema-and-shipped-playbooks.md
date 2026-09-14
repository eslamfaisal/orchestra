# Step M3-01 — Playbook schema & shipped playbooks

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M2-01 |
| Estimated effort | 2 days |
| Packages touched | `packages/catalog`, `packages/sdk`, `packages/core`, `apps/daemon`, `apps/cli` |
| Risk | Low |
| Owner | |

## 1. Goal
After this step a **Playbook** is a validated, versioned YAML artifact the daemon can load, list and hand to a Lead. Six playbooks ship in `packages/catalog/playbooks/` (`new-feature-fullstack`, `bugfix`, `refactor`, `dependency-upgrade`, `incident`, `release`). A user can run `orch playbook validate <file>` and get line-level errors for a broken playbook (cycle, unknown task type, bad budget split), and `GET /playbooks` returns the merged set (shipped + user overrides + workspace). Nothing executes a playbook yet — that is M3-02.

## 2. Why
- D7 (intelligence layer is data, not code): mission shapes must change without a release. Playbooks are the last catalog artifact family after taxonomy (M2-01) and model profiles (M2-02).
- D3 (two-tier orchestration): the Lead instantiates a *template DAG*; the daemon can then enforce dependency order deterministically instead of trusting the LLM's ordering (R11).
- G3: `reviewRounds` and `gate` per step are how cross-vendor review becomes mandatory by construction rather than by Lead goodwill.
- G7: playbooks are one of the versioned artifact families third parties will publish (M10-03) and users edit (M8-07).

## 3. Scope
### In scope
- Zod schema `packages/catalog/schemas/playbook.schema.ts` + TS types in `packages/sdk/src/playbook.ts`.
- Pure DAG rules in `packages/core/src/playbook/` (acyclicity, dependency resolution, ready-set computation, budget-share sum).
- Six shipped playbooks as YAML with a `README.md` per file header comment.
- `PlaybookLoader` (shipped → `~/.orchestra/catalog-overrides/playbooks/` → `<repo>/.orchestra/playbooks/`), hot reload, persistence into `playbooks` table.
- `orch playbook validate|list|show`, `GET /playbooks`, `GET /playbooks/:id`, `POST /playbooks/validate`.
### Out of scope (deferred to …)
- Executing a playbook / Lead prompt composition — deferred to M3-02.
- Playbook editor UI, per-workspace versioning UX — deferred to M8-07.
- `4-eyes` gate semantics (two distinct approvers) — accepted by schema, treated as `human` with a load-time warning until M9-04.
- Signed playbook distribution from a registry — deferred to M10-03.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Playbook` (value object, immutable): `id`, `version` (semver), `name`, `missionType`, `steps[]`, `scope: shipped|user|workspace`.
- `PlaybookStep`: `id`, `title`, `taskType: TaskType`, `role: RoleName`, `executor: 'lead'|'delegate'` (default `delegate`; `lead` = the Lead does this step itself, e.g. `plan`), `dependsOn: StepId[]`, `requiredSkills: string[]`, `gate: Gate`, `reviewRounds: 0..3`, `budgetShare: 0..1`, `multiplicity: 'one'|'many'` (Lead may instantiate `many` steps several times, e.g. one `feature-impl` per layer), `goalTemplate?: string`.
- `Gate = 'none' | 'lead' | 'human' | '4-eyes'` — applied after review approval, before the task is merged/marked done (see M3-02 §4.1 for lifecycle placement).
- `RoleName` closed set for M3: `lead | architect | researcher | implementer | tester | reviewer | writer | releaser` (editable in M8-02).
- Rules (`packages/core/src/playbook/rules.ts`, all return `Result`):
  - `validateDag(steps)`: unique ids; every `dependsOn` exists; no self-dependency; acyclic (Kahn's algorithm, reports the cycle path); at least one root step.
  - `validateBudget(steps)`: Σ `budgetShare` ≤ 1.0 (+1e-6); warn (not error) if < 0.5 (`W_BUDGET_LOW`). The remainder is reserved for review tasks and Lead usage (M4-04 makes reserves explicit).
  - `readySteps(playbook, completed: Set<StepId>)`: steps whose deps ⊆ completed, in stable topological order.
  - `crossCheck(playbook, taxonomy)`: every `taskType` exists; `reviewRounds ≥ 1` when taxonomy says `reviewRequired` for that task type (error `E_REVIEW_REQUIRED`); `two-reviewer` types keep `reviewRounds ≥ 1`.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/playbook.ts
export type Gate = 'none' | 'lead' | 'human' | '4-eyes';
export interface PlaybookStep {
  id: string; title: string; taskType: TaskType; role: RoleName;
  executor?: 'lead' | 'delegate'; dependsOn?: string[]; requiredSkills?: string[];
  gate?: Gate; reviewRounds?: number; budgetShare: number;
  multiplicity?: 'one' | 'many'; goalTemplate?: string;
}
export interface Playbook {
  id: string; version: string; name: string; description?: string;
  missionType: 'feature' | 'bugfix' | 'refactor' | 'upgrade' | 'incident' | 'release' | 'custom';
  defaults?: { gate?: Gate; reviewRounds?: number };
  steps: PlaybookStep[];
}
// packages/core/src/playbook/ports.ts
export interface PlaybookRepository {
  list(): Promise<Result<PlaybookRecord[], RepoError>>;
  get(id: string, version?: string): Promise<Result<PlaybookRecord, PlaybookNotFound>>;
  upsert(rec: PlaybookRecord): Promise<Result<void, RepoError>>;
}
export type PlaybookError =
  | { code: 'E_DUP_STEP'; stepId: string }
  | { code: 'E_UNKNOWN_DEP'; stepId: string; dep: string }
  | { code: 'E_CYCLE'; path: string[] }
  | { code: 'E_UNKNOWN_TASKTYPE'; stepId: string; taskType: string }
  | { code: 'E_BUDGET_OVER'; sum: number }
  | { code: 'E_REVIEW_REQUIRED'; stepId: string };
```
Shipped YAML shape (excerpt of `new-feature-fullstack.yaml`):
```yaml
id: new-feature-fullstack
version: 1.0.0
name: New feature (full-stack)
missionType: feature
defaults: { gate: none, reviewRounds: 2 }
steps:
  - { id: research,  title: Map affected code,      taskType: codebase-qa,      role: researcher,  budgetShare: 0.05, reviewRounds: 0 }
  - { id: adr,       title: Write ADR,              taskType: adr-writing,      role: architect,   dependsOn: [research], gate: lead, reviewRounds: 1, budgetShare: 0.05 }
  - { id: plan,      title: Decompose into tasks,   taskType: decomposition,    role: lead, executor: lead, dependsOn: [adr], budgetShare: 0.05 }
  - { id: implement, title: Implement layer,        taskType: feature-impl,     role: implementer, dependsOn: [plan], multiplicity: many, budgetShare: 0.45 }
  - { id: tests,     title: Tests,                  taskType: test-gen,         role: tester,      dependsOn: [implement], reviewRounds: 1, budgetShare: 0.15 }
  - { id: docs,      title: Docs,                   taskType: api-docs,         role: writer,      dependsOn: [implement], reviewRounds: 1, budgetShare: 0.05 }
  - { id: checklist, title: Deploy checklist,       taskType: deploy-checklist, role: releaser,    dependsOn: [tests, docs], gate: human, reviewRounds: 0, budgetShare: 0.05 }
```
Shipped set (step ids in DAG order; `→` = dependsOn):

| Playbook | Steps | Notable gates / rounds |
|---|---|---|
| `new-feature-fullstack` | research → adr → plan(lead) → implement(many) → {tests, docs} → checklist | adr: lead; checklist: human; implement: 2 rounds |
| `bugfix` | triage(codebase-qa) → fix(bugfix) → regression(test-gen) → changelog | fix: 2 rounds |
| `refactor` | map(codebase-qa) → plan(lead) → refactor(many) → tests(test-gen) → docs(readme) | refactor: lead gate, 2 rounds |
| `dependency-upgrade` | audit(dependency-audit) → upgrade(dependency-upgrade) → verify(test-gen) → changelog | upgrade: 1 round; verify: 1 round |
| `incident` | triage(incident) → hotfix(bugfix) → verify(test-gen) → postmortem(adr-writing) | hotfix: human gate, 1 round (expedited) |
| `release` | changelog → bump(release) → checklist(deploy-checklist) → notes(pr-description) | bump + checklist: human gate |

### 4.3 Data / schema changes
- `playbooks` table already in schema v1 (`id, name, version, scope, yaml`). Migration `m3_01_playbooks_meta`: add `source_path TEXT`, `checksum TEXT`, `loaded_at TEXT`, unique `(id, version, scope)`. Loader upserts by checksum (idempotent).
- No new event types beyond `catalog.playbook_invalid`; loader failures are logged and surfaced as a **health item** in the Fleet screen (reuse M2-01's catalog health row).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/catalog/playbook-loader.ts`: reads three roots in precedence order **workspace > user > shipped**; same id at higher precedence shadows lower (both persisted, `scope` differs). Uses the chokidar watcher from M2-01; debounce 300 ms; invalid file ⇒ keep last-known-good, emit health item.
- Pure fs; no network; no child processes.

### 4.5 API / UI surface
- `GET /playbooks` → `{ playbooks: [{id, version, name, scope, missionType, stepCount, warnings[]}] }`.
- `GET /playbooks/:id?version=` → full resolved playbook + `topologicalOrder[]`.
- `POST /playbooks/validate` body `{ yaml }` → `{ ok, errors[], warnings[] }` (never persists).
- CLI (`apps/cli`, extends M2-01's `orch` skeleton): `orch playbook validate <file|--all>`, `orch playbook list --json`, `orch playbook show <id>`. Exit code 1 on any error; errors printed as `file:line: E_CYCLE research → adr → research`.
- UI: no new screen; the start-mission dialog in M3-02 consumes `GET /playbooks`.

### 4.6 Flow / sequence
```
boot ─▶ PlaybookLoader.loadAll()
          ├─ read shipped/*.yaml ─▶ zod parse ─▶ core.validateDag/validateBudget/crossCheck(taxonomy)
          ├─ read ~/.orchestra/catalog-overrides/playbooks/*.yaml (same)
          ├─ read <repo>/.orchestra/playbooks/*.yaml (per registered workspace)
          └─ upsert playbooks table ─▶ emit `catalog.playbooks_loaded {count, warnings}`
file change ─▶ debounce ─▶ re-validate single file ─▶ ok: swap in memory + upsert ; err: keep old + health item
```

## 5. Tasks
- [ ] Add `RoleName` closed set + `Gate` VO to `packages/core` (with 100 % branch tests on rule functions).
- [ ] Implement `validateDag`, `validateBudget`, `readySteps`, `crossCheck` in `packages/core/src/playbook/rules.ts`.
- [ ] Write Zod schema in `packages/catalog/schemas/playbook.schema.ts`; export types from `packages/sdk/src/playbook.ts`.
- [ ] Author the six YAML playbooks in `packages/catalog/playbooks/` with header comments (purpose, when to pick it).
- [ ] Add `catalog/playbooks/README.md` documenting fields, gate semantics, `multiplicity`, `executor`.
- [ ] Migration `m3_01_playbooks_meta`; `SqlitePlaybookRepository` + `InMemoryPlaybookRepository`.
- [ ] `PlaybookLoader` with precedence, checksum idempotency, chokidar hot reload, last-known-good on error.
- [ ] Wire catalog health item for invalid playbooks (reuse M2-01 mechanism).
- [ ] HTTP controller `PlaybooksController` (`GET /playbooks`, `GET /playbooks/:id`, `POST /playbooks/validate`) with Zod DTOs + OpenAPI.
- [ ] CLI commands `orch playbook validate|list|show`.
- [ ] Contract test: every shipped playbook validates against the shipped taxonomy (runs in CI).
- [ ] fast-check property test for `validateDag`.
- [ ] Update `packages/catalog/README.md` and `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-01-01 | unit | `validateDag` on a 3-node cycle | `Err({code:'E_CYCLE', path:[a,b,c,a]})` |
| UT-M3-01-02 | unit | `validateDag` with unknown dep / duplicate id / self-dep | one error per defect, all reported (no short-circuit) |
| UT-M3-01-03 | unit (property) | fast-check: random acyclic DAGs (≤ 30 nodes) validate; inserting one back-edge fails | 100 % of generated cases behave as stated |
| UT-M3-01-04 | unit | `readySteps` after completing `{research}` in `new-feature-fullstack` | `[adr]`; after `{…, plan}` → `[implement]` |
| UT-M3-01-05 | unit | `validateBudget` sums 1.0000001 / 1.2 / 0.4 | ok / `E_BUDGET_OVER` / ok + `W_BUDGET_LOW` |
| UT-M3-01-06 | unit | `crossCheck`: step with `taskType: feature-impl` and `reviewRounds: 0` | `E_REVIEW_REQUIRED` |
| CT-M3-01-01 | contract | all six shipped playbooks vs shipped taxonomy | zero errors; warnings only for `4-eyes` (none expected) |
| AT-M3-01-01 | application | loader precedence: same id in shipped + workspace | `GET /playbooks/:id` returns workspace version; both rows in table |
| IT-M3-01-01 | integration | hot reload: write invalid YAML into overrides dir | previous version still served; health item present; fix file → item cleared |
| IT-M3-01-02 | integration | `orch playbook validate tests/fixtures/playbooks/cycle.yaml` | exit 1, stderr contains `E_CYCLE` with path |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-01-01 | Validate all shipped playbooks | 1. `pnpm build` 2. `orch playbook validate --all` | Prints 6 lines `ok <id>@<version>`; exit 0 | ⬜ |
| TC-M3-01-02 | Cycle detection (negative) | 1. Copy `bugfix.yaml` to `~/.orchestra/catalog-overrides/playbooks/bad.yaml` 2. Make `triage` depend on `changelog` 3. `orch playbook validate ~/.orchestra/catalog-overrides/playbooks/bad.yaml` | Exit 1; message `bad.yaml:<line>: E_CYCLE triage → fix → regression → changelog → triage` | ⬜ |
| TC-M3-01-03 | Workspace override shadows shipped | 1. Copy `refactor.yaml` into `~/orchestra-scratch/.orchestra/playbooks/` 2. Change `name` to "Refactor (mine)" 3. `curl :4300/playbooks` with token | Entry `refactor` has `scope: workspace`, name "Refactor (mine)" | ⬜ |
| TC-M3-01-04 | Hot reload keeps last-known-good | 1. Daemon running 2. Break YAML indentation in the override from TC-03 3. Watch Fleet health 4. Fix the file | Health shows "playbook refactor invalid: <parse error>" within 2 s; `GET /playbooks/refactor` still returns previous content; after fix the item disappears | ⬜ |
| TC-M3-01-05 | Unknown task type rejected | 1. Add step `taskType: telepathy` to a copy 2. Validate | Exit 1; `E_UNKNOWN_TASKTYPE telepathy` and a hint listing 3 closest taxonomy ids | ⬜ |
| TC-M3-01-06 | Restart persistence | 1. Stop daemon 2. Start daemon 3. `sqlite3 ~/.orchestra/orchestra.db "select id,version,scope from playbooks"` | 6 shipped rows + the workspace row, `loaded_at` updated; no duplicates | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Six playbooks ship, validate in CI (CT-M3-01-01) and load at boot in < 200 ms total (logged).
- [ ] `packages/core/src/playbook/rules.ts` has 100 % branch coverage.
- [ ] `orch playbook validate` reports every defect with file, line and stable error code; exit code semantics documented.
- [ ] Precedence workspace > user > shipped is enforced and tested (AT-M3-01-01).
- [ ] Invalid edits never remove a working playbook (IT-M3-01-01, TC-M3-01-04).
- [ ] `catalog/playbooks/README.md` documents every field including `executor`, `multiplicity`, gate placement.
- [ ] All TC-M3-01-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations (`packages/core` still imports nothing).

## 8. Risks / open questions
- Role set is fixed in code for M3; if M8-02 makes roles data-driven, `RoleName` becomes a validated string — keep the VO constructor as the single choke point.
- `budgetShare` is a fraction of a mission budget that only becomes real in M4-04; until then it is advisory and only validated.
- Should `executor: lead` steps count toward `budgetShare`? Decision here: yes (Lead tokens are mission cost); revisit in M4-04.
- Line numbers in YAML errors require the `yaml` package's CST positions — verify the chosen YAML library exposes node ranges at step start.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
