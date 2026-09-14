# 10 — Testing strategy

## Levels

| Level | What | Tooling | Rule |
|---|---|---|---|
| Unit | core: assignment, quota forecaster, drift classifier, remediation ladder, prompt classifier, state machines | Vitest | **100 % branch coverage** on these modules |
| Application | use cases with in-memory repos + `FakeProvider` | Vitest | suite < 1 s |
| Adapter contract | every adapter vs recorded fixtures per CLI version | Vitest + SDK harness | CI matrix per provider; fixture drift = failing test |
| Parser fuzz / property | tmux control-mode parser, stream-json parsers, hook payload parsers | fast-check | no throw on any input; only `Result.err` |
| Integration | tmux + worktrees + SQLite + recorder + hooks receiver | Vitest + real tmux in CI (Linux) + Testcontainers (Postgres) | |
| Architecture | layer rules, no vendor HTTP, allowlisted binaries | dependency-cruiser + ESLint custom rules | fails build |
| E2E | web + daemon + `FakeProvider` | Playwright | CI never touches real accounts |
| Load | 50 panes, 10k events/min, 10k-line scrollback at 60 fps | k6 + custom harness | nightly from M5 |
| Skill evals | skills vs fixture tasks across providers | `orch skill eval` | M8-05 |
| Manual (you) | each step's TC table on real CLIs | checklist in step file | required before ✅ |

## `FakeProvider` (`packages/sdk/src/fake/`)
A full adapter that runs a scripted "agent": a tiny Node script launched in tmux that prints output, emits hook-style POSTs, asks prompts of every kind, simulates 429 with `resetAt`, switches models, and exits with chosen codes. Scripts are YAML scenarios (`fixtures/scenarios/*.yaml`). Used by application tests, E2E, load tests and demos. It must exercise every `AnswerTransport`.

## Fixture recording protocol (real CLIs, done by you, never in CI)
1. `orch fixtures record <provider>` (M1-08) runs a scripted session in a scratch repo, capturing hook bodies, stream lines, RPC messages, exit codes.
2. Redaction pass (secret regexes + manual review) → `fixtures/<cliVersion>/`.
3. `RECORDED.md` updated with CLI version, date, scenario.
4. Contract tests run; commit fixtures with the adapter change.

## CI gates (M0-08)
`tsc --strict` · ESLint (no `any`, custom rules) · Prettier · dependency-cruiser · unit/application/contract tests · coverage thresholds (core 100 % branches on listed modules, others ≥ 80 %) · Playwright E2E with FakeProvider · conventional commits · OpenSSF Scorecard · `pnpm audit` · SBOM generation.

## Manual test protocol (per step)
- Preconditions listed in the TC table (which CLIs logged in, tmux running, scratch repo path).
- Use the scratch repo `~/orchestra-scratch/` (created in M1-03) — never a real project until M3 acceptance.
- Record result + build hash + date in the TC Status column; screenshots go in `plan/<milestone>/evidence/`.

## Feasibility contract reconciliation (2026-09-15)
Provider capabilities are keyed by exact CLI version and execution mode; foundation 14 and M0-09 define the release gate. Mandatory unsupported capabilities block that mode; optional unsupported capabilities disable only the feature. Task success follows declared deliverables (M3-03), independent review uses model publisher identity (M3-04), and merge validation binds the exact candidate commit (M3-05). Recovery means durable captured records with explicit outcomes (M5-05), not universal capture or exactly-once effects. Budgets are admission limits (ADR-021). Learning defaults to shadow proposals (M8-06). Enterprise v1 is trusted shared-team execution (ADR-019); plugin provenance alone never authorizes untrusted execution (ADR-014). These revised contracts govern implementation; the source-plan-v0.2 snapshot is historical.
