# Step M6-06 — Model lifecycle

| Field | Value |
|---|---|
| Milestone | M6 — Self-maintenance |
| Status | ⬜ Not started |
| Depends on | M6-03, M2-02, M2-04, M2-09 |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step a model being deprecated, renamed or removed by a vendor stops being a silent trap. A catalog or manifest update is diffed into typed `ModelLifecycleChange`s; the assignment engine immediately re-scores so no new task is routed to a dead model; every policy artifact that still *names* it — routing policy, role defaults, task-type overrides, playbooks, prompt library entries — is scanned and flagged with a precise pointer ("your `architect` role lists a deprecated model: `claude/opus` → `claude/opus-2`"); and the user gets an Attention item with a **one-click migration suggestion** that shows the exact YAML diff before anything is written, applies it on approval, and records an audit entry. Nothing is rewritten without a human clicking Apply.

## 2. Why
- D6 / `00-source-plan-v0.2.md` §10.4 — "model added/renamed/deprecated → catalog update → engine re-scores → affected policies flagged → one-click migration suggestion" is the fourth pillar of self-maintenance.
- D7 — the intelligence layer is data; a model going away must be absorbable by editing data, not by shipping a release.
- G2 (right model for the job) and G4 (never blocked) — a task routed to a model the vendor removed fails at launch and burns a window; re-scoring prevents it, and M6-02 classifies the leftovers as `model-missing`.
- C10 — a policy file is user configuration; migrating it is a mutating action, so it is previewed, permissioned and audited.
- C12 — the migration writes policy/catalog-override YAML only; it never touches auth, allowlists, ToS or compliance rules, and it reuses the `ForbiddenPathGuard` from M6-04.
- M2-02 deliberately shipped `validTo`, `evidence[]` and `source` "because M6-06 needs them"; M6-04's `RerouteTask` fixes the *task*, this step fixes the *configuration* that keeps producing the bad task.

## 3. Scope
### In scope
- Pure `ModelLifecycleRule` in `packages/core`: diff (previous catalog + manifests) vs (new catalog + manifests) → `ModelLifecycleChange[]`.
- Pure `PolicyReferenceScanner`: find every `ModelRef` occurrence across the loaded policy layers with a file path + JSON pointer + human label.
- Pure `MigrationSuggestion` builder: for each reference, a replacement candidate (rename target first, then an assignment-engine re-score) plus reasons and a YAML/JSON-patch preview.
- Daemon: `DetectModelLifecycleChanges`, `BuildMigrationSuggestion`, `ApplyModelMigration` use cases; Attention item kind `model_deprecated`; deprecated-model exclusion wired into the engine's `constraints()` gate; re-assignment of *queued* tasks.
- `model_lifecycle_changes` table, events `catalog.model_lifecycle_changed`, `policy.migration_suggested`, `policy.migrated`; audit rows.
- Models screen additions (deprecation reason, "used by N policies" link) and the Attention migration card with a diff modal.
- `orch models lifecycle`, `orch models migrate` CLI.
### Out of scope (deferred to …)
- Full policy/role/task-type editors — deferred to M8-02; this step writes a targeted patch into an existing file, it is not an editor.
- Learning-loop weight adjustment and scorecards — deferred to M8-06.
- Downloading catalog updates from the registry — the transport is M6-03; this step consumes whatever the catalog loader produces (shipped package, registry, or local override).
- Rerouting a *running* or already-assigned-and-started task — deferred to M6-04 (`RerouteTask`) and M4-03; here only `draft`/`assigned`-but-not-started tasks are re-scored.
- Migrating a model referenced inside a skill or an instruction fragment — deferred to M8-04/M8-08 (the scanner reports them as `unmanaged` references so the user can fix them by hand).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/intelligence/lifecycle/{model-lifecycle-rule.ts, policy-reference-scanner.ts, migration-suggestion.ts}` — pure, `Clock` injected.

Change detection (`ModelLifecycleRule.diff(prev, next, now)`), one branch per row:

| # | Condition | `change` |
|---|---|---|
| R-M1 | ref present in `next`, absent in `prev` | `added` |
| R-M2 | `next` profile `validTo != null && validTo ≤ now`, previously open | `deprecated` (`reason: 'catalog-valid-to'`) |
| R-M3 | manifest `models[].deprecated === true`, previously false | `deprecated` (`reason: 'manifest-flag'`) — manifest wins over catalog (M2-02 rule) |
| R-M4 | ref absent from `next` manifest `models[]` while the provider is installed and its manifest verified | `removed` (`reason: 'absent-from-manifest'`) |
| R-M5 | a `next` model lists the old id in `aliases[]`, or the catalog profile carries `renamedTo` | `renamed` (`renamedTo` set; supersedes `deprecated`/`removed` for the same ref) |
| R-M6 | previously deprecated, now open again | `undeprecated` |

Rules: **R-M7** a change is only emitted when the provider's manifest is *verified* (M6-05) or bundled — an unverified manifest mid-canary must not delete half the catalog. **R-M8** `removed` never deletes a `model_profiles` row (M2-02: rows are closed with `valid_to`, never deleted — `outcomes` reference them). **R-M9** deprecation never touches a running session or an already-started task; it is forward-looking only. **R-M10** a `renamed` change automatically proposes `renamedTo` as the replacement with `confidence: 'vendor-alias'`; anything else goes through the engine.

`PolicyReferenceScanner.scan(layers)` walks the loaded, *already validated* policy layers (M2-09 routing policy, M8-01's precursor layering: task > user > workspace > org > defaults) and returns `PolicyReference[]`: `{layer, filePath, jsonPointer, ref, label, managed}`. `label` is the human sentence fragment the UI shows ("`architect` role · primary", "task type `security-audit` · reviewer", "playbook `release` · step 3"). `managed: false` for references found in skills/instruction fragments (reported, never auto-patched).

`buildMigrationSuggestion(change, refs, engineCandidates)` → `MigrationSuggestion`: for each managed reference, a `replacement` (rename target, else the highest-scoring non-deprecated candidate that satisfies the same constraints, preferring the same provider then the same cost tier), `reasons[]` copied from the `RoutingDecision` explainability, and `patch: JsonPatchOp[]` + a rendered YAML diff. **R-M11** a suggestion with no valid replacement is still produced, marked `blocked` with the reason (e.g. "no non-deprecated model of this provider satisfies `requiredCapabilities`"), so the user sees the problem instead of a silent skip. **R-M12** the builder is pure — it produces a patch, it never writes.

Engine integration: `constraints(model, task)` gains gate `notDeprecated` — a deprecated or removed model scores 0 for *new* decisions, and `RoutingDecision.reasons[]` records `model_deprecated`. Queued tasks in state `draft`/`assigned` whose `assigned_model` became invalid are re-assigned by `ReassignQueuedTasks`, emitting `routing.rerouted` with `reason: 'model_deprecated'`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/lifecycle/model-lifecycle-rule.ts   (pure; 100 % branch)
export type LifecycleChangeKind = 'added' | 'deprecated' | 'renamed' | 'removed' | 'undeprecated';
export type LifecycleReason = 'catalog-valid-to' | 'manifest-flag' | 'absent-from-manifest' | 'alias' | 'renamed-to' | 'reopened';
export interface ModelLifecycleChange {
  id: string; ref: ModelRef;                      // "<provider>/<modelId>"
  change: LifecycleChangeKind; reason: LifecycleReason;
  renamedTo?: ModelRef; detectedAt: string; effectiveAt: string;
  source: { kind: 'catalog' | 'manifest'; version: string };
}
export interface LifecycleSnapshot {
  profiles: ReadonlyMap<string, Pick<ModelProfile, 'ref' | 'validFrom' | 'validTo'> & { renamedTo?: ModelRef }>;
  manifestModels: ReadonlyMap<ProviderId, readonly { id: ModelId; deprecated?: boolean; aliases?: readonly string[] }[]>;
  verifiedProviders: ReadonlySet<ProviderId>;
}
export declare function diffLifecycle(prev: LifecycleSnapshot, next: LifecycleSnapshot, now: string): readonly ModelLifecycleChange[];

// packages/core/src/intelligence/lifecycle/policy-reference-scanner.ts   (pure)
export interface PolicyReference {
  layer: 'task' | 'user' | 'workspace' | 'org' | 'defaults';
  filePath: string; jsonPointer: string;          // RFC 6901, e.g. /roles/architect/primary
  ref: ModelRef; label: string; managed: boolean;
}
export declare function scanPolicyReferences(docs: readonly { layer: PolicyReference['layer']; filePath: string; json: unknown }[]): readonly PolicyReference[];

// packages/core/src/intelligence/lifecycle/migration-suggestion.ts   (pure; 100 % branch)
export interface MigrationTarget {
  reference: PolicyReference; replacement: ModelRef | null;
  confidence: 'vendor-alias' | 'engine-score' | 'none';
  reasons: readonly string[]; patch: readonly JsonPatchOp[]; blocked?: string;
}
export interface MigrationSuggestion {
  id: string; changeId: string; ref: ModelRef; targets: readonly MigrationTarget[];
  applicable: boolean;                            // ≥ 1 non-blocked managed target
  unmanaged: readonly PolicyReference[];          // skills / instruction fragments — reported only
}
export declare function buildMigrationSuggestion(c: ModelLifecycleChange, refs: readonly PolicyReference[],
  candidates: (r: PolicyReference) => readonly { ref: ModelRef; score: number; reasons: readonly string[] }[],
  ids: IdGenerator): MigrationSuggestion;

// apps/daemon/src/application/ports/lifecycle.ports.ts
export interface ModelLifecycleRepository {
  append(c: ModelLifecycleChange): Promise<Result<void, StorageError>>;
  list(q: { since?: string; ref?: ModelRef; limit: number }): Promise<Result<ModelLifecycleChange[], StorageError>>;
  lastSnapshotHash(): Promise<Result<string | null, StorageError>>;
}
export interface PolicyDocumentStore {                       // reads + writes policy YAML with comment preservation
  load(): Promise<Result<{ layer: PolicyReference['layer']; filePath: string; json: unknown; raw: string }[], PolicyIoError>>;
  applyPatch(filePath: string, ops: readonly JsonPatchOp[]): Promise<Result<{ before: string; after: string }, PolicyIoError>>;
}
```
Use cases (`apps/daemon/src/application/intelligence/`): `DetectModelLifecycleChanges` (on catalog/manifest reload), `BuildMigrationSuggestion`, `PreviewModelMigration`, `ApplyModelMigration`, `ReassignQueuedTasks`, `ListModelLifecycleChanges`.

### 4.3 Data / schema changes
- Migration `NNN-m6-06-model-lifecycle`: `model_lifecycle_changes (id TEXT PK, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, change TEXT NOT NULL, reason TEXT NOT NULL, renamed_to TEXT, detected_at TEXT NOT NULL, effective_at TEXT NOT NULL, source_json TEXT NOT NULL, suggestion_json TEXT, resolved_at TEXT, resolution TEXT)`; index `(provider_id, model_id, detected_at DESC)`. Postgres-compatible types only.
- `model_profiles.valid_to` is set (never deleted) for `removed`/`deprecated` (R-M8); a `renamed` change also writes a `renamed_to TEXT` column added here.
- Events: `catalog.model_lifecycle_changed` `{changeId, ref, change, reason, renamedTo?, source}`; `policy.migration_suggested` `{suggestionId, changeId, ref, targetCount, blockedCount}`; `policy.migrated` `{suggestionId, files: string[], applied: number, actor}`. Existing `provider.model_deprecated` (introduced by M2-02) remains the low-level signal; this step consumes it and adds the lifecycle layer. `audit_log` rows for every apply with `before/after` = the changed YAML fragment (redacted serializer applies).
- Attention item kind `model_deprecated` with payload `{changeId, suggestionId, ref, label, targetCount}`.
- Config `intelligence.lifecycle`: `{ enabled: true, autoReassignQueuedTasks: true, suggestOnRemovedOnly: false, gracePeriodMs: 0 }` (`gracePeriodMs` delays flagging when a vendor announces a future `validTo`).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/intelligence/lifecycle/` — `LifecycleDetector` subscribes to `catalog.reloaded{kind:'models'}` (M2-02) and `provider.manifest_reloaded` (M6-03), builds a `LifecycleSnapshot` from `ModelCatalogPort` + `ManifestRegistry` + the verified-provider set (M6-05), diffs against the persisted previous snapshot (hash-compared to skip no-ops) and appends changes. No network, no processes.
- `PolicyDocumentStoreFs` reads the layered policy files (`~/.orchestra/config.yaml` policy section, `<repo>/.orchestra/workspace.yaml`, `~/.orchestra/policies/*.yaml`) and applies JSON-patch ops through a **comment-preserving YAML round-trip** (`yaml` package `Document` API) so a user's comments and key order survive. Writes are atomic (`.tmp` + `rename`), guarded by `ForbiddenPathGuard` (M6-04) — policy paths are on the allow list, everything else is denied — and a `.bak` copy is kept next to the file for one generation.
- Candidate supply: `ApplicationEngineAdapter` calls M2-04's `AssignmentEngine` in dry-run mode with the reference's context (task type / role from the JSON pointer) and `excludeDeprecated: true`, returning `{ref, score, reasons}` — the same explainability strings the "why this model" panel shows, so the migration card and the routing panel never disagree.
- `ReassignQueuedTasks` walks `tasks` in state `draft`/`assigned` with `session_id IS NULL` whose `assigned_model` is now invalid and re-runs assignment, writing a new `routing_decisions` row with `reasons += ['model_deprecated']` and emitting `routing.rerouted`. Tasks already `running` are untouched (R-M9).

### 4.5 API / UI surface
- `GET /api/catalog/models/lifecycle?since=&limit=` → `ModelLifecycleChange[]` with the embedded suggestion summary.
- `GET /api/catalog/models/:provider/:model/references` → `PolicyReference[]` (powers "used by N policies").
- `GET /api/migrations/:suggestionId/preview` → `{targets, unifiedDiff: string, blocked: MigrationTarget[]}`.
- `POST /api/migrations/:suggestionId/apply` `{targetIds?: string[]}` (`Idempotency-Key`, audited, RBAC-ready) → `{files, applied, skipped}`; `POST /api/migrations/:suggestionId/dismiss {reason}`.
- WS topic `catalog` gains `{event:'model_lifecycle_changed'|'migration_suggested'|'migrated', payload}`.
- CLI: `orch models lifecycle [--since 7d] [--json]`, `orch models references <provider>/<model>`, `orch models migrate <suggestionId> [--dry-run] [--json]` (dry-run prints the unified diff and exits 0; apply requires `--yes` in non-interactive mode).
- UI:
  - **Attention** — `ModelDeprecatedItem` card: title "Deprecated model in your policies: `claude/opus`", body "used by 3 policy entries (architect · primary, security-audit · reviewer, playbook release · step 3)", actions **Review migration** (opens the diff modal), **Dismiss**.
  - **Migration diff modal** (`apps/web/src/features/models/MigrationDiffModal.tsx`): per-target row with the policy label, old → new ref, the engine's reasons, a checkbox (opt out per target), blocked targets shown with their reason and disabled, and a unified YAML diff pane. Apply is disabled until at least one target is selected; the button text names the files it will write (UX principle 5, zero-surprise control).
  - **Models screen** (M2-02) — the existing deprecated badge gains a tooltip with `reason` and `renamedTo`, plus a "used by N policies" link that opens the references list. States: loading, empty ("no lifecycle changes in this window"), error, blocked-only.
  - Status conveyed by icon + label, never colour alone; RTL-safe; the modal is keyboard-navigable and `⌘K` exposes "Review model migrations".

### 4.6 Flow / sequence
```
catalog.reloaded{models} | provider.manifest_reloaded
 → LifecycleDetector.snapshot(catalog, manifests, verifiedProviders)
 → diffLifecycle(prev, next, now)        [R-M1..R-M7]
 → per change: repo.append + emit catalog.model_lifecycle_changed
    ├─ engine: constraints gate 'notDeprecated' now returns 0 for the ref   (new decisions only)
    ├─ ReassignQueuedTasks (draft/assigned, not started) → routing.rerouted(model_deprecated)
    └─ scanPolicyReferences(layers) → refs
         refs.length === 0 ⇒ stop (no item)
         else buildMigrationSuggestion(change, refs, engineCandidates)
              → persist suggestion_json → emit policy.migration_suggested
              → Attention item 'model_deprecated'
user: Review migration → GET preview (unified diff, per-target reasons, blocked list)
user: Apply (selected targets) → ApplyModelMigration
      → ForbiddenPathGuard.assertWritable(files) → PolicyDocumentStore.applyPatch (comment-preserving, .bak)
      → policy reload (M2-09 watcher) → emit policy.migrated + audit_log row
      → Attention item resolved
```

## 5. Tasks
- [ ] `packages/core/src/intelligence/lifecycle/`: `ModelLifecycleChange`, `LifecycleSnapshot`, `PolicyReference`, `MigrationSuggestion`, `MigrationTarget` types.
- [ ] Pure `diffLifecycle()` implementing R-M1…R-M7; golden table; 100 % branch coverage.
- [ ] Pure `scanPolicyReferences()` (JSON-pointer walk, `managed` classification, label rendering) with fixtures for routing policy, roles, task-type overrides, playbooks, prompt library.
- [ ] Pure `buildMigrationSuggestion()` incl. R-M10/R-M11 (`blocked` targets) and JSON-patch generation.
- [ ] Migration `model_lifecycle_changes` + `model_profiles.renamed_to`; repository (SQLite + in-memory).
- [ ] `LifecycleDetector` (snapshot build, hash short-circuit, subscription to catalog + manifest reload, verified-provider gate R-M7).
- [ ] Assignment-engine `notDeprecated` constraint gate + `reasons` string; update M2-04 golden tests that assumed all models eligible.
- [ ] `ReassignQueuedTasks` use case (draft/assigned only) emitting `routing.rerouted{reason:'model_deprecated'}`.
- [ ] `PolicyDocumentStoreFs`: comment-preserving YAML patch, atomic write, `.bak`, `ForbiddenPathGuard` integration.
- [ ] `DetectModelLifecycleChanges`, `BuildMigrationSuggestion`, `PreviewModelMigration`, `ApplyModelMigration`, `ListModelLifecycleChanges` use cases.
- [ ] Event registration (`catalog.model_lifecycle_changed`, `policy.migration_suggested`, `policy.migrated`) + audit interceptor coverage for apply/dismiss.
- [ ] Attention item kind `model_deprecated` + resolution on apply/dismiss.
- [ ] HTTP controllers + Zod DTOs + OpenAPI; WS `catalog` events.
- [ ] `apps/cli/src/commands/models.ts`: `lifecycle`, `references`, `migrate` (with `--dry-run` / `--yes`).
- [ ] Web: `ModelDeprecatedItem` card, `MigrationDiffModal`, Models-screen tooltip + "used by N policies" link (`packages/ui` diff view reused from M3-05).
- [ ] Fixtures: catalog override marking `fake-pro` deprecated with `renamedTo: fake-pro-2`, a routing policy referencing it in three places, and one unmanaged reference inside a skill.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M6-06-01 | unit | `diffLifecycle` golden table over R-M1…R-M6, incl. manifest-flag beating catalog `validTo` and alias-implied rename | one change per row with exact `change`/`reason`/`renamedTo`; 100 % branch |
| UT-M6-06-02 | unit | R-M7: provider unverified mid-canary, models absent from the new manifest | no `removed` changes emitted; a warning recorded |
| UT-M6-06-03 | unit | `scanPolicyReferences` over the fixture policy set | 3 managed refs with correct JSON pointers and labels; 1 unmanaged (skill) ref |
| UT-M6-06-04 | unit | `buildMigrationSuggestion` when no non-deprecated model satisfies `requiredCapabilities` | target `blocked` with the reason; `applicable: false`; still returned (R-M11) |
| UT-M6-06-05 | unit (fast-check) | `scanPolicyReferences` + `buildMigrationSuggestion` over random JSON documents | never throws; pointers always resolve on the source document; patches are well-formed |
| AT-M6-06-01 | application | catalog reload marking a model deprecated with 3 references | one change row, one suggestion, one Attention item, one `policy.migration_suggested`; re-running the reload produces no duplicates (hash short-circuit) |
| AT-M6-06-02 | application | queued task assigned to the deprecated model | re-assigned before start; `routing.rerouted` with `reason: 'model_deprecated'`; a `running` task with that model is untouched |
| AT-M6-06-03 | application | `ApplyModelMigration` with one of three targets deselected | only the selected files patched; `applied: 2`; audit row lists exactly those pointers |
| IT-M6-06-01 | integration | apply against a real YAML policy file with comments and anchors | comments, key order and anchors preserved; `.bak` written; policy watcher reloads without validation errors |
| IT-M6-06-02 | integration | apply attempt where the policy path is outside the allow list (symlinked config) | `GuardViolation`; nothing written; audit row; API returns a typed error |
| E2E-M6-06-01 | e2e | deprecate `fake-pro` via a catalog override → Attention → Review → Apply → Models screen | item appears, diff modal shows 3 targets and the engine's reasons, apply writes the file, item resolves, badge and references count update over WS |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M6-06-01 | Deprecation flags the right policies | 1. Add `deprecated: true, renamedTo: fake-pro-2` to `~/.orchestra/catalog-overrides/models/fake/fake-pro.yaml`. 2. `orch catalog reload`. 3. Open Attention; `orch models references fake/fake-pro`. | One item naming 3 policy entries with human labels ("architect · primary", …); Models screen shows the deprecation badge with reason and `renamedTo`; the unmanaged skill reference is listed separately as "fix manually" | ⬜ |
| TC-M6-06-02 | One-click migration with preview | 1. Click **Review migration**. 2. Inspect the diff modal. 3. Apply. 4. `git diff` / `diff` the policy file against its `.bak`. | Modal shows old → new per target with the engine's reasons; the unified diff matches exactly what is written; after apply the file changed only at those pointers; comments intact; `policy.migrated` event + audit row | ⬜ |
| TC-M6-06-03 | Re-scoring takes effect for new work only | 1. Start a task on `fake-pro` and leave it running. 2. Create a new task of the same type. 3. Check `routing_decisions`. | The running task keeps its model; the new decision picks `fake-pro-2` with `reasons` containing `model_deprecated`; queued tasks re-assigned; no session restarted | ⬜ |
| TC-M6-06-04 | **Negative: nothing is written without approval** | 1. Trigger TC-01 again on a second model. 2. Do **not** open the item; wait 10 min. 3. `ls -l --time-style=full-iso` the policy files. | Policy files untouched (mtime unchanged); no `policy.migrated` event; suggestion persisted and waiting; `orch models migrate <id> --dry-run` prints the diff and still writes nothing | ⬜ |
| TC-M6-06-05 | **Negative: blocked migration is surfaced, not hidden** | 1. Deprecate the only model of a provider that satisfies a `requiredCapabilities` entry. 2. Open the item. | Target shown as **blocked** with a plain-language reason; Apply is disabled for it; the item stays open; no partial write; nothing silently falls back to a non-compliant model | ⬜ |
| TC-M6-06-06 | **Negative: guard blocks an out-of-scope write** | 1. Symlink `~/.orchestra/policies/routing.yaml` to `~/.orchestra/token`. 2. Attempt an apply. | `GuardViolation` before any write; token untouched; audit row; API error is typed and the modal shows it | ⬜ |
| TC-M6-06-07 | Rename via manifest alias | 1. Publish a `fake` manifest where `fake-pro-2` lists `aliases: [fake-pro]` and `fake-pro` is gone. 2. `orch registry refresh --provider fake`. | Change `renamed` with `confidence: vendor-alias`; suggestion proposes the alias target directly without an engine re-score; `orch models lifecycle --json` shows both source `manifest` and the version | ⬜ |
| TC-M6-06-08 | Resilience: reload storm & idempotency | 1. `orch catalog reload` 10 times in 10 s with no content change. 2. `select count(*) from model_lifecycle_changes`. | Count unchanged after the first detection (snapshot hash short-circuit); exactly one Attention item; no duplicate suggestions | ⬜ |
| TC-M6-06-09 | Resilience: crash mid-apply | 1. Start an apply against 3 files; `kill -9` the daemon between file 2 and 3 (dev hook). 2. Restart; inspect files and `.bak`s. | Each file is either fully patched or untouched (atomic per file); the suggestion is still open with the remaining targets; re-applying completes it without double-patching | ⬜ |
| TC-M6-06-10 | **Timing** | 1. Time from `orch catalog reload` (deprecation present) to the Attention item appearing over WS. 2. Time an apply of 3 targets. | Flagging < 5 s (well inside the 60 s detection SLO); apply < 2 s; both recorded in the log | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All TC-M6-06-01 … 10 pass and are recorded with build hash and date.
- [ ] `diffLifecycle`, `buildMigrationSuggestion` and the `notDeprecated` constraint gate have 100 % branch coverage.
- [ ] A deprecated/renamed/removed model produces exactly one lifecycle change, one suggestion and one Attention item naming every managed policy reference with a human label (TC-01).
- [ ] The assignment engine stops choosing the model for **new** decisions and re-assigns queued-but-unstarted tasks, while running sessions and started tasks are untouched (TC-03).
- [ ] Migration is preview-first: the applied bytes equal the previewed diff, comments/order survive, a `.bak` exists, and `policy.migrated` + an audit row are written (TC-02).
- [ ] No policy file is ever written without an explicit user action, and blocked targets are shown rather than silently skipped (TC-04, TC-05).
- [ ] `ForbiddenPathGuard` blocks any write outside the policy allow list (TC-06, C12).
- [ ] Detection is idempotent under repeated reloads and crash-safe mid-apply (TC-08, TC-09).
- [ ] No new lint/dependency-cruiser violations; the scanner/builder are pure and live in `packages/core`, YAML I/O only in `infrastructure/**`.
- [ ] `PROGRESS.md` updated; `packages/catalog/README.md` documents `renamedTo`, `validTo` and how a deprecation propagates.

## 8. Risks / open questions
- **Vendors rarely announce model deprecation in a machine-readable way.** In practice the first signal is often a `model-not-found` exit (M6-02 `model-missing`) or a model missing from a refreshed manifest. That is why R-M4 exists and why M6-04's `RerouteTask` is the immediate fix while this step fixes the configuration. Whether Claude Code / Codex / Antigravity expose a deprecation flag or alias list at all is **(verify against each provider's docs at step start)**; until then `renamedTo` is a catalog-override field maintained by us.
- Comment-preserving YAML patching is fiddly: anchors, merge keys and multi-document files can defeat a naive round-trip. The store refuses to patch a file containing merge keys or multiple documents and reports it as an unmanaged reference instead of risking a mangled config.
- A rename proposed by an alias is trustworthy; a replacement proposed by the engine is a *suggestion* and may be wrong for the user's taste — hence per-target opt-out and reasons shown inline. Never auto-apply, not even behind a config flag, in M6.
- Re-scoring changes routing behaviour the moment a catalog reload lands; a user mid-mission could see different assignments than the plan preview showed. M3-08's mission view reads `routing_decisions`, so the change is visible, but a "pin models for the duration of a mission" option may be needed — logged for M8-01.
- Layer precedence for references depends on M8-01's full settings engine, which does not exist yet; this step scans the layers M2-09 already loads and marks anything else `unmanaged`. Re-check the scanner when M8-01 lands.
- `model_profiles` rows are never deleted (R-M8), so the Models screen must filter by validity or it will slowly fill with tombstones — the filter defaults to "current" with an "include retired" toggle.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
