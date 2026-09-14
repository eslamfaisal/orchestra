---
description: Review a step's branch against its step file with the Fable reviewer. Usage: /review-step M1-03 [branch-or-range]
---
Delegate to `orchestra-reviewer`: step **$ARGUMENTS** — resolve the step file from `plan/AGENT_ROUTING.md`, use the given branch/range or the current branch vs `main`. Return the reviewer's findings verbatim (severity-ordered) and its verdict, then tell me which findings you would send back to the implementer and to which agent (tier from the routing table; architect if the finding is a design flaw).
