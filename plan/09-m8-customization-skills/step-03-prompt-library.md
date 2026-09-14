# Step M8-03 — Prompt library

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M8-01 |
| Estimated effort | 1.5 days |
| Packages touched | `packages/core`, `packages/catalog`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | Low |
| Owner | |

## 1. Goal
After this step the phrasings a user keeps retyping become **prompt templates**: Markdown files with frontmatter and `{{variables}}`, stored per scope (org → workspace → user), categorised by task type, versioned on every save. They are insertable from the Chat `/` palette (M2-08) as `/prompt <id>`, from the Quick Delegate goal field (M2-06), and from `orch prompt render`. A template with variables opens a small typed form (text, enum, boolean, multiline, `repo`, `taskType`), renders strictly — an unfilled required variable is an error, never an empty string in a prompt sent to a paid model — and records which template version produced which task goal so a bad prompt is traceable after the fact.

## 2. Why
- **D7** — prompts are the most-edited piece of "intelligence" a user owns and the one that most obviously must not require a release. Templates are the smallest possible versioned artifact.
- **G7** — prompt packs are a publishable artifact family alongside skills and playbooks (M10-03 ships them from the registry once a format exists).
- **G5 (total recall)** — recording `promptTemplateId@version` on the task and on the message means "what exactly did I ask, last Tuesday" is answerable without diffing free text.
- **C10** — a template that silently interpolates an empty variable turns into a wasted paid run. Strict rendering is a spend control, not a nicety.
- **UX principle 3 (keyboard-first)** — `/prompt` in Chat and the `⌘K` palette are the intended entry points; a library nobody can reach in two keystrokes does not get used.
- **C13** — templates are files a user may paste anything into; a secret-shaped literal in a template body is refused at load time rather than being sent to a vendor CLI.

## 3. Scope
### In scope
- Template format: Markdown file with YAML frontmatter, one template per file, under `<scope>/prompts/*.md`.
- Scopes and precedence: org (`~/.orchestra/org/prompts/`) → workspace (`<repo>/.orchestra/prompts/`) → user (`~/.orchestra/prompts/`); same `id` in a higher scope shadows the lower one, with provenance shown (same rule shape as M8-01 layers, reusing its precedence order minus `task`/`defaults`).
- Pure `PromptRenderer`: `{{var}}` substitution only — no conditionals, no loops, no includes, no arbitrary expressions; unknown variable ⇒ error; unfilled required variable ⇒ error; `{{{var}}}` (raw) is **not** supported (all values are inserted verbatim into Markdown, there is no escaping context to opt out of).
- Built-in variables always available: `{{repo.name}}`, `{{repo.path}}`, `{{branch}}`, `{{taskType}}`, `{{today}}`, `{{user.label}}`.
- Versioning: `version` (semver) in frontmatter; every save appends a `prompt.template_saved` event with the content hash; `orch prompt history <id>` lists versions from events; the library shows a version chip and a diff against the previous version.
- Shipped starter templates in `packages/catalog/prompts/` (8: `adr-skeleton`, `bug-repro`, `feature-spec`, `refactor-brief`, `review-focus`, `test-plan`, `commit-message`, `incident-timeline`).
- Surfaces: Chat `/prompt` palette entry, Quick Delegate "Use template" affordance, a Prompt library panel under Settings › Prompts (list, search by category/task type, preview, variable form, insert/copy, new/edit/delete, version chip + diff).
- CLI: `orch prompt list|show|render|history`.
### Out of scope (deferred to …)
- Skills (instruction artifacts installed into provider skill dirs) → deferred to M8-04; a prompt template is text a *human* inserts, a skill is an artifact an *agent* loads. They stay separate formats on purpose.
- Instruction-file fragments (CLAUDE.md / AGENTS.md composition) → deferred to M8-08.
- Publishing/installing prompt packs from a registry → deferred to M10-03.
- Auto-suggesting a template based on the goal text (any LLM-assisted selection) → not planned for M8; selection stays explicit.
- Per-user permissions on which scope may be edited → deferred to M9-01.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`PromptTemplate` is a value object in `packages/core/src/prompts/`. `PromptRenderer` is a pure domain service. Neither touches the filesystem.

Rules:
- `id` is `^[a-z0-9][a-z0-9-]{1,63}$` and must equal the filename stem — a template whose id and filename disagree is an error (`E_ID_MISMATCH`), so the file on disk is always findable from the id in a task record.
- `version` is semver; saving without bumping the version when the body changed is an error (`E_VERSION_NOT_BUMPED`) — the UI bumps the patch automatically, the CLI refuses.
- Every `{{name}}` occurring in `body` must be declared in `variables[]` or be a built-in (`E_UNDECLARED_VARIABLE`, listing the offenders). The reverse (a declared variable never used) is a warning.
- `required` variables without a `default` must be supplied at render time (`E_MISSING_VARIABLE`).
- `enum` variables reject values outside `options` (`E_BAD_ENUM_VALUE`).
- Body max 16 KiB; a larger file is refused (`E_TEMPLATE_TOO_LARGE`) — a prompt that big is a skill or a document, not a template.
- Secret-shaped literals in the body (same regex as M8-01) ⇒ `E_SECRET_IN_TEMPLATE` (C13).
- Rendering is total and side-effect-free: same inputs ⇒ byte-identical output; `{{today}}` comes from the injected `Clock`, never `Date.now()`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/prompts/types.ts
export type PromptScope = 'org' | 'workspace' | 'user' | 'shipped';
export type PromptVarType = 'text' | 'multiline' | 'enum' | 'boolean' | 'number' | 'repo' | 'taskType';

export interface PromptVariable {
  name: string; type: PromptVarType; label?: string; description?: string;
  required?: boolean; default?: string | number | boolean; options?: readonly string[];  // enum only
}
export interface PromptTemplate {
  id: string; version: string; name: string; description?: string;
  category: string;                              // free text, used for grouping in the palette
  taskTypes?: readonly TaskTypeId[];             // filters the palette when a task type is known
  variables: readonly PromptVariable[];
  body: string;                                  // Markdown with {{variables}}
  scope: PromptScope; file: string; contentHash: string;
}

export type PromptError =
  | { code: 'E_ID_MISMATCH'; id: string; file: string }
  | { code: 'E_VERSION_NOT_BUMPED'; id: string; version: string }
  | { code: 'E_UNDECLARED_VARIABLE'; id: string; names: readonly string[] }
  | { code: 'E_MISSING_VARIABLE'; id: string; names: readonly string[] }
  | { code: 'E_BAD_ENUM_VALUE'; id: string; name: string; value: string; options: readonly string[] }
  | { code: 'E_TEMPLATE_TOO_LARGE'; id: string; bytes: number }
  | { code: 'E_SECRET_IN_TEMPLATE'; id: string; line: number }
  | { code: 'FRONTMATTER'; file: string; line: number; message: string };

export class PromptRenderer {
  constructor(private readonly clock: Clock) {}
  render(t: PromptTemplate, values: Readonly<Record<string, unknown>>, ctx: RenderContext):
    Result<{ text: string; used: Readonly<Record<string, string>> }, PromptError>;
  validate(t: PromptTemplate): Result<{ warnings: readonly string[] }, PromptError[]>;
}
export interface RenderContext { repo?: { name: string; path: string }; branch?: string;
  taskType?: TaskTypeId; userLabel?: string }

// packages/core/src/prompts/prompt-library.ts — pure resolution across scopes
export class PromptLibrary {
  constructor(private readonly templates: readonly PromptTemplate[]) {}   // all scopes, unresolved
  resolve(): readonly { template: PromptTemplate; shadows: readonly PromptTemplate[] }[];
  get(id: string): Result<PromptTemplate, { code: 'E_NO_SUCH_TEMPLATE'; id: string }>;
}
```

```markdown
<!-- ~/.orchestra/prompts/adr-skeleton.md -->
---
id: adr-skeleton
version: 1.2.0
name: ADR skeleton
description: Architecture decision record with context, options, decision, consequences.
category: docs
taskTypes: [adr-writing, architecture]
variables:
  - { name: title,    type: text,      required: true,  label: Decision title }
  - { name: options,  type: multiline, required: true,  label: Options considered }
  - { name: audience, type: enum,      options: [team, org, public], default: team }
---
Write an ADR for **{{title}}** in `{{repo.name}}` (branch `{{branch}}`), dated {{today}}.

Audience: {{audience}}.

Options considered:
{{options}}

Follow the repository's existing ADR format. Output only the ADR file content.
```

### 4.3 Data / schema changes
- **No new table.** Templates are files; this keeps them diffable, git-friendly and consistent with `04-domain-model.md §4`, which has no prompts table. History comes from the append-only `events` table.
- New event types: `prompt.template_saved {id, scope, version, contentHash, file, actor}`, `prompt.template_deleted {id, scope, file, actor}`, `prompt.template_used {id, version, scope, surface: 'chat'|'quick-delegate'|'cli', sessionId?, taskId?}`.
- Migration `m8_03_prompt_usage`: `tasks.prompt_template_json TEXT NULL` (`{id, version, scope, values}` with values redacted by the standard serializer) and `messages.prompt_template_id TEXT NULL`, `messages.prompt_template_version TEXT NULL`. Both nullable, no backfill.
- FTS: templates are indexed into the existing `fts_*` family (M5-03) as a new source so History search finds "which template mentioned Flyway".

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `PromptFileSource` in `apps/daemon/src/infrastructure/prompts/`: reads `*.md` from the three scope directories plus the shipped catalog; `gray-matter`-style frontmatter split with line offsets preserved so errors point at real lines.
- One chokidar watcher per scope directory (per-repo watchers tied to the M1-03 repo registry, like M8-01). Reload is per file: a broken template marks *that template* invalid and leaves the rest of the library usable — a stricter last-known-good than M8-01 needs, because templates are independent of each other.
- Writes reuse M8-02's `AtomicYamlWriter` pattern (temp + rename + single `.bak`); `~/.orchestra/prompts/` is 0700, files 0600.
- Delete moves the file to `~/.orchestra/prompts/.trash/<id>-<ts>.md` rather than unlinking (nothing in Orchestra hard-deletes user content without an explicit purge — M5-06 owns purge).
- No network, no tmux, no child processes. Rendering happens in the daemon; the rendered text travels to the CLI only through the existing session/task paths.

### 4.5 API / UI surface
- `GET /api/prompts?repo=&taskType=&q=` → resolved library with `shadows[]` and per-template scope/provenance.
- `GET /api/prompts/:id?repo=` → one template incl. body and variables.
- `POST /api/prompts/render` — body `{ id, values, repo?, taskType? }` → `{ text, used }` or `422 { errors }`. Does not emit `prompt.template_used` (the *consumer* emits it when the text is actually sent).
- `PUT /api/prompts/:id` (create/update, `If-Match: <contentHash>`), `DELETE /api/prompts/:id?scope=` → trash move.
- `POST /api/prompts/validate` — body `{ frontmatter, body }` → errors/warnings, for the editor's live gutter.
- `GET /api/prompts/:id/history` → versions from `prompt.template_saved` events with hashes and timestamps.
- CLI: `orch prompt list [--task-type] [--scope]`, `orch prompt show <id>`, `orch prompt render <id> --var title=… [--json]`, `orch prompt history <id>`.
- UI:
  - Chat (`apps/web/src/features/chat/`): `/prompt` entry in the existing `/` palette (M2-08), filtered by the session's task type when known; selecting a template opens `PromptVariableForm` in a popover; **Insert** places the rendered text in the composer (never sends it — the user still presses send, UX principle 5).
  - Quick Delegate (M2-06 dialog): "Use template" button next to the goal field → same form → fills the goal; the chosen `{id, version}` rides along on the task and shows in the task drawer.
  - `Settings › Prompts` (`apps/web/src/features/settings/prompts/`): `PromptLibraryList` (search, category and task-type filters, scope chips, shadowed indicator), `PromptPreview` (rendered Markdown with variables highlighted), `PromptEditor` (frontmatter form + Markdown body in CodeMirror, live validation gutter, variable auto-detection offering to declare undeclared `{{names}}`), `PromptVersionDiff` (this version vs previous), `PromptVariableForm` (typed controls, required markers, live preview of the rendered text).
  - States: `loading`, `empty` (with "start from a shipped template"), `invalid-template` (card shows the error and is not insertable), `shadowed`, `dirty`, `conflict`, `saved`.
- Accessibility: the variable form is a real form with labels and `aria-describedby` for descriptions; required is marked with text plus an asterisk; the palette is fully keyboard-driven; EN/AR with RTL-safe Markdown preview.

### 4.6 Flow / sequence
```
boot / file change ─▶ PromptFileSource.load(scope dirs) ─▶ PromptTemplate[] (per-file validation)
   ├─ invalid file ─▶ mark that template invalid (others unaffected) ─▶ WS 'prompts' delta
   └─ ok ─▶ PromptLibrary.resolve() (user > workspace > org > shipped) ─▶ WS snapshot

Chat: "/" ─▶ palette ─▶ /prompt adr-skeleton ─▶ GET /api/prompts/adr-skeleton
   ─▶ PromptVariableForm ─▶ POST /api/prompts/render {values, repo, branch, taskType}
   ─▶ PromptRenderer.render (strict; missing required ⇒ 422 listing names)
   ─▶ text into composer ─▶ user sends ─▶ message stored with prompt_template_id/version
   ─▶ prompt.template_used {surface:'chat', sessionId}

Quick Delegate: "Use template" ─▶ same render ─▶ goal field
   ─▶ Delegate ─▶ tasks.prompt_template_json = {id, version, scope, values}
   ─▶ prompt.template_used {surface:'quick-delegate', taskId}

Save in editor ─▶ validate ─▶ PUT /api/prompts/:id (If-Match)
   ─▶ atomic write ─▶ prompt.template_saved {version, contentHash} ─▶ watcher ─▶ library swap
```

## 5. Tasks
- [ ] `PromptTemplate` / `PromptVariable` VOs, frontmatter Zod schema, `PromptError` union + human formatter shared by CLI and UI.
- [ ] `PromptRenderer.render/validate` — strict substitution, built-ins from `Clock`/`RenderContext`, all error branches; 100 % branch coverage.
- [ ] `PromptLibrary.resolve()` with scope precedence and `shadows[]`.
- [ ] `PromptFileSource` + per-scope watchers (per-repo lifecycle via the M1-03 repo registry) + per-file invalidation.
- [ ] Write path: `SavePromptTemplate` / `DeletePromptTemplate` use cases (atomic write, `If-Match`, trash move, version-bump enforcement, audit).
- [ ] Event schemas `prompt.template_saved|deleted|used`; WS topic `prompts` (snapshot + delta).
- [ ] Migration `m8_03_prompt_usage` (`tasks.prompt_template_json`, `messages.prompt_template_id/version`) + FTS source registration.
- [ ] `prompts.controller.ts` (list, get, render, put, delete, validate, history) + OpenAPI.
- [ ] Eight shipped templates in `packages/catalog/prompts/` with frontmatter, variables and a README table.
- [ ] Chat `/prompt` palette entry + `PromptVariableForm` popover + composer insertion (never auto-send).
- [ ] Quick Delegate "Use template" affordance + `{id, version}` recorded on the task and shown in the task drawer.
- [ ] `Settings › Prompts`: library list, preview, editor with live validation and undeclared-variable quick fix, version diff.
- [ ] CLI `orch prompt list|show|render|history`.
- [ ] Docs: `docs/` "Prompt templates" page — format, variables, scopes, precedence, versioning.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-03-01 | unit | render with all variables supplied, incl. built-ins | byte-identical output on repeat; `used` map records every substituted value; `{{today}}` comes from the injected clock |
| UT-M8-03-02 | unit | missing required variable / bad enum value / undeclared `{{x}}` in body | `E_MISSING_VARIABLE` listing names / `E_BAD_ENUM_VALUE` with options / `E_UNDECLARED_VARIABLE` listing offenders — never a silent empty string |
| UT-M8-03-03 | unit | id ≠ filename stem; body edited without version bump; 20 KiB body; body containing `apiKey: sk-…` | `E_ID_MISMATCH` / `E_VERSION_NOT_BUMPED` / `E_TEMPLATE_TOO_LARGE` / `E_SECRET_IN_TEMPLATE` with the line |
| UT-M8-03-04 | unit | same id in user and workspace scope | user wins; `shadows[]` lists the workspace template with its file path |
| AT-M8-03-01 | application | `SavePromptTemplate` with a stale `If-Match` | conflict error, file untouched, no `prompt.template_saved` event |
| AT-M8-03-02 | application | `DeletePromptTemplate` | file moved to `.trash/` (still readable), library no longer lists it, `prompt.template_deleted` emitted |
| IT-M8-03-01 | integration | drop a new `.md` into `~/.orchestra/prompts/` | appears in `GET /api/prompts` within 1 s and in the Chat palette without a restart |
| IT-M8-03-02 | integration | one template with broken frontmatter among five | only that template is marked invalid; the other four render normally; the error names the file and line |
| IT-M8-03-03 | integration | render via Quick Delegate and complete the task | `tasks.prompt_template_json` holds `{id, version, scope}`; History search finds the task by template id |
| E2E-M8-03-01 | e2e | Chat `/prompt adr-skeleton` with variables | form shows required markers; Insert fills the composer and does **not** send; message row records id + version |
| E2E-M8-03-02 | e2e | editor quick fix for an undeclared variable | typing `{{owner}}` in the body offers "declare `owner`"; accepting adds it to `variables[]`; Save bumps the patch version |
| E2E-M8-03-03 | e2e | version diff | after two saves, the diff view shows the body change between versions; keyboard navigable; axe-clean dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-03-01 | Insert from Chat | 1. Open a Claude session's Chat 2. Type `/prompt` 3. Pick `adr-skeleton` 4. Fill `title` and `options`, leave `audience` default 5. Insert | Palette filters to templates matching the session's task type; the composer receives fully rendered Markdown with `{{repo.name}}` and `{{today}}` resolved; nothing is sent until you press send | ⬜ |
| TC-M8-03-02 | Use from Quick Delegate | 1. Quick Delegate, task type `adr-writing` 2. "Use template" → same template 3. Fill and Delegate 4. Open the task drawer | The goal is the rendered text; the drawer shows `adr-skeleton@1.2.0 (user)`; the routing preview appeared before anything ran (C10) | ⬜ |
| TC-M8-03-03 | Scope shadowing | 1. Create `review-focus.md` in `~/orchestra-scratch/.orchestra/prompts/` 2. Create a different `review-focus.md` in `~/.orchestra/prompts/` 3. Open Settings › Prompts | The user version is active with a *shadows workspace* chip; the preview shows which file is in effect; the palette offers exactly one `review-focus` | ⬜ |
| TC-M8-03-04 | Negative: missing required variable | 1. `orch prompt render adr-skeleton --var audience=team` | Exit non-zero with `E_MISSING_VARIABLE` naming `title` and `options`; nothing rendered, nothing sent, no `prompt.template_used` event | ⬜ |
| TC-M8-03-05 | Negative: broken frontmatter | 1. Edit a template file, break the YAML frontmatter (unclosed bracket), save 2. Open the library and the Chat palette | That template's card shows the error with file:line and is not insertable; every other template still works; the daemon logs `prompts` delta and stays up | ⬜ |
| TC-M8-03-06 | Negative: secret in a template | 1. Paste `token: ghp_xxxxxxxx` into a template body and save from the editor | Save refused with `E_SECRET_IN_TEMPLATE` and the line number; file on disk unchanged; the text never reaches a provider (C13) | ⬜ |
| TC-M8-03-07 | Versioning and history | 1. Edit a template body in the UI and save twice 2. `orch prompt history adr-skeleton` 3. Open the diff view | Patch version auto-bumped on each save; history lists three entries with hashes and timestamps; the diff shows only the body change | ⬜ |
| TC-M8-03-08 | Reload / resilience | 1. With the library open, `kill -9` the daemon 2. Restart 3. Add a new template file from a terminal 4. Re-open the palette | Library identical after restart; the new file appears within 1 s without a UI reload; watchers re-established | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Templates load from four sources with the documented precedence and visible shadowing (UT-M8-03-04, TC-M8-03-03).
- [ ] Rendering is strict and total: no unfilled required variable, unknown variable or bad enum value ever produces text (UT-M8-03-02, TC-M8-03-04).
- [ ] Templates are insertable from Chat `/prompt`, from Quick Delegate, and from `orch prompt render`, and insertion never auto-sends (TC-M8-03-01/02).
- [ ] `{id, version, scope}` is recorded on the task and on the message, and History search finds work by template id (IT-M8-03-03).
- [ ] Saves are atomic, `If-Match`-guarded, version-bump-enforced and audited; deletes go to trash, never to `unlink` (AT-M8-03-01/02).
- [ ] One broken template never disables the library (IT-M8-03-02, TC-M8-03-05); secret-shaped bodies are refused (TC-M8-03-06).
- [ ] Eight shipped templates load, validate and render against the scratch repo.
- [ ] Library, editor and variable form are keyboard-operable and axe-clean in dark/light and RTL, EN + AR.
- [ ] All TC-M8-03-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Templates vs skills will confuse people.** Both are Markdown with frontmatter; one is inserted by a human, the other installed for an agent (M8-04). Mitigation: distinct directories, distinct frontmatter keys, and a one-paragraph "which do I want?" box at the top of both docs pages. If the confusion persists after M8-04's TCs, consider merging the formats in M10 — but not before both have real users.
- **No template engine is a feature, and will be argued about.** Someone will want a conditional. Mitigation: say no in M8; conditional content belongs in a skill, which the agent reads with judgement. Revisit only with an ADR.
- **Version-bump enforcement is friction** in the CLI (`E_VERSION_NOT_BUMPED`). The UI auto-bumps; the CLI refuses on purpose so scripted edits cannot rewrite history silently. Watch TC-M8-03-07 for whether the UI behaviour is discoverable enough.
- **Storing rendered values on the task** (`prompt_template_json.values`) can capture sensitive free text a user typed into a variable. It goes through the redacting serializer, but redaction is regex-based. Mitigation: values are stored only for variables declared non-`multiline`, and M5-06's manual redaction covers the rest; revisit if a TC surfaces something sensitive.
- **FTS indexing of template bodies** adds a source to the M5-03 index; if the index rebuild becomes noticeable, index only `name`, `description` and `category` and drop bodies.
- **Frontmatter line offsets** must survive the split so errors point at the real file line. Library-dependent; verify during implementation and add a unit test with a multi-line description and a body containing `---`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
