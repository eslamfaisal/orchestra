# Step M2-02 — Model catalog & profiles v1

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-01 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/catalog`, `packages/core`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step every model the three adapters expose has a capability profile (`06-intelligence-layer.md §2`) shipped as YAML in `packages/catalog/models/<provider>/<model>.yaml`, overridable per machine in `~/.orchestra/catalog-overrides/models/`, loaded with the same hot-reload machinery as the taxonomy, synced into the `model_profiles` table, and browsable in a new **Models** screen (catalog table, dimension radar, evidence, deprecated badge). The Assignment Engine (M2-04) reads profiles only through `ModelCatalogPort`.

## 2. Why
- D7: "which model for which job" changes monthly; profiles are data, updatable without a release and overridable locally.
- G2: capability fit needs numeric dimensions per model; G7: profiles are versioned artifacts a community package can maintain.
- M6-06 (model lifecycle) and M8-06 (scorecards) extend this catalog; both need `validFrom/validTo`, `evidence[]` and the `source` column now.
- UX principle "truth labelling": every profile shows where its numbers come from (benchmark, community, local outcomes).

## 3. Scope
### In scope
- `ModelProfile` VO + `ModelCatalogPort` in `packages/core`; Zod schema `packages/catalog/schemas/model-profile.schema.ts`.
- Shipped profiles for every model in the claude / codex / agy manifests (≥ 8), tuned so M2-04's golden tests hold.
- Override loader: `~/.orchestra/catalog-overrides/models/<provider>/<model>.yaml` deep-merged over shipped profile (`source: local`).
- Daemon `ModelCatalogWatcher` (chokidar on both dirs), sync into `model_profiles`, cross-check against manifest `models[]`.
- `orch catalog validate` extended with model checks; `GET /api/catalog/models[...]`; WS topic `catalog`.
- Models screen: catalog table, profile drawer with radar (6 dimensions) + code-quality table, evidence list, deprecated badge, source badge.
### Out of scope (deferred to …)
- Editing overrides from the UI → M8-02 (model profile override editor).
- Scorecards / learning-loop adjustments of dimensions → M8-06.
- Deprecation → re-score → migration suggestion pipeline → M6-06 (this step only renders the badge and lets the engine exclude).
- Registry download of community profiles → M6-03.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`ModelProfile` (core, `packages/core/src/intelligence/model-profile.ts`). Rules in `ModelProfile.create()`:
- `dimensions` scalar keys `reasoning longContext speed instructionFollowing toolUse multimodal` each 0…1; `codeQuality` map language → 0…1 (unknown language ⇒ engine falls back to `instructionFollowing`).
- `costTier ∈ 1..5`; `contextWindow > 0`; `validFrom ≤ validTo` when both set.
- `bestFor[] / avoidFor[]` ⊆ taxonomy ids (validated against `TaxonomyPort` at load — warning, not error, so a profile can precede a task type).
- `isDeprecated(now)` = `validTo != null && validTo < now`, OR manifest `models[].deprecated = true` (manifest wins).
- Override merge: scalar fields replaced, `dimensions` deep-merged, `evidence` appended with `origin: local`, `bestFor/avoidFor` replaced when present. Result `source: 'local'` and `basedOn: shippedVersionHash`.
- `ModelRef` VO: `"<provider>/<modelId>"` string form with `parse()` and `equals()`; used by matrix, policy file and decisions.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/intelligence/model-profile.ts
export interface ModelDimensions {
  reasoning: number; longContext: number; speed: number; instructionFollowing: number; toolUse: number; multimodal: number;
  codeQuality: Readonly<Record<string, number>>;          // 'typescript' | 'dart' | 'kotlin' | 'swift' | 'python' | …
}
export type Evidence =
  | { kind: 'benchmark'; name: string; value: number; date: string; url?: string }
  | { kind: 'community'; note: string; date: string }
  | { kind: 'local-outcomes'; sampleSize: number; reviewFindingsPer100Loc: number; testPassRate: number; updated: string };
export interface ModelProfile {
  ref: ModelRef; label: string;
  dimensions: ModelDimensions; contextWindow: number; costTier: 1|2|3|4|5;
  bestFor: readonly TaskTypeId[]; avoidFor: readonly TaskTypeId[];
  evidence: readonly Evidence[];
  validFrom: string; validTo: string | null;
  source: 'community' | 'local' | 'synthesized'; basedOn?: string; profileVersion: string;
}
export interface ModelCatalogPort {
  get(ref: ModelRef): Result<ModelProfile, ModelProfileNotFound>;
  listByProvider(provider: ProviderId): readonly ModelProfile[];
  list(): readonly ModelProfile[];
  version(): CatalogVersion;
}
// packages/catalog/src/loaders/model-catalog-loader.ts
export function loadModelCatalog(fs: FileSource, shippedDir: string, overridesDir: string | null,
  manifestModels: ReadonlyMap<ProviderId, readonly ModelRefLike[]>): Promise<Result<ModelCatalog, ModelLoadError[]>>;
// ModelLoadError: YAML_PARSE | SCHEMA | UNKNOWN_PROVIDER | PROFILE_WITHOUT_MANIFEST_MODEL (warning) | OVERRIDE_FOR_MISSING_PROFILE
```
```yaml
# packages/catalog/models/codex/gpt-5-codex.yaml   (model id: verify against codex docs / manifest at step start)
profileVersion: 2026.09.1
modelId: gpt-5-codex
provider: codex
label: GPT-5 Codex
dimensions: { reasoning: 0.85, longContext: 0.7, speed: 0.7, instructionFollowing: 0.9, toolUse: 0.9, multimodal: 0.5,
              codeQuality: { typescript: 0.9, python: 0.9, dart: 0.7, kotlin: 0.8, swift: 0.75 } }
contextWindow: 400000        # verify
costTier: 3
bestFor: [feature-impl, bugfix, test-gen]
avoidFor: [research]
evidence:
  - { kind: community, note: "default matrix 06 §4 — primary for feature-impl/bugfix/test-gen", date: 2026-09-14 }
validFrom: 2026-06-01
validTo: null
```
Shipped set (ids *verify against each provider's docs / `manifest.models` at step start*): `claude/fable`, `claude/opus`, `claude/sonnet`, `codex/gpt-5-codex`, `codex/gpt-5`, `agy/gemini-pro`, `agy/gemini-flash`, `agy/claude-opus`. Manifest models without a profile get a `synthesized` profile (all dimensions 0.5, costTier 3, evidence empty) so the engine can still consider them, with a validation warning.

### 4.3 Data / schema changes
Migration `m2_02_model_profiles_sync`: `model_profiles` table exactly as `04-domain-model.md §4` (`id, model_id, provider_id, dimensions_json, context_window, cost_tier, best_for_json, avoid_for_json, evidence_json, valid_from, valid_to, source`) plus `profile_version TEXT`, `based_on TEXT NULL`, `synced_at TEXT`, unique `(provider_id, model_id, source)`. Sync = upsert on every successful load; rows for removed profiles get `valid_to = now` (never deleted; M8-06 outcomes reference them). Events: `catalog.reloaded {kind:'models'}`, `catalog.invalid {kind:'models'}`, `provider.model_deprecated {ref, reason}` (new; consumed by M6-06).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `ModelCatalogWatcher` in `apps/daemon/src/infrastructure/catalog/` watches the shipped dir and `~/.orchestra/catalog-overrides/models/` (created 0700 on first boot if missing); debounce 250 ms.
- Manifest models are read from `ManifestPort` (M1-05..07 manifests; M2-03 completes them). The loader receives a plain map so `packages/catalog` never imports provider packages.
- `ModelProfileRepository` (Kysely) implements the sync; `InMemoryModelCatalog` implements `ModelCatalogPort` for the engine and tests.
- No network: profiles ship in the repo; registry fetch is M6-03.

### 4.5 API / UI surface
- `GET /api/catalog/models?provider=&includeDeprecated=` → `{ version, profiles: ModelProfileDto[] }` (`deprecated: boolean` computed with the daemon `Clock`).
- `GET /api/catalog/models/:provider/:model` → profile + `manifestModel` (label, tier, aliases) + `overrideActive: boolean`.
- `GET /api/catalog/models/:provider/:model/override` → the raw local override YAML if present (read-only in M2).
- CLI: `orch catalog validate` adds `models: N profiles OK (W warnings)`; warnings printed but exit 0; `--strict` makes warnings exit 4.
- Models screen (`apps/web/src/features/models/`): `ModelsScreen` (nav entry "Models", `⌘K` "Open Models"), `ModelCatalogTable` (columns: provider, model, label, cost tier, context window, best for chips, source badge, deprecated badge; sortable; provider filter; keyboard navigable), `ModelProfileDrawer` (radar of 6 scalar dimensions via `packages/ui` `RadarChart` (SVG, no new dependency), `codeQuality` table, bestFor/avoidFor chips linking to taxonomy labels, evidence list with dates and links, validity window, "override active" notice with file path). States: loading, empty (no providers detected), error (catalog invalid → banner with error count and last-known-good hash), populated. RTL-safe (logical properties), status never colour-only.

### 4.6 Flow / sequence
```
boot / file change ─▶ ModelCatalogWatcher ─▶ loadModelCatalog(fs, shipped, overrides, manifestModels)
   ├─ ok ─▶ InMemoryModelCatalog.swap() ─▶ ModelProfileRepository.sync() ─▶ emit catalog.reloaded(models)
   │        └─ for each profile with isDeprecated(now) newly true ─▶ emit provider.model_deprecated
   └─ err ─▶ keep last-known-good ─▶ emit catalog.invalid(models) ─▶ Fleet health + Models banner
Models screen ─▶ GET /api/catalog/models ─▶ table; subscribe WS `catalog` ─▶ refetch on reloaded
```

## 5. Tasks
- [ ] Add `ModelRef`, `ModelDimensions`, `Evidence`, `ModelProfile` VOs + `ModelProfile.create()` + `isDeprecated()` + `mergeOverride()` to `packages/core` with 100 % branch tests.
- [ ] Write `schemas/model-profile.schema.ts` (Zod) + JSON Schema export; `evidence` discriminated union.
- [ ] Author the 8 shipped profile YAMLs; include a `RATIONALE.md` table in `packages/catalog/models/` mapping each profile to matrix rows it must satisfy.
- [ ] Implement `loadModelCatalog()` with override merge, synthesized profiles and cross-check warnings; unit tests with in-memory `FileSource`.
- [ ] Kysely migration for `model_profiles` (+ extra columns) and `ModelProfileRepository.sync()` with upsert + soft-retire.
- [ ] `ModelCatalogWatcher` + `InMemoryModelCatalog` in `CatalogModule`; create overrides dir with 0700 on boot.
- [ ] Emit `provider.model_deprecated` on transition; Zod event schemas registered.
- [ ] Extend `orch catalog validate` with model checks and `--strict`.
- [ ] `GET /api/catalog/models…` controllers + OpenAPI; WS `catalog` reuse.
- [ ] `packages/ui`: `RadarChart` (SVG, 3–8 axes, accessible table fallback) + stories.
- [ ] `apps/web`: `ModelsScreen`, `ModelCatalogTable`, `ModelProfileDrawer`, nav entry, `⌘K` action, TanStack Query hooks, WS refetch.
- [ ] Playwright E2E with FakeProvider manifest models: table renders, drawer opens, override badge appears after simulated reload event.
- [ ] Docs: `packages/catalog/README.md` "Model profiles & local overrides".

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-02-01 | unit | `ModelProfile.create()` with `costTier: 6` / dimension 1.2 | `Err(InvalidProfile)` with field path |
| UT-M2-02-02 | unit | `mergeOverride()` deep-merges `dimensions`, appends evidence, sets `source: local` and `basedOn` | merged profile equals expected fixture |
| UT-M2-02-03 | unit | `isDeprecated()` with `validTo` past / manifest `deprecated: true` / neither | true / true / false |
| UT-M2-02-04 | unit | loader with a manifest model lacking a profile | `Ok` with a `synthesized` profile and one `PROFILE_WITHOUT_MANIFEST_MODEL`-class warning for the inverse case |
| UT-M2-02-05 | unit | override file for a non-existent shipped profile | `Err([OVERRIDE_FOR_MISSING_PROFILE])` |
| AT-M2-02-01 | application | `SyncModelProfiles` use case with in-memory repo: load, remove one profile, reload | removed row gets `valid_to = now`, others upserted, no deletes |
| IT-M2-02-01 | integration | daemon with temp overrides dir; write override with `validTo` in the past | `catalog.reloaded` + `provider.model_deprecated` within 2 s; `GET` shows `deprecated: true`, `source: local` |
| IT-M2-02-02 | integration | `model_profiles` sync after reload | unique `(provider_id, model_id, source)` holds; `synced_at` updated |
| E2E-M2-02-01 | e2e | Models screen with FakeProvider | table lists fake models; drawer radar has 6 axes; deprecated badge toggles on WS event |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-02-01 | Catalog renders for real providers | 1. Daemon with claude + codex (+ agy) detected 2. Open Models | Every model from each manifest appears; shipped ones show *community*, others *synthesized*; `orch catalog validate` prints profile count and warnings | ⬜ |
| TC-M2-02-02 | Profile drawer | 1. Click `claude/opus` | Radar with 6 axes, code-quality table, bestFor chips resolve to taxonomy labels, evidence rows with dates, validity window | ⬜ |
| TC-M2-02-03 | Local override hot reload | 1. Copy `agy/gemini-flash.yaml` to `~/.orchestra/catalog-overrides/models/agy/` 2. Set `costTier: 1`, `validTo: 2026-01-01` 3. Save | Within 2 s the row shows *local* + *deprecated* badges; drawer shows override path; `model_profiles` has a `source = local` row | ⬜ |
| TC-M2-02-04 | Negative: invalid override | 1. Set `reasoning: 1.7` in the override 2. Save | Banner "catalog invalid (1 error)" naming the file and field; previous values still shown; daemon alive | ⬜ |
| TC-M2-02-05 | Restart / resilience | 1. With the valid override in place, `kill -9` daemon 2. Restart | Override still applied; deprecated badge present; no duplicate `model_profiles` rows | ⬜ |
| TC-M2-02-06 | Remove override | 1. Delete the override file | Badges disappear within 2 s; `source` back to *community*; `valid_to` set on the `local` row | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] ≥ 8 shipped profiles load; every model in every detected manifest has a profile (shipped or synthesized).
- [ ] Local override applied within 2 s of file change; invalid override never replaces last-known-good.
- [ ] `model_profiles` rows match the in-memory catalog after every reload (IT-M2-02-02); no hard deletes.
- [ ] Models screen passes axe (WCAG 2.1 AA) and renders correctly in RTL; deprecated/source badges have text labels.
- [ ] `packages/core` model-profile module at 100 % branch coverage; `packages/catalog` ≥ 80 %.
- [ ] `orch catalog validate` reports profile warnings and `--strict` fails on them.
- [ ] All TC-M2-02-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Exact model ids and context windows per provider are vendor facts not covered by `05-provider-contract.md §3` — *(verify against claude / codex / agy docs and the manifests recorded in M1-05..07 at step start)*. Profiles must use the ids the manifests report, otherwise the engine only sees synthesized profiles.
- Dimension numbers are tuned so the M2-04 golden matrix holds; that makes them opinion until M8-06 supplies local outcomes. `RATIONALE.md` keeps this explicit.
- Radar charts can mislead for near-equal models; the drawer always shows the numeric table beside the chart.
- Whether `synthesized` profiles should be eligible for automatic assignment (default here: yes, with reason `profile-synthesized` and a −0.1 fit penalty) — revisit after first real routing runs in M2-06.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
