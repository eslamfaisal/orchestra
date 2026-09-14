# Step M8-01 — Layered settings engine

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M2-09 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core`, `packages/catalog`, `packages/sdk`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step every configurable knob in Orchestra resolves through one pure `SettingsResolver` over five ordered layers — **task > user > workspace > org > defaults** — each a YAML file with a published Zod schema. A user can put `routing:` in `~/.orchestra/user.yaml` and see it beat the `routing:` block M2-09 shipped in `<repo>/.orchestra/workspace.yaml`; a second `ORCHESTRA_HOME` gives a teammate their own defaults without touching anyone else's file. Every effective key carries provenance (`workspace.yaml:12`), visible in the new **Settings** screen, in a side-by-side layer diff, and from `orch settings explain <key>`. Files hot-reload in under 1 s; an invalid file never replaces the last-known-good tree and surfaces as a banner with file + line while running sessions continue untouched.

## 2. Why
- **D7** — the intelligence layer is data, not code. M2-09 proved the idea with one block in one file; this step generalises it to the whole settings tree so routing, roles, skills, playbooks, instructions, auto-answer and notifications (M8-02…M8-08) are all edited, not coded.
- **G7** (extensible and open) — policies and profiles become versioned artifacts that a user or an org ships independently of a release.
- **G2** — a per-user layer is how "right model, every time" becomes *right for this person on this repo*; the provenance chip is what makes a surprising route explainable rather than magic.
- **C10** — settings are spend-shaping. Every layer write goes through the audit interceptor with before/after, so "who made Opus the default for boilerplate" is answerable.
- **C13 / engineering standards** — secrets never live in config files; the schema rejects secret-shaped keys at load time rather than hoping nobody pastes a token.
- M9-01 (RBAC) and M9-03 (audit) need a layer identity (`settings_layers`) to attach permissions and history to; defining it here avoids a migration in enterprise.

## 3. Scope
### In scope
- Pure `SettingsResolver` + merge algebra + provenance in `packages/core/src/settings/`.
- Section registry: each feature package registers a `SettingsSection` (id, Zod schema, list semantics, redaction rules); the root schema is composed from the registry, not hand-written.
- Five layer sources: shipped defaults (`packages/catalog/settings/defaults.yaml`), org (`~/.orchestra/org.yaml`, or a fetched signed URL in team mode), workspace (`<repo>/.orchestra/workspace.yaml`), user (`~/.orchestra/user.yaml`), task (inline `settingsOverrides` on a `TaskSpec`).
- Explicit merge directives `!append`, `!prepend`, `!override`, `!clear` on list and map keys.
- Hot reload with last-known-good semantics; `settings.reloaded` / `settings.invalid` events; Fleet + Settings banners.
- `settings_layers` table (writes land in M8-02; this step creates it and mirrors file layers into it so team mode is a driver swap).
- Read API + WS topic, Settings screen shell (nav, section list, read-only YAML view, provenance inspector, layer diff view).
- `orch settings explain|get|list|validate|diff`.
- Migration of the M2-09 `routing:` block onto the new engine with zero behaviour change (`LayeredPolicyResolver` becomes a consumer of `SettingsResolver`).
### Out of scope (deferred to …)
- Writing layers from the UI (form + YAML editors, optimistic concurrency) → deferred to M8-02.
- Prompt templates as a settings section → deferred to M8-03; skills → M8-04; playbooks → M8-07; instruction fragments, auto-answer rules and notification/update channels → M8-08.
- Learning-loop settings (`learning.*`) → registered by M8-06 against this registry.
- Per-user permissions on which layer a user may edit → deferred to M9-01; until then any local user may edit any local file.
- Fetching the org layer from a remote URL with signature verification → schema and loader interface exist here, the signed fetch is deferred to M9-02 (team mode auth); v0 supports a `file://` or local path org layer only.
- Encrypting settings at rest → deferred to M9-09.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`SettingsResolver` is a pure domain service (`packages/core/src/settings/settings-resolver.ts`): no I/O, no clock, no filesystem. It takes ordered layers and returns an immutable effective tree plus a provenance map.

Merge algebra (fixed, printable, tested to 100 % branches):
- **Maps** merge key-wise, deeply. A key present in a higher layer wins for that key only; sibling keys from lower layers survive.
- **Scalars** take the nearest defining layer.
- **Lists replace by default.** This matches M2-09's replace-not-merge rule for `primary`/`fallback`/`reviewer` and keeps "which rule won" answerable without reading every layer.
- **Directives** are suffixes on the key, resolved before merging: `key!append: [...]` (concatenate after the lower layer's list), `key!prepend: [...]`, `key!override: <value>` (replace and *seal* — a higher layer's `!append` on a sealed key is rejected at validation time with `E_SEALED_KEY`), `key!clear: true` (reset to the schema default). At most one directive per key per layer; two directives on the same key in one layer ⇒ `E_DIRECTIVE_CONFLICT`.
- **Deny beats allow at every layer** for any key pair named `allow`/`deny` in a section's `listSemantics` (carried over verbatim from M2-09 §4.1 so an org deny cannot be re-allowed downstream). The escalation path is explicit: only an edit to the org layer lifts an org deny — the Settings screen says so on the affected key instead of silently dropping the user's value.
- **Provenance** is produced for every *leaf* path: `{ layer, file, line, col, directive? }`. A leaf whose value came from a `!append` records every contributing layer in `contributors[]`.
- **No throw**: every failure is a `Result` with a typed error carrying `file` and `line`.

Rules that are not negotiable:
- Unknown keys are an **error**, not a warning (a typo in `routnig:` must not silently do nothing). Unknown keys inside a section explicitly marked `additive: true` (e.g. `skills.packs`) are allowed.
- Any key whose name matches `/token|secret|apiKey|password|cookie|authorization/i` ⇒ `E_SECRET_IN_SETTINGS` (C13, engineering standards "secrets only via env/keychain").
- A task layer may only set keys whose section declares `taskOverridable: true` (routing, skills, instructions, autoAnswer). Attempting anything else ⇒ `E_NOT_TASK_OVERRIDABLE`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/settings/types.ts
export type SettingsLayerId = 'defaults' | 'org' | 'workspace' | 'user' | 'task';
export const LAYER_ORDER: readonly SettingsLayerId[] =
  ['defaults', 'org', 'workspace', 'user', 'task'];              // lowest → highest precedence

export interface SettingsLayer {
  id: SettingsLayerId;
  origin: { kind: 'shipped' | 'file' | 'url' | 'inline'; ref: string };  // ref = absolute path / url / taskId
  version: string;                                               // content hash
  raw: unknown;                                                  // parsed YAML, directives unresolved
  positions: ReadonlyMap<string, { line: number; col: number }>; // dotted path → YAML source position
}

export interface Provenance {
  layer: SettingsLayerId; file: string; line: number; col: number;
  directive?: '!append' | '!prepend' | '!override' | '!clear';
  contributors?: readonly { layer: SettingsLayerId; file: string; line: number }[];
  sealedBy?: SettingsLayerId;
}

export interface EffectiveSettings<T = SettingsTree> {
  value: T;
  provenance: ReadonlyMap<string, Provenance>;                   // dotted leaf path → provenance
  version: string;                                               // hash over all layer versions
  layers: readonly { id: SettingsLayerId; origin: SettingsLayer['origin']; version: string }[];
}

export type SettingsError =
  | { code: 'YAML_PARSE'; file: string; line: number; message: string }
  | { code: 'SCHEMA'; file: string; path: string; line: number; message: string }
  | { code: 'E_UNKNOWN_KEY'; file: string; path: string; line: number; suggestion?: string }
  | { code: 'E_SECRET_IN_SETTINGS'; file: string; path: string; line: number }
  | { code: 'E_SEALED_KEY'; path: string; sealedBy: SettingsLayerId; attemptedBy: SettingsLayerId }
  | { code: 'E_DIRECTIVE_CONFLICT'; file: string; path: string; line: number }
  | { code: 'E_NOT_TASK_OVERRIDABLE'; path: string };

export class SettingsResolver {
  constructor(private readonly registry: SettingsSectionRegistry) {}
  resolve(layers: readonly SettingsLayer[]): Result<EffectiveSettings, SettingsError[]>;
  explain(eff: EffectiveSettings, dottedKey: string):
    Result<{ value: unknown; provenance: Provenance; shadowed: readonly { layer: SettingsLayerId; file: string; line: number; value: unknown }[] }, { code: 'E_NO_SUCH_KEY'; key: string }>;
  diff(a: EffectiveSettings, b: EffectiveSettings): readonly SettingsDiffEntry[];
}

// packages/sdk/src/settings-section.ts — how every later step plugs in
export interface SettingsSection<T = unknown> {
  readonly id: string;                                           // 'routing' | 'roles' | 'skills' | 'instructions' | …
  readonly schema: ZodType<T>;
  readonly taskOverridable: boolean;
  readonly additive?: boolean;                                   // free-form keys permitted
  readonly listSemantics?: Readonly<Record<string, 'replace' | 'append' | 'deny-wins'>>;
  readonly since: string;                                        // step id that introduced it, for the UI
}
export interface SettingsSectionRegistry {
  register(section: SettingsSection): void;
  rootSchema(): ZodType<SettingsTree>;                           // composed, strict
  jsonSchema(): unknown;                                         // for CodeMirror completion (M8-02)
}
```

```yaml
# ~/.orchestra/user.yaml — the whole tree is optional; sections are registered by later steps
version: 1
routing:                       # section registered by M2-09, re-hosted here unchanged
  taskTypes:
    boilerplate:
      primary: ["agy/gemini-flash"]
  deny!append: ["kimi/*"]      # adds to whatever org/workspace denied
ui:
  theme: dark
  locale: en
telemetry:
  anonymisedExport: false      # opt-in only (C-data handling); M8-06 reads this
```

### 4.3 Data / schema changes
- Migration `m8_01_settings_layers` creates `settings_layers` (already named in `04-domain-model.md §4`): `id TEXT PK, scope TEXT NOT NULL ('org'|'workspace'|'user'), scope_ref TEXT NULL (repo path or user id), user_id TEXT NULL, version TEXT NOT NULL, yaml TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NULL`, unique `(scope, scope_ref, user_id)`. In local mode the loader **mirrors** file content into this table on every successful load; in team mode (M9-05) the table becomes the source and the files become an export. No behaviour depends on the mirror in M8.
- New event types under a `settings.*` namespace registered in the event catalog (`04 §3` extension): `settings.reloaded {layer, file, version, sections[]}`, `settings.invalid {layer, file, errors[], keptVersion}`, `settings.layer_written {layer, file, version, actor}` (emitted from M8-02 onward).
- `routing_decisions.policy_version` now holds the `EffectiveSettings.version` hash; existing rows keep their old hashes (the "policy changed since this decision" note from M2-09 already covers the discontinuity).
- No change to `tasks`; the task layer travels in `tasks.context_json.settingsOverrides` and is validated by the same schema.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `apps/daemon/src/infrastructure/settings/`: `YamlLayerSource` (parses with `yaml`'s document API to keep line/col for every node — this is the only way provenance can point at `workspace.yaml:12`), `SettingsFileWatcher` (chokidar, `awaitWriteFinish`, 250 ms debounce, one watcher per file, per-repo watchers registered/disposed with the M1-03 repo registry), `SettingsStore` (holds current `EffectiveSettings` per repo, swaps atomically, keeps last-known-good).
- Missing files are the normal case: a host with no `org.yaml` and no `user.yaml` resolves `defaults + workspace` only.
- Invalid file ⇒ keep the previous tree for that layer, emit `settings.invalid`, never crash, never fail a route or a running session.
- File permissions asserted on load: `~/.orchestra` must be 0700; a world-readable `user.yaml` produces a warning row in Health (not an error).
- Org layer over a URL is loaded through the **allowlisted egress module only** (C2) and cached under `~/.orchestra/manifests-cache/org/`; the fetch is behind `features.teamMode` and off by default in M8.
- No tmux, no git, no child processes.

### 4.5 API / UI surface
- `GET /api/settings/effective?repo=<path>&section=<id>` → `{ value, version, layers[] }`.
- `GET /api/settings/provenance?repo=&key=routing.taskTypes.boilerplate.primary` → `{ value, provenance, shadowed[] }`.
- `GET /api/settings/layers?repo=` → per-layer `{ id, origin, version, exists, valid, errors[] }`.
- `GET /api/settings/diff?repo=&from=user&to=effective` → structured diff entries.
- `GET /api/settings/schema` → composed JSON Schema (consumed by M8-02's editor and by `orch settings validate`).
- WS topic `settings`: snapshot on subscribe, delta on `settings.reloaded` / `settings.invalid`.
- CLI (`apps/cli`): `orch settings explain <key> [--repo] [--json]` (value + winning layer + file:line + shadowed values, in that order), `orch settings get <key>`, `orch settings list [--section]`, `orch settings validate [--layer]` (exit 0 ok / 2 schema errors / 3 unreadable), `orch settings diff <layerA> <layerB>`.
- UI `apps/web/src/features/settings/`: `SettingsScreen` (left: section list grouped by "Routing · Roles · Skills · Playbooks · Instructions · Notifications · Advanced", with a *not yet configurable* marker for sections whose editor lands in a later step), `LayerBar` (five chips: defaults/org/workspace/user/task — each shows exists/valid/version and is clickable to view that layer's raw YAML read-only), `ProvenanceInspector` (click any key → value, winning layer chip, `file:line` link, shadowed values list, "sealed by org" note where applicable), `LayerDiffView` (two-pane, added/changed/removed/shadowed), `SettingsErrorBanner` (file, line, message, "open file" affordance).
- States: `loading`, `ok`, `partially-invalid` (one layer broken, tree still served — banner + which layer), `all-invalid` (defaults only), `empty-layer`.
- Accessibility: layer status uses icon + text, never colour alone (UX principle 2); the inspector is keyboard reachable; RTL verified.

### 4.6 Flow / sequence
```
boot / file change ─▶ SettingsFileWatcher ─▶ YamlLayerSource.load(file) ─▶ SettingsLayer{raw, positions}
      ├─ parse err ─▶ keep last-known-good layer ─▶ settings.invalid ─▶ WS + Health + Settings banner
      └─ ok ─▶ SettingsResolver.resolve([defaults, org, workspace, user])
                 ├─ directives resolved per layer ─▶ deep merge ─▶ strict schema (registry.rootSchema())
                 ├─ err  ─▶ keep last-known-good tree ─▶ settings.invalid
                 └─ ok   ─▶ SettingsStore.swap(effective) ─▶ settings.reloaded ─▶ WS 'settings'
                              └─▶ LayeredPolicyResolver re-reads section 'routing' (M2-09 unchanged API)

task execution ─▶ TaskSpec.settingsOverrides ─▶ resolve([...persisted layers, task]) ─▶ per-task EffectiveSettings
                    (never written to disk; version hash recorded on the routing decision)

orch settings explain routing.taskTypes.boilerplate.primary
  ─▶ GET /api/settings/provenance ─▶ value · layer user · ~/.orchestra/user.yaml:7 · shadowed: workspace.yaml:12, defaults
```

## 5. Tasks
- [ ] `SettingsSection` / `SettingsSectionRegistry` types in `packages/sdk`; registry implementation with composed strict root schema + JSON Schema export.
- [ ] `SettingsResolver.resolve()` — directive resolution, deep merge, list semantics, deny-wins, sealing; pure, no I/O.
- [ ] Provenance map construction (leaf paths, contributors for `!append`, `sealedBy`), and `explain()` returning shadowed values in layer order.
- [ ] `diff()` producing `added | changed | removed | shadowed` entries with both provenances.
- [ ] Typed `SettingsError` union + human formatter shared by CLI and UI (one message string per code, `file:line` prefix).
- [ ] `packages/catalog/settings/defaults.yaml` + the `core` section schema (`ui`, `telemetry`, `paths`, `features`) as the first registered section; re-register M2-09's `routing` section against the registry.
- [ ] `YamlLayerSource` with position capture; unit tests asserting line/col for nested keys and for list items.
- [ ] `SettingsFileWatcher` + `SettingsStore` with last-known-good swap; per-repo watcher lifecycle tied to the M1-03 repo registry.
- [ ] Event schemas `settings.reloaded` / `settings.invalid`; Health row; WS `settings` topic with snapshot + delta.
- [ ] Migration `m8_01_settings_layers` + `SettingsLayerRepository` + mirror-on-load.
- [ ] Task layer plumbing: `TaskSpec.settingsOverrides`, `taskOverridable` enforcement, per-task resolve used by `PreviewAssignment`.
- [ ] `settings.controller.ts` (effective, provenance, layers, diff, schema) + OpenAPI.
- [ ] `apps/web`: `SettingsScreen`, `LayerBar`, `ProvenanceInspector`, `LayerDiffView`, `SettingsErrorBanner`; nav entry; EN/AR strings.
- [ ] `orch settings explain|get|list|validate|diff` with table and `--json` output.
- [ ] Coverage gate: add `packages/core/src/settings/**` to the 100 %-branch list; docs section "Layered settings: precedence, directives, provenance" in `packages/core/README.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-01-01 | unit | four layers each setting a different key under `routing.taskTypes` | all four survive; each leaf's provenance names its own layer and line |
| UT-M8-01-02 | unit | same key in workspace and user | user wins; `explain()` lists the workspace value as shadowed with its file:line |
| UT-M8-01-03 | unit | list `replace` default vs `!append` vs `!prepend` vs `!clear` | replace drops the lower list; append/prepend preserve order and record contributors; clear returns the schema default |
| UT-M8-01-04 | unit | org sets `deny: ["agy/*"]`, user sets `allow: ["agy/*"]` | deny wins (`deny-wins` semantics); the key's provenance records `sealedBy: 'org'` |
| UT-M8-01-05 | unit | `!override` in workspace then `!append` in user on the same key | `Err(E_SEALED_KEY)` naming both layers; tree unchanged |
| UT-M8-01-06 | unit | unknown key `routnig:` / key named `apiKey` / task layer setting `ui.theme` | `E_UNKNOWN_KEY` with a suggestion / `E_SECRET_IN_SETTINGS` / `E_NOT_TASK_OVERRIDABLE` |
| UT-M8-01-07 | unit | `diff(user, effective)` | every entry classified `added/changed/removed/shadowed` with both provenances; stable ordering |
| AT-M8-01-01 | application | `GET /api/settings/provenance` for a key defined only in defaults | provenance layer `defaults`, file = catalog path, no shadowed entries |
| IT-M8-01-01 | integration | write `user.yaml` at runtime | `settings.reloaded` within 1 s; `GET /effective` reflects it; no daemon restart |
| IT-M8-01-02 | integration | corrupt `user.yaml` (unterminated string) | `settings.invalid` with file+line; previous effective tree still served; a running FakeProvider session is unaffected |
| IT-M8-01-03 | integration | second `ORCHESTRA_HOME` with only `user.yaml` | that home resolves its own user layer; the first home's effective tree is byte-identical to before |
| IT-M8-01-04 | integration | M2-09 regression: workspace `routing:` block only | `LayeredPolicyResolver` output and all M2-09 golden decisions unchanged |
| E2E-M8-01-01 | e2e | Settings screen provenance inspector | clicking a key shows winning layer, file:line and shadowed values; layer chips show valid/invalid state as icon + text |
| E2E-M8-01-02 | e2e | layer diff view | user-vs-effective diff renders added/changed/shadowed sections; keyboard navigable; axe-clean in dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-01-01 | User layer beats workspace | 1. Put `routing.taskTypes.boilerplate.primary: ["agy/gemini-flash"]` in `~/orchestra-scratch/.orchestra/workspace.yaml` 2. Preview a `boilerplate` task, note the model 3. Put `primary: ["claude/sonnet"]` for the same task type in `~/.orchestra/user.yaml` 4. Preview again | Second preview picks `claude/sonnet` within 1 s, no restart; the reason chip's provenance reads `user.yaml:<line>` | ⬜ |
| TC-M8-01-02 | Provenance and shadowing | 1. `orch settings explain routing.taskTypes.boilerplate.primary` | Prints the effective value, `user` / `~/.orchestra/user.yaml:<line>`, then the shadowed workspace value with its file:line, then the defaults value | ⬜ |
| TC-M8-01-03 | Teammate defaults (exit criterion 1) | 1. `ORCHESTRA_HOME=/tmp/home2 orch settings list` with only a `user.yaml` there setting `quick.provider` 2. Open Quick Delegate against that home 3. Switch back to the normal home and preview the same task | The second home's preview uses its own value with provenance `user.yaml:<line>`; the first home's preview is unchanged | ⬜ |
| TC-M8-01-04 | Negative: invalid YAML in one layer | 1. Open `~/.orchestra/user.yaml`, delete a closing quote, save 2. Watch the Settings screen 3. Run `orch settings explain routing.epsilon` 4. Check a running FakeProvider session | Red banner naming `user.yaml` and the line; layer chip shows *invalid*; `explain` still returns the last-known-good value and says the user layer is stale; the session keeps running | ⬜ |
| TC-M8-01-05 | Negative: conflicting layers | 1. Add `deny: ["agy/*"]` to `~/.orchestra/org.yaml` 2. Add `allow!append: ["agy/*"]` to `user.yaml` 3. Open the key in the provenance inspector | Effective value still denies agy; the inspector shows "sealed by org (`org.yaml:<line>`)" and explains that only an org edit lifts it; a `boilerplate` preview picks a non-agy model | ⬜ |
| TC-M8-01-06 | Negative: unknown key and secret key | 1. Add `routnig: {}` and `apiKey: "abc"` to `workspace.yaml`, save 2. Run `orch settings validate` | Two errors: unknown key with the `routing` suggestion, and `E_SECRET_IN_SETTINGS` for `apiKey`; exit code 2; effective tree unchanged | ⬜ |
| TC-M8-01-07 | Reload / resilience | 1. With valid layers, `kill -9` the daemon 2. Restart 3. `orch settings explain routing.epsilon` 4. Edit `workspace.yaml` while the daemon is down, then restart again | Same effective value and version hash after the first restart; after the second, the edit is picked up on boot with correct provenance; watchers re-established (a further live edit reloads within 1 s) | ⬜ |
| TC-M8-01-08 | Diff view | 1. Settings → Diff, choose `workspace` vs `effective` | Every key the user layer overrides appears as *shadowed*; every key only the workspace sets appears unchanged; counts match `orch settings diff` output | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Five layers resolve in the order task > user > workspace > org > defaults, with the documented merge algebra and 100 % branch coverage on `packages/core/src/settings/**`.
- [ ] Every effective leaf has provenance (layer, file, line) visible in the UI and from `orch settings explain`, including shadowed values (TC-M8-01-02).
- [ ] An invalid layer never replaces the last-known-good tree, never fails a preview and never disturbs a running session (IT-M8-01-02, TC-M8-01-04).
- [ ] A second `ORCHESTRA_HOME` yields independent user defaults with no effect on the first (IT-M8-01-03, TC-M8-01-03) — milestone exit criterion 1.
- [ ] M2-09 behaviour is unchanged: the routing golden suite passes with the new resolver behind `PolicyPort` (IT-M8-01-04).
- [ ] Hot reload is observable within 1 s of a file save on the Settings screen and in the next routing preview.
- [ ] `settings_layers` exists and is mirrored on every successful load; `settings.reloaded` / `settings.invalid` events are emitted and rendered in Health.
- [ ] Unknown keys, secret-shaped keys, sealed-key violations and non-task-overridable keys are rejected with file:line messages (TC-M8-01-06).
- [ ] Settings screen is keyboard-operable, axe-clean in dark/light and RTL; no status conveyed by colour alone.
- [ ] All TC-M8-01-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Directive syntax is a small language.** `!append` / `!override` are ergonomic but they are also a way to make "which rule won" unreadable. Mitigation: at most one directive per key per layer, sealing is explicit and reported, and `orch settings explain` prints the full chain. If TC-M8-01-05 reads badly, simplify the syntax before M8-02 builds editors on it — after M8-02 the cost of changing it multiplies.
- **Strict unknown-key rejection will bite during the milestone.** Sections registered by M8-02…M8-08 do not exist yet, so a user who writes `skills:` today gets an error. Mitigation: the registry ships stub sections with `since:` metadata so the message reads "section `skills` arrives in M8-04" rather than "unknown key".
- **Provenance depends on the YAML library's node positions.** If `yaml`'s document API loses positions for merged anchors or flow collections, some keys will point at the wrong line. Verify during implementation with UT-M8-01-01 covering anchors, flow lists and multi-line strings; fall back to a path→line index built by a second pass if needed.
- **Deny-wins across layers is deliberate and one-directional.** A workspace cannot recover from an over-broad org deny (flagged as an open question in M2-09 §8). The escalation path is an admin editing the org layer; M9-01 must give that edit a permission. Noted here so M9 designs it rather than discovers it.
- **The org layer over a URL** is stubbed. Signature verification, caching and offline behaviour are real work; keeping it behind `features.teamMode` means M8 never ships an unauthenticated remote settings fetch (C2).
- **Mirroring files into `settings_layers` creates two sources of truth** for the duration of M8. The mirror is write-only (nothing reads it) until M9-05 flips the direction; a test asserts no use case reads the table in M8.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
