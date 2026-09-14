# 01 — Vision, goals, scope

## Problem
Developers pay for several AI coding subscriptions (Claude Code, Codex, Antigravity, Kimi, API-backed models). Each has its own CLI, models, strengths, quota windows and no awareness of the others. Consequences:

- The strongest model burns quota on boilerplate while cheaper quota idles.
- Reviews are done by the same model that wrote the code.
- Work is scattered across terminals with no shared plan, board, or history.
- One exhausted quota window stops everything.
- Every vendor CLI release silently breaks hand-written glue.

## Product statement
**One open-source platform for every AI coding CLI you pay for** — task decomposition, capability-aware assignment, cross-vendor review, quota-aware routing, self-healing against vendor changes, full history/replay, and access from any device — while staying 100 % inside each vendor's official surfaces and terms.

## Goals (referenced as G1–G7 throughout the plan)

| ID | Goal | Measurable target |
|---|---|---|
| G1 | **See, control and talk to every agent** in one place, on any device | live terminal + chat for 100 % of sessions; phone approve/answer |
| G2 | **Right model for the job, every time** | ≥ 60 % of tasks routed off the top-tier model; ≥ 80 % of each paid window used productively |
| G3 | **Better output through diversity** | cross-vendor review on 100 % of mission tasks |
| G4 | **Never blocked** | quota forecasting + pre-emptive reroute; Lead handoff on exhaustion |
| G5 | **Total recall** | every session, plan, task, diff, review, prompt, decision recorded, searchable, replayable |
| G6 | **Self-maintaining** | drift detected < 60 s; safe remediation < 10 s; vendor changes surfaced as actionable items |
| G7 | **Extensible and open** | providers, skills, playbooks, policies, model profiles as versioned artifacts; ≥ 1 third-party plugin without a core PR |

## Non-goals (v1)
- Replacing vendor CLIs or calling model APIs behind them.
- Sharing one subscription across tools; multi-account rotation; quota tricks.
- Exact remaining-quota readouts where vendors don't expose them (we forecast, label confidence).
- Hosted SaaS, billing, marketplace payments.

## Personas

| Persona | Needs | Primary milestones |
|---|---|---|
| **Solo principal engineer** (you, first user) | describe a feature once → planned, split, assigned, cross-reviewed, PR'd; delegate chores to cheapest capable model; phone notifications; replay; nothing breaks on CLI updates | M0–M7 |
| **Team lead** | policies, budgets, approval gates, audit, RBAC | M8–M9 |
| **Team member** | own presets/skills/default models; limited permissions | M8–M9 |
| **Plugin author** | implement one interface + manifest, publish, contract-tested | M10 |

## User stories (MVP subset marked ★)
- ★ As an engineer I open one browser tab and see all my running agents as live terminals with provider · model · task · worktree · status headers.
- ★ When an agent asks for permission or a decision, I get it in an Attention queue and answer from the web, and the agent continues.
- ★ I can start a session for any installed provider, choose the model, and it runs in its own git worktree.
- ★ I can hand one task to one agent ("Quick Delegate") and get back a branch + diff + summary.
- Describe a feature once → Lead plans, splits into typed tasks, engine assigns providers, each task implemented in its own worktree, cross-vendor reviewed, tests run, PR opened.
- When a provider hits 429 / window exhaustion, work reroutes and I am told.
- I can replay what any agent did last Tuesday, with the chat, events and diff linked to the terminal recording.
- When a CLI updates, Orchestra detects drift, repairs what it safely can, and shows me the rest.
- On my phone I approve/deny prompts and read chat.
- A teammate has their own defaults and permissions; every spend/keys action is audited.

## Product KPIs (tracked from M4 onward in the Fleet screen)
- Off-top-tier routing % · window utilisation % · cross-review coverage % · reroute success rate · time-to-detect drift · remediation time · restore-without-lost-prompt rate.
