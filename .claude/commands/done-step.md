---
description: Mark a step ✅ after I ran its manual test cases. Usage: /done-step M1-03 "12/12 TC ✅" "optional note"
---
Parse $ARGUMENTS as: step id, tests summary (quoted), optional note (quoted). Verify with `orchestra-scout` that the step file's §6.2 table has no ⬜/❌ rows left; if any remain, refuse and list them. Otherwise delegate to `orchestra-progress`: set the step to ✅ with today's date, tests summary and note; update milestone counts; add a Change log row. If this was the last step of its milestone, also set the milestone row to ✅ and remind me of the milestone's git tag from `plan/ROADMAP.md`. Then tell me the next ⬜ step in dependency order and its routed agent.
