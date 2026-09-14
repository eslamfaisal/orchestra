# Orchestra — Delivery Plan

> Working name "Orchestra" (see DECISIONS.md, ADR-002 name clearance).
> Source plan: `00-foundations/00-source-plan-v0.2.md` (product/architecture v0.2, 2026-09-14).

This folder is the single source of truth for **how** Orchestra gets built, in what order, and how each piece is verified before the next one starts. It turns the product plan into an ordered, testable, trackable sequence of steps from an MVP to an enterprise-grade open-source platform.

## How this plan is organised

```
plan/
  README.md            ← you are here: conventions + workflow
  PROGRESS.md          ← master tracker: every step, status, dates, test results
  ROADMAP.md           ← milestones, step index, dependency graph, timeline
  DECISIONS.md         ← ADR index + decisions still open
  RISKS.md             ← risk register (owner, trigger, mitigation)
  ENVIRONMENT.md       ← snapshot of the dev machine + required tools
  templates/           ← STEP / TEST CASE / ADR templates
  00-foundations/      ← stable reference docs (vision, architecture, domain, contracts, standards)
  01-m0-foundation/    ← Milestone 0  — repo, core, daemon skeleton, web shell, CI    (MVP part 1)
  02-m1-mvp-live-fleet/← Milestone 1  — tmux, worktrees, real adapters, terminals, prompts (MVP part 2)
  03-m2-…             ← Milestone 2  — delegation + intelligence
  04-m3-…             ← Milestone 3  — missions, review & merge
  05-m4-…             ← Milestone 4  — quota, budgets, resilience
  06-m5-…             ← Milestone 5  — history, recording, replay, restore
  07-m6-…             ← Milestone 6  — self-maintenance (doctor, drift, remediation)
  08-m7-…             ← Milestone 7  — everywhere (Tauri, PWA, multi-host, CLI)
  09-m8-…             ← Milestone 8  — customization + skills + learning loop
  10-m9-…             ← Milestone 9  — enterprise (RBAC, OIDC, audit, Postgres, Helm)
  11-m10-…            ← Milestone 10 — ecosystem, repair agent, registry, 1.0 launch
```

Each milestone folder has a `README.md` (goal, exit criteria, step list, demo script) and one file per step: `step-NN-<slug>.md`.

## Step IDs

`M<milestone>-<step>` — e.g. `M1-03` = Milestone 1, step 3. Test cases are `TC-M1-03-01`. ADRs are `ADR-NNN`. Use these IDs in commits, branches (`m1-03-worktree-manager`), PR titles and progress notes.

## The MVP

**MVP = M0 + M1.** Exit: two real vendor CLIs (Claude Code + one of Codex/Antigravity) running live in tmux panes inside per-task git worktrees, visible and controllable from the browser, with every agent prompt (permission / question / plan) surfaced in an Attention queue and answerable from the web, plus "Quick Delegate" of a single task to a manually chosen provider. Everything after M1 is layered on top without rewriting the substrate.

## Workflow loop (per step)

1. Open the step file. Read **Goal**, **Scope**, **Design**.
2. Set status in `PROGRESS.md` to 🟨 and record the start date.
3. Work the **Tasks** checklist (tick boxes in the step file as you go).
4. Run **Automated tests** (must be green) then walk the **Manual test cases** table and fill in the Status column (✅ / ❌ + note).
5. Confirm every line of **Acceptance criteria**.
6. Set status to 🧪 while you are testing, then ✅ when all acceptance criteria hold. Record the done date and a one-line note in `PROGRESS.md`.
7. Anything discovered but out of scope → add to the step's **Notes & progress log** and, if it needs its own step, add it to `ROADMAP.md` + `PROGRESS.md` (never silently expand a step).
8. If blocked → status ⛔, add a row to **Blockers** in `PROGRESS.md` with what unblocks it.

A step is **never** marked ✅ with a failing manual test case. If a test case is invalid, edit the case and say why in the log.

## Status legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🟨 | In progress |
| 🧪 | Implemented, in test |
| ✅ | Done — all acceptance criteria met, tests pass |
| ⛔ | Blocked |
| ⏸ | Deferred (moved to a later milestone) |

## Rules that never change (see `00-foundations/07-compliance-rules.md`)

- Only official vendor binaries, launched the way vendor docs say. No vendor API calls, no token proxying, no account rotation, no screen-scraping for state.
- `packages/core` imports nothing from infrastructure. `dependency-cruiser` enforces it from M0-01 onward.
- CI never touches a real vendor account. `FakeProvider` + recorded fixtures only.
- Every step ships with tests. Every adapter ships with fixtures pinned to a CLI version.

## Editing conventions

- Keep the step template structure; add sections, do not remove them.
- Dates are ISO (`2026-09-14`). Effort is in working days for one engineer using AI agents.
- When the design changes materially, write an ADR (`templates/ADR_TEMPLATE.md`) and link it from `DECISIONS.md` and the affected step.

## Executing a step with AI agents (orchestrated)

The repo root has `CLAUDE.md` + `.claude/agents/*` + `.claude/commands/*`: the main Claude Code session orchestrates and delegates each step to the agent chosen in [AGENT_ROUTING.md](AGENT_ROUTING.md) (fable / opus / sonnet / haiku by complexity). Run `/plan-status`, then `/step M0-01`, run the manual TCs it hands you, then `/done-step M0-01 "n/n TC ✅"`.

## Executing a step with a single agent (manual)

Each step file is written so an agent (Claude Code, Codex, …) can implement it with minimal extra context. Suggested prompt when starting a step in the repo root:

```text
Read plan/README.md, plan/00-foundations/09-engineering-standards.md and plan/<milestone>/<step-file>.md.
Implement section 5 (Tasks) in order, one commit per task, following section 4 (Design) exactly.
Add the automated tests from section 6.1. Do not touch files outside "Packages touched" without asking.
Stop when all tasks are done and tests pass; report which manual test cases (6.2) I should run.
```

Then you run the manual TCs yourself, record results in the step file and `PROGRESS.md`, and only then mark the step ✅. Keep the agent inside one step at a time; anything it discovers outside scope goes into the step's progress log, not into code.

## Verification of this plan
`node plan/tools/verify-plan.mjs` (see `plan/tools/`) checks that every step listed in `ROADMAP.md` has a file, that each step file has the nine template sections, a status line, at least five manual test cases, and no leftover template placeholders.
