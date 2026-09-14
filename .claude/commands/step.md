---
description: Orchestrate one plan step end to end (route → implement → test → review → bookkeeping). Usage: /step M1-03
---
Orchestrate plan step **$ARGUMENTS** of Orchestra. You are the orchestrator: you do not write production code yourself; you delegate to the sub-agents and keep the bookkeeping honest.

1. **Locate & route.** Find the row for $ARGUMENTS in `plan/AGENT_ROUTING.md` (tier + agent) and the step file path. Read the step file header: confirm every "Depends on" step is ✅ in `plan/PROGRESS.md`; if not, stop and tell me which are missing.
2. **Mark started.** Delegate to `orchestra-progress`: set $ARGUMENTS to 🟨 with today's date.
3. **Implement.** Delegate to the routed agent (`orchestra-architect-max` for tier A+, `orchestra-architect` for tier A, `orchestra-implementer` for tier B, `orchestra-builder` for tier C — the routing row names it with its effort) with: the step file path, the branch name `<step-id-lowercase>-<slug>` (create it from `main` first), and the instruction to work through §5 Tasks in order with one commit per task. If the step is tier B/C and lists sub-tasks that are pure boilerplate (catalog YAML, i18n strings, test scaffolds, docs), split those out to `orchestra-builder` in parallel when they touch different files.
4. **Tests.** Delegate to `orchestra-tester` with the step file: fill any missing §6.1 tests and run the suite. If it reports a production bug, send it back to the implementing agent with the failing test id. Escalate to `orchestra-architect` if the same failure comes back twice.
5. **Review.** Delegate to the reviewer named in the routing row (`orchestra-reviewer-deep` for A/A+, `orchestra-reviewer` for B/C) with the step file and the branch diff range. On `REQUEST CHANGES`, send blockers/majors back to the implementing agent, then re-review. Loop at most twice; after that, report to me.
6. **Handoff.** Delegate to `orchestra-progress`: set $ARGUMENTS to 🧪, tick completed tasks, add a §9 log line summarising what shipped and any design deviations. Then give me: the branch name, the reviewer's verdict, and the exact list of §6.2 manual test cases I must run (with preconditions). Stop there — only I mark a step ✅ after running the manual TCs.

Constraints: never touch a real vendor account in automated runs; never let a sub-agent edit `PROGRESS.md` except `orchestra-progress`; keep every sub-agent inside the step's "Packages touched".
