# Step M8-04 — Skills system

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M8-01, M2-03 |
| Estimated effort | 3 days |
| Packages touched | `packages/core`, `packages/sdk`, `packages/catalog`, `packages/providers/*`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | High |
| Owner | |

## 1. Goal
After this step a **Skill** is a portable, versioned artifact — a directory with a `SKILL.md` (frontmatter: `name`, `version`, `taskTypes[]`, `providers[]`, `requiredCapabilities[]`, `inputs`, `evals[]`) plus optional resource files — that Orchestra stores in a three-scope library (org → workspace → user), assigns a **trust level** (`untrusted` → `reviewed` → `trusted`), and renders into each provider's *native* skills location through the adapter's `SkillsInstaller` when a task starts. Skills auto-attach to a task by task type + platform + provider capability; the Lead sees the attachable set in `capabilities()` (M2-05); seven starter packs ship for the user's stack. An imported skill is `untrusted` by default and cannot be installed until a human reviews it — 2026's npm worms target exactly these directories, so trust is a gate, not a label.

## 2. Why
- **D7** — skills are the intelligence layer's instruction artifacts. They must ship, update and be overridden without a release.
- **G7** (extensible and open) — skills are the main extension surface after providers; M10-03's signed registry can only exist if the artifact format, checksum and trust model are defined here.
- **G2 / G3** — a skill is how "the right model" also becomes "the right method": a Flutter clean-architecture skill makes a mid-tier model produce work a top-tier model would otherwise be needed for, and M8-05's evals prove it per provider.
- **D5** — installation is adapter work, not core work. `SkillsInstaller` already exists in the provider contract (`05-provider-contract.md §1`); core never learns where `.claude/skills` is.
- **C1 / C7** — skills are written into directories the vendor CLI documents, read from `manifest.paths.skillsDir`. Nothing is guessed, scraped or reverse-engineered; a manifest without a skills path means "this provider gets an instruction fragment instead" (M8-08), not "write somewhere plausible".
- **Supply chain (07 §Supply-chain controls)** — pinned checksums, untrusted-by-default import, explicit review, a preview of every file that will be written, and an audit row per install. This is a security control, not a convenience.

## 3. Scope
### In scope
- Skill artifact format (`SKILL.md` frontmatter + body + `resources/`), Zod schema in `packages/sdk/src/skill.ts`, content checksum over the whole directory.
- Library scopes and precedence: org (`~/.orchestra/org/skills/`) → workspace (`<repo>/.orchestra/skills/`) → user (`~/.orchestra/skills/`), plus shipped packs in `packages/catalog/skill-packs/`; same `id` in a higher scope shadows the lower one with provenance.
- Trust model: `untrusted | reviewed | trusted`; import defaults to `untrusted`; install requires `reviewed` or better; shipped packs start `trusted`; any content change resets the level to `untrusted` (checksum mismatch).
- `SkillResolver` (pure): task type + platform/language + provider + required capabilities + scope precedence → ordered attach list with reasons and exclusions.
- `InstallSkills` use case driving `adapter.skills.install(skill, scope, trust)` per the provider contract, with a **file-write preview** before anything is written and an audit row after.
- Worktree integration: skills are installed into the task's worktree at session start (hooks into the M1-03 `CreateWorktree` → `SessionSupervisor.start()` path, alongside `Launcher.preLaunchFiles()`), and removed with the worktree.
- `capabilities()` extension (M2-05): `skills[]` with id, version, taskTypes, trust, scope.
- `skills` settings section (M8-01 registry): `skills.autoAttach`, `skills.maxPerTask`, `skills.trustFloor`, `skills.disabled[]`, `skills.pinned[]`.
- Skills screen: library, packs, detail (rendered body, frontmatter, files, checksum, provenance), import, trust actions, install/uninstall with preview, per-provider install matrix.
- Seven starter packs: `clean-arch-flutter-feature`, `spring-boot-feature`, `nextjs-feature`, `gcp-cloud-run-deploy`, `flyway-migration`, `i18n-ar-en`, `adr-writing`.
- CLI: `orch skill list|show|import|trust|install|uninstall|validate`.
### Out of scope (deferred to …)
- Running a skill's `evals[]` and scoring it → deferred to M8-05 (this step parses and validates the `evals` block only).
- Skill health from outcomes and scorecard integration → deferred to M8-05 / M8-06.
- Installing from a signed registry or a GitHub URL → deferred to M10-03; M8 imports from a **local directory or a local archive only**.
- Sandboxing skill *execution* — skills are instruction text, not code; any executable resource file is rejected at validation time rather than sandboxed.
- Per-user permissions on who may raise a trust level → deferred to M9-01 (the action already carries `actor` and is audited).
- Instruction-file fragments for providers with no skills directory → deferred to M8-08.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`Skill`, `TrustLevel`, `SkillScope` and `SkillResolver` live in `packages/core/src/skills/`. Installation lives in adapters. Core never sees a path outside the artifact itself.

Rules:
- `id` = `^[a-z0-9][a-z0-9-]{1,63}$`, equal to the directory name (`E_ID_MISMATCH`). `version` is semver.
- `checksum` = SHA-256 over a canonical listing of `(relativePath, mode, sha256(content))` for every file in the directory, sorted. Stored on import; recomputed on every load. **Mismatch ⇒ trust drops to `untrusted`** and the skill is marked `modified` (`E_CHECKSUM_MISMATCH` when it happens during an install).
- File-type allowlist: `.md`, `.txt`, `.yaml`, `.yml`, `.json`, `.csv`, plus images under `resources/`. Any executable bit, symlink, or path escaping the skill directory ⇒ `E_UNSAFE_FILE` and the skill is unusable at any trust level. Total size ≤ 1 MiB, ≤ 64 files.
- Secret-shaped literals (M8-01 regex) anywhere in the artifact ⇒ `E_SECRET_IN_SKILL` (C13).
- Install gate: `install()` is refused unless `trust ∈ {reviewed, trusted}` **and** `trust ≥ settings.skills.trustFloor` (default `reviewed`). `E_UNTRUSTED_SKILL` carries the current level and what would raise it.
- Capability gate: a skill declaring `requiredCapabilities: [skills, subagents]` is not attachable to a provider whose `manifest.features` lacks them (`excluded:missing-capability`, reusing the M2-04 reason vocabulary). A provider whose manifest has no `paths.skillsDir` is excluded with `excluded:no-skills-location` and is a candidate for the M8-08 instruction-fragment path instead.
- Resolution order for auto-attach: scope precedence (user > workspace > org > shipped) for the same id; then explicit `skills.pinned` first, then declared `taskTypes` specificity (exact task type before a task-type group), then `version` desc, then id asc. Capped at `skills.maxPerTask` (default 3) — attaching ten skills to one task is how instruction budgets get blown.
- `SkillResolver` is total and returns both the attach list and the **excluded list with reasons**, like the assignment engine; "why didn't my skill attach" must be answerable without log spelunking.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/skill.ts
export type TrustLevel = 'untrusted' | 'reviewed' | 'trusted';
export type SkillScope = 'shipped' | 'org' | 'workspace' | 'user';
export type SkillInstallScope = 'project' | 'user';        // where the ADAPTER writes it (per manifest.paths)

export interface SkillFrontmatter {
  id: string; version: string; name: string; description: string;
  taskTypes: readonly TaskTypeId[];
  providers?: readonly ProviderId[];                       // absent = any provider that supports skills
  requiredCapabilities?: readonly CapabilityFlag[];
  platforms?: readonly string[];                           // 'flutter' | 'spring-boot' | 'nextjs' | language ids
  inputs?: readonly { name: string; description: string; required?: boolean }[];
  evals?: readonly SkillEvalSpec[];                        // parsed + validated here, executed in M8-05
  license?: string; source?: string;                       // origin url/path, informational
}
export interface Skill extends SkillFrontmatter {
  body: string;                                            // Markdown instructions
  files: readonly { path: string; bytes: number; sha256: string }[];
  scope: SkillScope; dir: string; checksum: string;
  trust: TrustLevel; modified: boolean;
  reviewedBy?: string; reviewedAt?: string;
}

// packages/sdk/src/adapter.ts — SkillsInstaller (already in 05-provider-contract §1) gains a dry run
export interface SkillsInstaller {
  install(skill: Skill, scope: SkillInstallScope, trust: TrustLevel): Promise<Result<void, AdapterError>>;
  /** Files that install() WOULD write — rendered, not written. Powers the preview (C10, zero-surprise). */
  plan(skill: Skill, scope: SkillInstallScope): Result<readonly FileWrite[], AdapterError>;
  uninstall(skillId: string, scope: SkillInstallScope): Promise<Result<void, AdapterError>>;
  location(scope: SkillInstallScope): string;              // from manifest.paths.skillsDir
}

// packages/core/src/skills/skill-resolver.ts
export interface AttachContext {
  taskTypeId: TaskTypeId; platform?: string; language?: string;
  provider: ProviderId; features: readonly CapabilityFlag[]; skillsDir?: string;
  settings: { autoAttach: boolean; maxPerTask: number; trustFloor: TrustLevel;
              disabled: readonly string[]; pinned: readonly string[] };
}
export interface AttachResult {
  attach: readonly { skill: Skill; reasons: readonly SkillReason[] }[];
  excluded: readonly { skill: Skill; reasons: readonly SkillReasonCode[] }[];
}
export class SkillResolver {
  constructor(private readonly library: readonly Skill[]) {}
  resolve(ctx: AttachContext): AttachResult;               // pure, deterministic, no I/O
}
export type SkillReasonCode =
  | 'matched-task-type' | 'matched-platform' | 'pinned' | 'higher-scope'
  | 'excluded:disabled' | 'excluded:untrusted' | 'excluded:below-trust-floor'
  | 'excluded:provider-not-listed' | 'excluded:missing-capability'
  | 'excluded:no-skills-location' | 'excluded:modified' | 'excluded:max-per-task';
```

```markdown
<!-- ~/.orchestra/skills/clean-arch-flutter-feature/SKILL.md -->
---
id: clean-arch-flutter-feature
version: 1.0.0
name: Clean Architecture Flutter feature
description: Implement a Flutter feature as domain/data/presentation layers with riverpod and tests.
taskTypes: [feature-impl, ui-impl]
platforms: [flutter, dart]
requiredCapabilities: [skills]
inputs:
  - { name: featureName, description: The feature directory name, required: true }
evals:
  - { id: todo-feature, taskType: feature-impl, fixture: fixtures/todo-repo,
      goal: "Add a Todo feature with domain, data and presentation layers",
      assert: { testsPass: true, maxBlockerFindings: 0, mustContain: ["lib/features/todo/domain"] } }
---
Implement the feature in three layers under `lib/features/{{featureName}}/` …
```

### 4.3 Data / schema changes
- `skills` table exists in `04-domain-model.md §4` (`id, name, version, scope, task_types_json, providers_json, trust_level, path`). Migration `m8_04_skills_ext` adds: `checksum TEXT NOT NULL`, `frontmatter_json TEXT NOT NULL`, `files_json TEXT NOT NULL`, `modified INTEGER NOT NULL DEFAULT 0`, `imported_at TEXT`, `imported_from TEXT`, `reviewed_by TEXT`, `reviewed_at TEXT`, `disabled INTEGER NOT NULL DEFAULT 0`. Unique index `(scope, id)`.
- New table `skill_installs`: `id, skill_id, skill_version, provider_id, install_scope ('project'|'user'), target_path, worktree_id NULL, task_id NULL, files_json, installed_at, removed_at NULL, checksum`. This is what makes uninstall exact (we remove what we wrote, never a directory we found) and what the Skills screen's install matrix reads.
- Migration `m8_04_tasks_skills`: `tasks.skills_json TEXT NULL` — the resolved attach list with reasons, recorded at assignment time so a result is reproducible.
- New events: `skill.imported {id, scope, checksum, trust, source}`, `skill.trust_changed {id, from, to, actor}`, `skill.installed {id, version, provider, installScope, taskId?, files[]}`, `skill.uninstalled {id, provider, installScope}`, `skill.attached {taskId, skillIds[], excludedCount}`, `skill.invalid {id, file, errors[]}`.
- `audit_log` rows for `skill.trust_changed`, `skill.installed`, `skill.uninstalled` (C10: writing files into an agent's instruction directory is a privileged action).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `SkillLibrarySource` (`apps/daemon/src/infrastructure/skills/`): scans the four scope roots, parses `SKILL.md`, walks files, computes the checksum, applies the file-type allowlist, persists into `skills`. Chokidar watchers per scope root (per-repo via the M1-03 repo registry). Per-skill invalidation: a broken skill never disables the library.
- Import: `orch skill import <dir>` / UI import copies a directory into the chosen scope root under a temp name, validates, computes the checksum, then renames into place. Archives (`.tar.gz`, `.zip`) are extracted into a temp dir with path-traversal rejection before validation. **No network import in M8** (registry is M10-03) — the importer rejects a URL with a pointer to that step.
- Install targets come from `manifest.paths.skillsDir` only. Per provider *(verify against each provider's docs at step start)*: Claude Code `.claude/skills` (project) / user-level equivalent; Antigravity `.agents/skills`; Codex and Kimi skills directories — each adapter's manifest supplies the path, and a provider whose manifest omits it is simply excluded (`excluded:no-skills-location`) rather than guessed at.
- Write mechanics inside a worktree: files are written under the adapter-declared directory in `<worktree>/`, recorded in `skill_installs.files_json`, and the worktree's `.git/info/exclude` gains the directory (M1-03 already manages `info/exclude`) so installed skills never appear in a `TaskResult` diff.
- Removal: `RemoveWorktree` (M1-03) already deletes the tree; `UninstallSkills` additionally marks `skill_installs.removed_at` and, for `install_scope: 'user'`, removes exactly the recorded files.
- Reconciliation at boot: for every `skill_installs` row with `removed_at IS NULL` whose worktree is gone, mark removed; for user-scope installs whose files changed on disk, mark `modified` and surface in Health.
- No tmux. No child processes except archive extraction through the existing `ProcessRunner` with an explicit env allowlist.

### 4.5 API / UI surface
- `GET /api/skills?repo=&taskType=&provider=&trust=` → library with scope, trust, modified flag, shadowing, install matrix summary.
- `GET /api/skills/:id?scope=` → full detail incl. rendered body, files, checksum, evals, provenance.
- `POST /api/skills/import` — body `{ path, scope }` → imported skill (always `untrusted`).
- `POST /api/skills/:id/trust` — body `{ level, note? }`, `If-Match: <checksum>` → `skill.trust_changed` + audit. Raising trust on a skill whose checksum changed since the review is refused.
- `POST /api/skills/:id/install/plan` — body `{ provider, installScope, repo? }` → `{ files: FileWrite[], location }` (nothing written).
- `POST /api/skills/:id/install` — same body + `Idempotency-Key` → writes, audits, emits.
- `DELETE /api/skills/:id/install?provider=&installScope=&repo=`.
- `POST /api/skills/resolve` — body `{ taskTypeId, platform?, provider, repo? }` → `AttachResult` (the "why didn't it attach" endpoint, used by the task drawer and by M8-02's panel).
- MCP `capabilities()` (M2-05) gains `skills: [{ id, version, name, taskTypes, trust, scope }]` — read-only, quota-free.
- CLI: `orch skill list [--task-type] [--provider] [--trust]`, `orch skill show <id>`, `orch skill import <dir> --scope user`, `orch skill trust <id> --level reviewed`, `orch skill install <id> --provider claude --scope project [--dry-run]`, `orch skill uninstall <id> --provider claude`, `orch skill validate <dir>`.
- UI `apps/web/src/features/skills/` (the **Skills** screen promised in `12-ux-principles.md`):
  - `SkillLibrary` — grid/list with search, filters (task type, provider, scope, trust), cards showing name, version, scope chip, trust badge (icon + word: *untrusted* / *reviewed* / *trusted*), *modified* warning, shadowing indicator.
  - `SkillDetail` — rendered Markdown body, frontmatter table, file list with sizes and hashes, checksum, provenance, eval list (read-only until M8-05), install matrix (row per installed provider, project/user scope, installed version, Uninstall).
  - `SkillImportDialog` — pick directory/archive, choose scope, validation report, always lands as *untrusted* with a one-line explanation of why.
  - `TrustDialog` — shows the diff since the last review when there was one, requires an explicit confirmation, records a note; raising trust is a distinct, deliberate action, never a toggle in a list row.
  - `InstallPreview` — the exact list of files and target paths before writing (UX principle 5, C10); Confirm writes.
  - `AttachExplainPopover` — in the task drawer: attached skills with reasons, excluded skills with reason labels.
  - States: `loading`, `empty` ("install a starter pack"), `invalid-skill`, `untrusted` (Install disabled with the reason in text), `modified`, `installing`, `installed`, `install-failed` (adapter error surfaced verbatim).
- Accessibility: trust and modified states are icon + word; the install preview is a real list, keyboard scrollable; EN/AR with RTL-safe Markdown rendering.

### 4.6 Flow / sequence
```
import ─▶ copy to temp ─▶ validate (schema · file allowlist · size · secrets · path traversal)
       ─▶ checksum ─▶ move into scope root ─▶ persist skills row (trust=untrusted) ─▶ skill.imported

review ─▶ TrustDialog (diff since last review) ─▶ POST /skills/:id/trust {reviewed}
       ─▶ checksum pinned as reviewedChecksum ─▶ skill.trust_changed + audit_log

task start (Quick Delegate / mission task)
  CreateWorktree (M1-03)
   └─▶ ResolveSkills: SkillResolver.resolve({taskType, platform, provider, features, settings})
        ├─ attach[] (≤ maxPerTask, reasons) ─▶ tasks.skills_json ─▶ skill.attached
        └─ excluded[] (reasons) ─▶ available in the task drawer
   └─▶ InstallSkills: for each attached skill
          adapter.skills.plan(skill, 'project')  ─▶ FileWrite[]  (preview in UI / --dry-run in CLI)
          adapter.skills.install(...)            ─▶ files under manifest.paths.skillsDir in the worktree
          ─▶ .git/info/exclude entry ─▶ skill_installs row ─▶ skill.installed + audit
   └─▶ SessionSupervisor.start() (Launcher.preLaunchFiles unchanged) ─▶ agent sees the skill natively

Lead session ─▶ MCP capabilities() ─▶ { …, skills: [{id, version, taskTypes, trust, scope}] }

task done ─▶ RemoveWorktree ─▶ mark skill_installs.removed_at ─▶ skill.uninstalled
```

### 4.7 Review reconciliation contract (2026-09-15)
Instruction packages retain the non-executable file allowlist. Evaluation code and fixture repositories belong to a separate trusted EvaluationEnvironment artifact pinned by repository revision/content hash, runner image/toolchain and declared commands. Skill metadata references this environment; installation never runs it. Dataset paths in a skill are inert allowed data, not executable setup scripts.

## 5. Tasks
- [ ] `SkillFrontmatter` / `Skill` types + Zod schema + `evals` sub-schema in `packages/sdk/src/skill.ts`; extend `SkillsInstaller` with `plan()` and `uninstall()`.
- [ ] Checksum function (canonical file listing → SHA-256) + file-type allowlist, symlink/traversal/executable rejection, size and count caps, secret scan.
- [ ] `SkillResolver` (pure) with the documented ordering, `maxPerTask` cap, and full `excluded[]` reasons; 100 % branch coverage.
- [ ] `SkillLibrarySource` + per-scope watchers + per-skill invalidation + persistence into `skills`.
- [ ] Migrations `m8_04_skills_ext`, `m8_04_skill_installs`, `m8_04_tasks_skills`; repositories.
- [ ] Use cases: `ImportSkill`, `SetSkillTrust` (checksum-pinned), `PlanSkillInstall`, `InstallSkills`, `UninstallSkills`, `ResolveSkillsForTask`, `ReconcileSkillInstalls` — one class each, `Result`-returning.
- [ ] `SkillsInstaller` implementations in `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, driven by `manifest.paths.skillsDir` *(verify each provider's documented location at step start)*; contract test added to the SDK harness.
- [ ] Worktree integration: hook `ResolveSkillsForTask` + `InstallSkills` into the M1-03 `CreateWorktree` → session-start path; `.git/info/exclude` entry; removal on worktree teardown; boot reconciliation.
- [ ] `skills` settings section registered against M8-01 (`autoAttach`, `maxPerTask`, `trustFloor`, `disabled`, `pinned`).
- [ ] MCP `capabilities()` extension in M2-05's server + schema update + test.
- [ ] Event schemas (`skill.*`) + audit rows for trust/install/uninstall; WS topic `skills`.
- [ ] `skills.controller.ts` (list, detail, import, trust, install/plan/install/uninstall, resolve) + OpenAPI + `Idempotency-Key`.
- [ ] Seven starter packs in `packages/catalog/skill-packs/` with bodies, `taskTypes`, `platforms`, and eval stubs; pack README.
- [ ] `apps/web` Skills screen: library, detail, import dialog, trust dialog, install preview, install matrix, attach-explain popover; nav entry; EN/AR.
- [ ] CLI `orch skill list|show|import|trust|install|uninstall|validate` with `--dry-run` and `--json`.
- [ ] Docs: `docs/skill-guide/` — format, scopes, trust model, per-provider locations, security notes.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-04-01 | unit | resolve for `feature-impl` on a Flutter repo with three candidate skills, `maxPerTask: 2` | two attached in the documented order with reasons; the third excluded with `excluded:max-per-task`; deterministic across runs |
| UT-M8-04-02 | unit | untrusted skill / trust floor `trusted` with a `reviewed` skill | excluded with `excluded:untrusted` / `excluded:below-trust-floor`; never silently dropped |
| UT-M8-04-03 | unit | skill requiring a capability the provider lacks; provider with no `skillsDir` | `excluded:missing-capability` / `excluded:no-skills-location` |
| UT-M8-04-04 | unit | checksum over a directory; then change one byte | different checksum; `modified: true`; trust drops to `untrusted` |
| UT-M8-04-05 | unit | artifact with a symlink, an executable file, a `../` path, 2 MiB of content, or `token: ghp_…` | `E_UNSAFE_FILE` × 3 / `E_TEMPLATE_TOO_LARGE`-equivalent size error / `E_SECRET_IN_SKILL`; skill unusable at any trust level |
| UT-M8-04-06 | unit | same id in user and workspace scope | user wins, workspace listed as shadowed; both keep their own trust levels |
| AT-M8-04-01 | application | `InstallSkills` for an `untrusted` skill | `Err(E_UNTRUSTED_SKILL)` naming the current level and the action that would raise it; zero files written; no `skill_installs` row |
| AT-M8-04-02 | application | `SetSkillTrust` with a stale `If-Match` checksum | refused; trust unchanged; audit row absent |
| AT-M8-04-03 | application | `InstallSkills` replayed with the same `Idempotency-Key` | one `skill_installs` row, one `skill.installed` event, files written once |
| IT-M8-04-01 | integration | full task start with FakeProvider | resolved skills land under the manifest-declared dir inside the worktree; `.git/info/exclude` contains it; `tasks.skills_json` records attach + reasons |
| IT-M8-04-02 | integration | complete the task and collect the result (M3-03 path) | the `TaskResult` diff contains **no** skill files; `skill_installs.removed_at` set after worktree removal |
| IT-M8-04-03 | integration | daemon restart with a worktree deleted externally | boot reconciliation marks the install removed; Health shows no stale rows; library unaffected |
| IT-M8-04-04 | integration | `capabilities()` from a Lead session | `skills[]` lists exactly the attachable set with trust and scope; call is quota-free and read-only |
| E2E-M8-04-01 | e2e | import an invalid skill from the UI | validation report lists each problem with file names; skill is not added; nothing written outside the temp dir |
| E2E-M8-04-02 | e2e | import → untrusted → review → install with preview | Install disabled while untrusted with the reason in text; preview lists every file and target path; after Confirm the install matrix shows the provider row |
| E2E-M8-04-03 | e2e | attach-explain popover | the task drawer lists attached skills with reasons and excluded skills with reason labels; axe-clean dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-04-01 | Starter pack install (Claude Code) | 1. Skills → `clean-arch-flutter-feature` 2. Install → provider Claude Code, scope project, repo `~/orchestra-scratch` 3. Read the preview, Confirm 4. `ls` the manifest-declared skills dir | Preview lists exact files and the target path; after Confirm the files exist at the documented location; `skill.installed` and an `audit_log` row present | ⬜ |
| TC-M8-04-02 | Auto-attach at task start | 1. Quick Delegate a `feature-impl` task on the Flutter scratch repo 2. Open the task drawer → Skills | `clean-arch-flutter-feature` attached with reason `matched-task-type` + `matched-platform`; files present inside the worktree; excluded list shows the non-matching skills with reasons | ⬜ |
| TC-M8-04-03 | Lead sees skills | 1. Start a Lead session 2. From Missions › Lead session, inspect the `capabilities()` response | `skills[]` includes the attached-capable skills with id, version, trust and scope; no file paths leak; the call spends nothing | ⬜ |
| TC-M8-04-04 | Second provider | 1. Install the same skill for Codex, scope project 2. Start a Codex task of the same type | Files land in Codex's manifest-declared location *(verify against Codex docs at step start)*; install matrix shows two provider rows; the two installs are independent | ⬜ |
| TC-M8-04-05 | Negative: untrusted skill | 1. `orch skill import ~/orchestra-scratch/skills/bad-skill --scope user` 2. Open it in the UI 3. Try Install, then try `orch skill install bad-skill --provider claude` | Badge *untrusted*; Install button disabled with a visible reason; CLI exits non-zero with `E_UNTRUSTED_SKILL`; zero files written anywhere | ⬜ |
| TC-M8-04-06 | Negative: unsafe artifact | 1. Add a symlink pointing outside the directory and an executable `.sh` to a skill folder 2. Reload the library 3. Try to install it | Skill marked invalid with both problems named per file; install refused at any trust level; the rest of the library still loads (C-supply-chain) | ⬜ |
| TC-M8-04-07 | Negative: modified after review | 1. Mark a skill *reviewed* 2. Edit its `SKILL.md` body from a terminal 3. Reload the library 4. Try to install | Trust drops to *untrusted* with a *modified* warning; the trust dialog shows the diff since the review; install is refused until re-reviewed | ⬜ |
| TC-M8-04-08 | No leakage into results | 1. Run a task with two skills attached to completion 2. Open Review → the task diff 3. `git status` in the worktree before teardown | The diff contains only the agent's changes; skill files are excluded via `.git/info/exclude`; after teardown `skill_installs.removed_at` is set | ⬜ |
| TC-M8-04-09 | Reload / resilience | 1. With skills installed in an active worktree, `kill -9` the daemon 2. Restart 3. Open Skills and the task drawer | Library and install matrix identical after restart; installs reconciled (no phantom rows); adding a skill directory from a terminal appears within 1 s | ⬜ |
| TC-M8-04-10 | Scope shadowing | 1. Put a modified `adr-writing` in `<repo>/.orchestra/skills/` 2. Put another in `~/.orchestra/skills/` 3. Resolve for an `adr-writing` task | User scope wins with reason `higher-scope`; the workspace copy is listed as shadowed in the library; only one is installed | ⬜ |

### 6.3 Review regression scenarios
- [ ] Executable fixture hidden inside a skill is rejected.
- [ ] Valid environment reference installs without executing any code.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] A skill validates, checksums, imports as `untrusted`, and cannot be installed until reviewed; every trust change and install is audited (TC-M8-04-05, AT-M8-04-01/02).
- [ ] Unsafe artifacts (symlink, executable, traversal, oversize, secret-bearing) are rejected at any trust level and never write a file (UT-M8-04-05, TC-M8-04-06).
- [ ] Installation targets come exclusively from `manifest.paths.skillsDir`; a provider without one is excluded with a reason, never guessed (UT-M8-04-03, TC-M8-04-04).
- [ ] Auto-attach resolves by task type + platform + provider + trust with a visible reason per attached and per excluded skill (TC-M8-04-02, E2E-M8-04-03).
- [ ] Installed skill files never appear in a `TaskResult` diff and are removed with the worktree (IT-M8-04-02, TC-M8-04-08).
- [ ] The Lead's `capabilities()` lists the attachable skills, read-only and quota-free (IT-M8-04-04, TC-M8-04-03).
- [ ] Seven starter packs ship, validate, and install into at least Claude Code and Codex worktrees (milestone exit criterion 6).
- [ ] Every install is previewed file-by-file before writing, in the UI and via `--dry-run` (C10, TC-M8-04-01).
- [ ] `SkillResolver` at 100 % branch coverage; Skills screen keyboard-operable and axe-clean in dark/light and RTL.
- [ ] All TC-M8-04-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Vendor skill locations are the biggest unknown in this step.** `.claude/skills` and `.agents/skills` are the documented shapes we have; Codex's and Kimi's skill directories must be *(verified against each provider's docs at step start)* and encoded in `manifest.paths.skillsDir`, never hard-coded. If a provider has no documented location, it gets `excluded:no-skills-location` and M8-08's instruction fragment instead — that fallback must be in place before this step is called done.
- **Manifest drift breaks installs silently.** A CLI version outside `cliVersionRange` already marks commands unverified (M2-03); installs into a changed directory would write to a path the agent ignores. Mitigation: Doctor (M6-02) opens a RepairCase when `paths.skillsDir` mismatches; the Skills screen shows an *unverified location* chip.
- **Supply chain is the real threat model.** 2026 npm worms target `.claude/` specifically. Untrusted-by-default, the file allowlist, checksum pinning, the install preview and audit rows are the controls. What they do **not** cover: a human who clicks *trusted* on a hostile skill. Mitigation is the trust dialog showing the full body and diff — resist any future "trust all" affordance.
- **Instruction budget.** Three skills of a few KB each plus composed instruction files (M8-08) plus the task goal can crowd a model's context. `maxPerTask` is the blunt control; M8-05's evals are what will show whether attaching more helps or hurts. Do not raise the default without eval evidence.
- **`install_scope: 'user'` writes outside any worktree**, into the user's home provider config. That is deliberate (some skills should be always-on) but it is the only place Orchestra touches files a user owns outside `~/.orchestra` and the repo. Exact-file uninstall via `skill_installs.files_json` is the mitigation; never remove a directory.
- **Checksum-on-every-load cost** for a large library is measurable. Cache by `(path, mtime, size)` and recompute on change; a test asserts a tampered file still invalidates even when mtime is preserved (attacker-controlled mtime) by including size and content hash per file.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
