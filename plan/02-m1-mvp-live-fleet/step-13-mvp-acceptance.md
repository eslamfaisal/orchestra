# Step M1-13 — MVP acceptance

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-01, M1-02, M1-03, M1-04, M1-05, M1-06, M1-08, M1-09, M1-10, M1-11, M1-12 |
| Estimated effort | 2 days |
| Packages touched | `plan/02-m1-mvp-live-fleet/evidence/`, repo tag, `PROGRESS.md`, `ENVIRONMENT.md` |
| Risk | Low (gate) |
| Owner | |

## 1. Goal
A deliberate, recorded acceptance pass on real CLIs that proves the MVP definition (D11) end to end, captures evidence (screenshots, perf numbers, fixture versions), fixes anything that blocks the demo script, and tags `mvp-1`. Nothing new is built here except small fixes; anything larger becomes a tracked item in `ROADMAP.md`/`PROGRESS.md`.

## 2. Why
D11 (MVP gate before intelligence), R10 (scope discipline), `README.md` workflow ("never ✅ with a failing TC").

## 3. Scope
### In scope
- Run the M1 README demo script start to finish; run every TC of M1-01…M1-12 that was skipped or ❌; re-run the contract suites against the installed CLI versions; run perf harness; run restart smoke; run egress test locally with real adapters.
- Evidence folder: `evidence/mvp-1/` with screenshots per demo step, `perf.md`, `fixtures.md` (CLI versions + fixture versions), `tc-summary.md`.
- Bug-fix budget: ≤ 1 day; larger issues → new steps.
- Update `ENVIRONMENT.md`, `RISKS.md` (retire/adjust R2, R3, R5 with evidence), `DECISIONS.md` (ADR-009 confirmed, bridge decision noted), `PROGRESS.md` (milestone M1 ✅, MVP reached).
- Tag `mvp-1`; write `docs/mvp-1-notes.md` (what works, known gaps, how to run).
### Out of scope
- Any M2+ feature.

## 4. Design
### 4.1 Domain
n/a
### 4.2 Interfaces / contracts
Acceptance matrix (rows = capability, columns = provider):

| Capability | Claude | Codex | agy (opt-in) | Fake (CI) |
|---|---|---|---|---|
| Start interactive in worktree | TC-M1-10-02 | TC-M1-06-04 | TC-M1-07-02 | E2E-M1-10-04 |
| Live terminal + typing + resize | TC-M1-09-01..03 | same | same | E2E-M1-09-05/06 |
| Permission prompt round-trip | TC-M1-11-01/02 | TC-M1-11-03 | TC-M1-07-02 | E2E-M1-11-06 |
| Fallback keystrokes | TC-M1-11-05 | TC-M1-11-05 | TC-M1-07-03 | IT-M0-03-06 |
| Plan approval | TC-M1-11-04 | n/a (verify) | n/a | E2E-M1-11-06 |
| Model switch | TC-M1-05-05 | TC-M1-06 (RPC) | keys | fake |
| Headless task → result | TC-M1-12-01 (Codex) / TC-M1-05-06 | TC-M1-12-01 | TC-M1-12-03 | E2E-M1-12-06 |
| Restart: sessions adopted, prompt survives | TC-M1-02-02, TC-M1-11-09 | TC-M1-06-07 | — | IT-M1-02-07, IT-M1-11-08 |
| Contract suite on pinned fixtures | CT-M1-05-01 | CT-M1-06-01 | CT-M1-07-01 | CT-M0-03-01 |
| No vendor egress | AT-M1-07-07 (all adapters) | | | IT-M0-08-04 |
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
None.
### 4.5 API / UI surface
None.
### 4.6 Flow
Demo script (README) → matrix → evidence → fixes → tag.

## 5. Tasks
- [ ] Create `evidence/mvp-1/`; capture environment (`orch dev env` output, CLI versions).
- [ ] Run demo script; screenshot each step; note deviations.
- [ ] Execute every ⬜/❌ TC in M1 step files; update Status columns.
- [ ] Run `pnpm test` (contract suites), perf harness (M1-09), egress test with real adapters.
- [ ] Restart smoke: `kill -9` with open prompts on Claude and Codex; record outcomes.
- [ ] Fix blockers (≤ 1 day); log each in the affected step's progress log.
- [ ] Write `tc-summary.md` (matrix with ✅/❌ + links), `perf.md`, `fixtures.md`.
- [ ] Update ENVIRONMENT/RISKS/DECISIONS/PROGRESS; tag `mvp-1`; `docs/mvp-1-notes.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| E2E-M1-13-01 | e2e (CI) | full FakeProvider journey: start → prompt → answer → quick task → result → restart adopt | green |
| CT-M1-13-02 | contract | all provider suites | green on pinned fixture versions |
| AT-M1-13-03 | architecture | depcruise + custom lint | 0 violations |
| E2E-M1-13-04 | perf | budgets harness | within targets |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-13-01 | Demo script | 1. run README demo steps 1–10 | every step matches expected; screenshots saved | ⬜ |
| TC-M1-13-02 | Matrix complete | 1. fill acceptance matrix | every cell ✅ or explicitly n/a with reason | ⬜ |
| TC-M1-13-03 | Fresh machine sanity | 1. clone repo on a clean user account (or `HOME` sandbox) 2. install, run daemon, start Claude session | works with only `pnpm install` + login; docs sufficient | ⬜ |
| TC-M1-13-04 | 2-hour soak | 1. keep 3 real sessions active for 2 h with periodic prompts | no crashes; memory within budget; prompts all answered | ⬜ |
| TC-M1-13-05 | Attach-anywhere | 1. `tmux -L orchestra attach` from a second terminal during soak | no interference | ⬜ |

## 7. Acceptance criteria (= MVP exit criteria in README)
- [ ] Acceptance matrix all ✅ (agy column may be n/a if opt-in deferred — recorded).
- [ ] Demo script reproducible from evidence.
- [ ] Budgets met and recorded.
- [ ] Restart smoke passes on Claude + Codex.
- [ ] Contract suites green; fixtures pinned to installed versions.
- [ ] `PROGRESS.md` M1 ✅; tag `mvp-1` pushed.

## 8. Risks / open questions
- Temptation to "just add" M2 features while here — don't; log them.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
