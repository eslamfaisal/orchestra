# Step M2-01 — Task taxonomy catalog

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M1-13 |
| Estimated effort | 2 days |
| Packages touched | `packages/catalog`, `packages/core`, `apps/daemon`, `apps/cli` |
| Risk | Low |
| Owner | |

## 1. Goal
After this step the task taxonomy from `06-intelligence-layer.md §1` exists as versioned YAML data in `packages/catalog/taxonomy/`, validated by a Zod schema, loaded by the daemon at boot and hot-reloaded on file change, and checkable offline with `orch catalog validate`. The daemon exposes `GET /api/catalog/taxonomy`; a broken file never replaces the last-known-good taxonomy and is surfaced as a Fleet health warning. Every later step (engine, MCP `capabilities()`, Quick Delegate task-type picker, playbooks in M3-01) reads task types only through the `TaxonomyPort`.

## 2. Why
- D7: intelligence is data, not code — task types must change without a release.
- D3: the deterministic engine (M2-04) needs typed inputs: `requiredCapabilities`, `weights`, `risk`, `reviewRequired`.
- G2 (right model for the job) and G7 (extensible artifacts) — the taxonomy is the first versioned catalog artifact.
- C10: `risk` per task type drives approval gates later (M3-04, M9-04); it must be declared here, not inferred.

## 3. Scope
### In scope
- `packages/catalog/taxonomy/<group>.yaml` — 10 group files covering all 38 task types (list in §4.1) with variants.
- Zod schema `packages/catalog/schemas/task-type.schema.ts` + exported JSON Schema (`schemas/task-type.schema.json`) for editor validation.
- Pure loader `packages/catalog/src/loaders/taxonomy-loader.ts` (fs injected; returns `Result`).
- Daemon `CatalogModule` (`apps/daemon/src/infrastructure/catalog/`) with chokidar watcher, last-known-good swap, `catalog.reloaded` / `catalog.invalid` events.
- `TaxonomyPort` in `packages/core` + in-memory implementation for tests.
- `orch catalog validate` (minimal `apps/cli` scaffold with commander; offline; exit codes).
- `GET /api/catalog/taxonomy` and WS topic `catalog`.
### Out of scope (deferred to …)
- Model profiles and overrides → M2-02.
- Per-workspace / per-user task-type overrides and editors → M8-02.
- Playbooks and skill packs (same loader pattern) → M3-01, M8-04.
- Hot reload of manifests from a registry → M6-03.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`TaskType` is an immutable value object in `packages/core/src/intelligence/task-type.ts`. Rules enforced by the schema and by `TaskType.create()` (core, `Result`):
- `weights` keys exactly `{reasoning, speed, cost, context, toolReliability, platformExpertise}`, each 0…1, sum = 1.0 ± 0.001.
- `requiredCapabilities ∩ preferredCapabilities = ∅`; both ⊆ `CapabilityFlag` (`subagents hooks mcp skills websearch imagegen vision nativeReview planMode sandbox appServer streamJsonInput elicitation`).
- `risk: high ⇒ reviewRequired ≠ false`.
- `id` unique across all files; kebab-case; `group` matches the file name.

Task types (38, must all exist; a unit test enumerates this list):
`codebase-qa research dependency-audit spike | architecture api-design data-model ux-spec | decomposition estimation deploy-checklist | feature-impl boilerplate bulk-edit ui-impl refactor dependency-upgrade i18n | test-gen bugfix code-review security-audit perf-optimization | schema-migration query-optimization data-script | infra release incident | readme api-docs adr-writing changelog pr-description commit-message | prompt-engineering ai-integration | quick`.
Variants: `feature-impl.layer ∈ {domain,data,app,presentation}`, `ui-impl.platform ∈ {flutter,swiftui,compose,react}`, `test-gen.level ∈ {unit,integration,e2e}`, `code-review.focus ∈ {correctness,security,performance,architecture}`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/task-type.ts
export type TaskTypeId = string;                       // kebab-case, validated at the edge
export type TaskGroup = 'discovery'|'design'|'planning'|'build'|'quality'|'data'|'platform'|'docs'|'ai'|'misc';
export type RiskLevel = 'low'|'medium'|'high';
export interface TaskWeights { reasoning: number; speed: number; cost: number; context: number; toolReliability: number; platformExpertise: number; }
export interface TaskType {
  id: TaskTypeId; group: TaskGroup; label: string; description: string;
  variants?: Record<string, readonly string[]>;        // e.g. { layer: ['domain','data','app','presentation'] }
  requiredCapabilities: readonly CapabilityFlag[];
  preferredCapabilities: readonly CapabilityFlag[];
  weights: TaskWeights;
  risk: RiskLevel;
  reviewRequired: boolean | 'two-reviewer';
  defaultBudget: Budget;                                // { maxTurns?: number; maxMinutes?: number; costTierCap?: 1|2|3|4|5 }
  defaultSkills: readonly string[];
  sandboxDefault: SandboxProfileId;                     // 'read-only' | 'workspace-write' | 'full' (provider maps it in M2-03)
}
export interface TaxonomyPort {
  get(id: TaskTypeId): Result<TaskType, TaskTypeNotFound>;
  list(): readonly TaskType[];
  version(): CatalogVersion;                            // { hash: string; loadedAt: string; source: 'shipped'|'override' }
}

// packages/catalog/src/loaders/taxonomy-loader.ts  (pure; no fs import — FileSource injected)
export interface FileSource { list(dir: string): Promise<string[]>; read(path: string): Promise<string>; }
export type TaxonomyLoadError =
  | { code: 'YAML_PARSE'; file: string; message: string }
  | { code: 'SCHEMA'; file: string; issues: ZodIssue[] }
  | { code: 'DUPLICATE_ID'; id: string; files: string[] }
  | { code: 'MISSING_TASK_TYPES'; ids: string[] };
export function loadTaxonomy(fs: FileSource, dir: string): Promise<Result<Taxonomy, TaxonomyLoadError[]>>;
```
```yaml
# packages/catalog/taxonomy/quality.yaml (excerpt)
version: 1
group: quality
taskTypes:
  - id: bugfix
    label: Bug fix / debug
    requiredCapabilities: [hooks]
    preferredCapabilities: [sandbox, subagents]
    weights: { reasoning: 0.30, speed: 0.15, cost: 0.10, context: 0.15, toolReliability: 0.25, platformExpertise: 0.05 }
    risk: medium
    reviewRequired: true
    defaultBudget: { maxTurns: 60, maxMinutes: 45, costTierCap: 4 }
    defaultSkills: []
    sandboxDefault: workspace-write
  - id: security-audit
    weights: { reasoning: 0.45, speed: 0.05, cost: 0.05, context: 0.25, toolReliability: 0.15, platformExpertise: 0.05 }
    risk: high
    reviewRequired: two-reviewer
    sandboxDefault: read-only
    …
```
Zod schema (`schemas/task-type.schema.ts`) mirrors the interface and adds `.superRefine` for the weight sum and capability disjointness; `TaxonomyFileSchema = { version: z.literal(1), group, taskTypes: z.array(TaskTypeSchema).min(1) }`.

### 4.3 Data / schema changes
None in SQLite. The taxonomy is file-backed; the daemon keeps it in memory. New event types (extension of `04-domain-model.md §3`, namespace `catalog.*`): `catalog.reloaded {kind:'taxonomy', version, counts}`, `catalog.invalid {kind, errors[], keptVersion}`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/catalog/catalog.module.ts` registers `TaxonomyWatcher` (chokidar on the resolved catalog dir, debounce 250 ms, `awaitWriteFinish`) and `InMemoryTaxonomy` (implements `TaxonomyPort`, atomic swap of the whole map).
- Catalog dir resolution order: `config.catalog.taxonomyDir` → `<repo>/packages/catalog/taxonomy` in dev → bundled copy in the daemon package in release builds.
- Load failure at boot: daemon starts with an empty taxonomy only if `config.catalog.strict = false` (default `true` ⇒ fail fast with the error list).
- Load failure at runtime: keep last-known-good, emit `catalog.invalid`, Fleet health row `catalog: invalid (3 errors)`.

### 4.5 API / UI surface
- `GET /api/catalog/taxonomy` → `{ version, taskTypes: TaskType[] }` (Zod-serialised, ETag = version hash).
- `GET /api/catalog/taxonomy/:id` → `TaskType | 404 TaskTypeNotFound`.
- WS topic `catalog`: `catalog.reloaded` / `catalog.invalid` events.
- CLI: `orch catalog validate [--dir <path>] [--json]` → exit 0 (valid), 2 (schema/parse errors), 3 (missing task types). Human output lists each error as `file:line  CODE  message`.
- Fleet screen (M1-10): one health row "Catalog" with version hash and last reload time (small addition, no new screen).

### 4.6 Flow / sequence
```
boot ─▶ TaxonomyWatcher.loadAll() ─▶ loadTaxonomy(fs, dir)
        ├─ ok  ─▶ InMemoryTaxonomy.swap(map, version) ─▶ emit catalog.reloaded ─▶ WS `catalog`
        └─ err ─▶ strict? fail boot : keep previous ─▶ emit catalog.invalid ─▶ Fleet health warning
file change (chokidar, debounced) ─▶ same path as boot, but never fails the process
```

## 5. Tasks
- [ ] Add `CapabilityFlag`, `RiskLevel`, `Budget`, `SandboxProfileId` value objects to `packages/core` (if not already present from M0-02) with exhaustive unit tests.
- [ ] Write `TaskType` VO + `TaskType.create()` rules + `TaxonomyPort` in `packages/core/src/intelligence/`.
- [ ] Write `schemas/task-type.schema.ts` (Zod) + script `pnpm --filter catalog build:json-schema` emitting `schemas/task-type.schema.json`.
- [ ] Author the 10 YAML group files with all 38 task types; weights derived from `06 §1`/`§4` intent (reviewed in PR description as a table).
- [ ] Implement `loadTaxonomy()` with injected `FileSource`; unit tests with an in-memory `FileSource`.
- [ ] Add the "all 38 ids present" test and the "every group file's `group` matches filename" test.
- [ ] Add property test (fast-check): random weight vectors → schema accepts iff sum within tolerance.
- [ ] Scaffold `apps/cli` (commander, `orch` bin, `catalog validate` only) — shared `CatalogValidator` used by CLI and daemon boot.
- [ ] Implement `CatalogModule` + `TaxonomyWatcher` (chokidar) + `InMemoryTaxonomy` in the daemon; register the `catalog` WS topic.
- [ ] Add `catalog.*` event schemas to the event catalog (Zod per type) and the Fleet health row.
- [ ] Add `GET /api/catalog/taxonomy[/:id]` controller with OpenAPI annotations.
- [ ] Integration test: temp dir → daemon boots → mutate a file → reload event within 2 s; corrupt a file → `catalog.invalid`, old version still served.
- [ ] Docs: `packages/catalog/README.md` section "Taxonomy: adding a task type" (fields, weights rule, validation command).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-01-01 | unit | `TaskType.create()` with weights summing to 1.05 | `Err(InvalidWeights)`; sum 1.0004 accepted |
| UT-M2-01-02 | unit | required ∩ preferred non-empty | `Err(CapabilityOverlap)` |
| UT-M2-01-03 | unit | `risk: high` with `reviewRequired: false` | `Err(HighRiskNeedsReview)` |
| UT-M2-01-04 | unit | shipped YAML files loaded through in-memory `FileSource` | `Ok`, exactly 38 ids, all groups present |
| UT-M2-01-05 | unit | duplicate id across two group files | `Err([DUPLICATE_ID])` naming both files |
| UT-M2-01-06 | property | fast-check weight vectors | schema accepts ⇔ |sum−1| ≤ 0.001 and all in [0,1] |
| AT-M2-01-01 | application | `GetTaxonomy` use case with `InMemoryTaxonomy` | returns list sorted by group then id; `version.hash` stable across calls |
| IT-M2-01-01 | integration | daemon boot with temp taxonomy dir; edit `docs.yaml` | `catalog.reloaded` on WS within 2 s; `GET` returns new label |
| IT-M2-01-02 | integration | write invalid YAML at runtime | `catalog.invalid` emitted; previous version still served; process alive |
| IT-M2-01-03 | integration | `orch catalog validate --dir <bad>` | exit 2, error lines include file and code; `--json` output parses |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-01-01 | Validate shipped catalog | 1. `pnpm build` 2. `orch catalog validate` | Prints `taxonomy: 38 task types OK`, exit code 0 | ⬜ |
| TC-M2-01-02 | Hot reload changes a label | 1. Start daemon 2. Open Fleet → Catalog row shows hash H1 3. Edit `docs.yaml`: label of `changelog` → "Changelog entry" 4. Save | Within 2 s Fleet row shows a new hash; `GET /api/catalog/taxonomy/changelog` returns the new label; no restart | ⬜ |
| TC-M2-01-03 | Negative: broken weights at runtime | 1. Daemon running 2. Set `bugfix.weights.cost` to 0.5 (sum 1.4) 3. Save | Fleet Catalog row turns to *invalid (1 error)*; `GET …/bugfix` still returns old weights; `orch catalog validate` exits 2 naming `quality.yaml` and `bugfix` | ⬜ |
| TC-M2-01-04 | Negative: strict boot | 1. Stop daemon 2. Keep the broken file 3. Start daemon | Daemon exits non-zero with the same error list in the log (`config.catalog.strict = true`) | ⬜ |
| TC-M2-01-05 | Restart / resilience | 1. Fix the file 2. Start daemon 3. `kill -9` daemon 4. Start again | Both boots load 38 task types; version hash identical; Fleet row healthy | ⬜ |
| TC-M2-01-06 | API contract | 1. `curl -H "Authorization: Bearer $(cat ~/.orchestra/token)" localhost:4300/api/catalog/taxonomy` 2. Repeat with `If-None-Match` of the returned ETag | First: 200 with 38 entries; second: 304 | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All 38 task types from `06-intelligence-layer.md §1` load; unit test enumerates them by id.
- [ ] Every `weights` block sums to 1.0 ± 0.001 (schema-enforced and property-tested).
- [ ] `orch catalog validate` exits 0 on shipped data, non-zero with actionable messages on each error class in §4.2.
- [ ] Hot reload swaps atomically within 2 s; invalid files never replace last-known-good (IT-M2-01-02).
- [ ] `TaxonomyPort` is the only way daemon code reads task types (dependency-cruiser rule: no import of `packages/catalog/taxonomy/*` outside the loader).
- [ ] `packages/core` still has zero runtime dependencies; coverage 100 % branches on `task-type.ts`.
- [ ] All TC-M2-01-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Weight values are initial opinion; they only become evidence-based in M8-06. Record the rationale table in the PR so later tuning has a baseline.
- `orch` CLI is scheduled for M7-06 in ROADMAP, but this step needs `catalog validate`. Decision here: create the minimal `apps/cli` scaffold now; M7-06 extends it. Flag in `PROGRESS.md` change log.
- `sandboxDefault` uses provider-neutral ids; the mapping to vendor profiles (Codex `read-only|workspace-write|full`, agy `request-review|always-proceed`, Claude permission modes) lives in manifests (M2-03). If a provider lacks an equivalent, the engine treats it as a constraint miss (M2-04).
- Bundling the catalog into release builds (Tauri sidecar) is decided in ADR-005 (M7-01); until then the dev-repo path is used.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
