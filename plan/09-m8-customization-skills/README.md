# Milestone M8 — Customization & skills

> Folder: `plan/09-m8-customization-skills/` · Steps: M8-01 … M8-08 · Effort: ~18 d · Status: ⬜

## Goal

After M8 the intelligence layer is fully **data, not code** (D7): every knob that decides *what runs where* — routing policy, roles, task-type overrides, prompt templates, skills, playbooks, instruction files, auto-answer rules, notification and update channels — lives in versioned, layered files (`task > user > workspace > org > defaults`) that a person edits through validated editors with a live preview, and that the daemon hot-reloads without a restart. Skills become portable artifacts rendered into each provider's native location under a trust level, with evals that run fixture tasks across providers and write real `outcomes`. Those outcomes, plus the outcomes of every mission task since M3, feed a bounded, decaying, *local* learning loop that shows up as a Model Scorecard and as evidence in every "why this model" panel. A teammate can have their own defaults without touching anyone else's.

## Why this milestone now

- M2–M4 produced the engines (assignment, review rule, quota forecaster) and M3-04 / M4-01 produce the raw evidence (`reviews`, `review_findings`, `task_results`, usage). Nothing consumes that evidence yet; G2 ("right model, every time") cannot improve without it.
- M2-09 shipped a single routing YAML; the source plan (§16) requires five layers with precedence and provenance. Every later editor (M8-02…M8-08) and RBAC (M9-01) needs that engine first.
- Skills are the main G7 extensibility surface after providers; the registry (M10-03) can only ship signed artifacts if the artifact format, trust model and installers exist.
- Team-lead and team-member personas (M8–M9) start here: per-user defaults and org policy are the prerequisite for permissions in M9.

## Entry criteria

- M2 complete (M2-01 taxonomy, M2-02 model catalog, M2-03 manifests, M2-04 assignment engine, M2-05 MCP `capabilities()`, M2-06 Quick Delegate v2, M2-08 Chat `/` palette, M2-09 routing policy file) ✅.
- M3-01 playbook schema, M3-02 mission lifecycle, M3-03 result collection, M3-04 review rule ✅ (per dependency graph M3 → M8; M3-09 acceptance recommended so real `outcomes` exist).
- M4-01 quota windows ✅ (M4-04 budgets recommended for the roles editor).
- `FakeProvider` scenarios can run a Quick Delegate end-to-end in CI (M1-12, M2-06).
- Scratch repo `~/orchestra-scratch/` present (M1-03).

## Exit criteria (all measurable)

1. **A teammate has own defaults:** with `ORCHESTRA_HOME` pointed at a second home containing only `user.yaml`, Quick Delegate's preview picks that user's `quick` provider/model and the provenance chip reads `user.yaml:<line>`; the first user's preview is unchanged.
2. **Skill evals feed routing:** `orch skill eval clean-arch-flutter-feature --providers claude,codex` writes ≥ 2 × (number of evals) rows into `outcomes` with `skill_id` set, the Skills screen shows per-provider health, and the next routing decision for `feature-impl` on a Flutter repo lists "local evidence" in its reasons.
3. **Scorecards from your outcomes:** Models › Scorecard shows ≥ 3 `(model, taskType)` cells with sample size, findings/100 LOC, test pass rate, rework rounds, latency and cost; every local adjustment is within ±0.2 and decays with the configured half-life.
4. Invalid YAML in any layer never changes effective settings: the last-known-good tree stays active, the UI shows the error with file + line, running sessions are unaffected.
5. `orch settings explain routing.overrides` prints the effective value and the layer/file/line it came from for any key.
6. Starter packs (7) install into Claude Code and Codex worktrees at task start via `SkillsInstaller`; untrusted skills are refused with a visible reason.
7. Playbook edits are validated (schema + DAG semantics) and test-runnable with `FakeProvider` without spending quota.
8. Composed CLAUDE.md / AGENTS.md fragments are present in every new worktree and never appear in a `TaskResult` diff.
9. Every auto-answered prompt has a `prompt.auto_answered` event and an `audit.*` row naming the rule.
10. All 8 steps ✅, all TC tables recorded, CI green using `FakeProvider` only (C9), no new ESLint / dependency-cruiser violations.

## Steps

| ID | Step | Title | Effort | Depends on |
|---|---|---|---|---|
| M8-01 | [step-01-layered-settings-engine.md](step-01-layered-settings-engine.md) | Layered settings engine | 2.5 d | M2-09 |
| M8-02 | [step-02-policy-roles-task-type-editors.md](step-02-policy-roles-task-type-editors.md) | Policy, roles, task-type editors | 3 d | M8-01 |
| M8-03 | [step-03-prompt-library.md](step-03-prompt-library.md) | Prompt library | 1.5 d | M8-01 |
| M8-04 | [step-04-skills-system.md](step-04-skills-system.md) | Skills system | 3 d | M8-01, M2-03 |
| M8-05 | [step-05-skill-evals.md](step-05-skill-evals.md) | Skill evals | 2 d | M8-04 |
| M8-06 | [step-06-model-scorecard-and-learning-loop.md](step-06-model-scorecard-and-learning-loop.md) | Model Scorecard & learning loop | 2.5 d | M3-04, M4-01 |
| M8-07 | [step-07-playbook-editor.md](step-07-playbook-editor.md) | Playbook editor | 1.5 d | M3-01, M8-01 |
| M8-08 | [step-08-instruction-fragments-auto-answer-and-notifications-editors.md](step-08-instruction-fragments-auto-answer-and-notifications-editors.md) | Instruction fragments, auto-answer & notifications editors | 2 d | M8-01 |

## What you can test after this milestone

- Edit `~/.orchestra/user.yaml`, watch the Settings screen update in < 1 s, and see the provenance of every key.
- Change a routing rule in the form editor and watch the "what runs where" panel re-run the assignment engine over sample tasks as you type.
- Insert a prompt template with variables from Chat's `/` palette and from Quick Delegate.
- Import a skill folder, see it refused as *untrusted*, mark it reviewed, install it into a Claude Code worktree, and see it in the Lead's `capabilities()`.
- Run `orch skill eval` on a starter pack across two real providers, then see the Skills health badge and the Scorecard update.
- Open a playbook, introduce a cycle, get a validation error with the offending step, fix it, and test-run it on `FakeProvider`.
- Watch an `rm -rf` permission prompt get auto-denied and logged; watch a read-only tool prompt get auto-approved; receive a webhook for a mission completion.

## Demo script

1. `orch settings explain routing.overrides` → shows `defaults` provenance. Add an override in `<repo>/.orchestra/workspace.yaml`; re-run → `workspace.yaml:<line>`.
2. Break `user.yaml` (unterminated string). Settings screen shows a red banner with file:line; `orch settings explain` still returns the last-good value; a running FakeProvider session keeps running.
3. Open Settings › Policies. In the form, set `boilerplate` primary to `agy/gemini-flash`. The "what runs where" panel re-scores 12 sample tasks live; the YAML pane updates; save; the decision log records the change.
4. Open Settings › Roles; give `reviewer` a budget cap; the panel shows which sample tasks would be blocked.
5. In Chat, type `/prompt adr-skeleton`, fill `{{title}}`, insert; in Quick Delegate pick the same template for a `adr-writing` task.
6. Skills screen: import `~/orchestra-scratch/skills/bad-skill` → badge *untrusted*, Install disabled. Open it, mark reviewed, install to Claude Code (project scope) → preview lists files to be written under `.claude/skills/` → confirm.
7. Start a Quick Delegate `feature-impl` on the Flutter scratch repo → the task's skills list shows `clean-arch-flutter-feature` auto-attached; the Lead's `capabilities()` (Missions › Lead session) lists it.
8. `orch skill eval clean-arch-flutter-feature --providers claude,codex` → preview of quota impact → confirm → two scratch worktrees run → results table (tests, findings, latency, cost) → `outcomes` rows → Skills health badge green/amber.
9. Models › Scorecard: pick `feature-impl`; compare local evidence vs community baseline; open the adjustment history; run `orch outcomes export --anonymised` and inspect the bundle.
10. Settings › Playbooks: duplicate `new-feature-fullstack`, add a step that requires `flyway-migration` skill and a `human` gate; validation passes; test-run on FakeProvider stops at the gate; diff vs shipped shows the added step.
11. Settings › Instructions: add a workspace fragment "Always run `flutter analyze` before finishing"; start a session; `cat .orchestra/worktrees/<task>/CLAUDE.md` shows the managed block; finish the task; the TaskResult diff does not contain CLAUDE.md.
12. Settings › Auto-answer: FakeProvider scenario `prompts-mixed` fires a read-only permission (auto-allowed), an `rm -rf` (auto-denied), and an infra command (escalated to Attention with admin priority); History shows three `prompt.auto_answered` / `audit` rows. Configure a webhook channel, send test → HMAC-signed payload received.

## Milestone risks

| Risk | Impact | Mitigation |
|---|---|---|
| Vendor skill / instruction file locations change (`.claude/skills`, `.agents/skills`, `AGENTS.md`) | installers write to the wrong place; agents ignore skills | locations come from `manifest.paths` only, verified at step start; Doctor drift case (M6-02) when a manifest range mismatches; fallback to instruction fragment |
| Skill evals burn real quota | window exhaustion during a demo | preview + confirmation (C10), `skills.evals.maxCostTier`, cooling respected (C5), CI uses FakeProvider only (C9) |
| Learning loop overfits on few samples | routing flips on noise | `minSamples` (5), ±0.2 hard cap in core, decay half-life, reset button, never touches constraints |
| Layer conflicts confuse users | "why did my model change?" | provenance on every key, `orch settings explain`, diff view, `!override` / `!append` explicit |
| Instruction file composition leaks into diffs / commits | noisy PRs, secrets in repo | managed block reverted before result collection; local-file variant when the provider supports it; test IT-M8-08-03 |
| Supply-chain: malicious skill content (2026 npm worms target `.claude/`) | agents execute hostile instructions | trust levels; checksum pinning; untrusted never installed; imported skills default untrusted |

## Parallelization notes

- **M8-01 is the gate.** Nothing else in M8 should merge before its `SettingsResolver` and section registry exist.
- After M8-01: **M8-02, M8-03, M8-04, M8-07, M8-08** are independent lanes (five engineers or five sequential AI-agent runs). They touch different settings sections and different screens; conflicts are limited to the Settings nav and the section registry.
- **M8-06** depends only on M3-04 and M4-01 and can start on day 1 in parallel with M8-01; it registers its `learning` settings section once M8-01 lands.
- **M8-05** waits for M8-04 (artifact format, installer) and benefits from M8-06's `RecordOutcome` use case; if M8-06 is late, M8-05 writes `outcomes` rows directly through the repository and M8-06 adopts them.
- Critical path: M8-01 (2.5) → M8-04 (3) → M8-05 (2) = 7.5 d; with three lanes the milestone fits in ~8–9 working days.
