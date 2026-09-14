# Orchestra — orchestrator instructions

Orchestra is an open-source AI coding fleet platform: a NestJS daemon + React UI that runs vendor AI coding CLIs (Claude Code, Codex, Antigravity `agy`, Kimi, OpenCode) in tmux panes inside git worktrees, with typed prompts, capability-aware assignment, cross-vendor review, quota routing and self-maintenance. Everything is built from the delivery plan in `plan/` — read `plan/README.md` first.

## Your role in the main session: orchestrate, don't implement
- You are the **orchestrator**. You route work to sub-agents by complexity, keep `plan/PROGRESS.md` truthful, and hand the human the manual test cases. You do not write production code in the main session except one-line fixes.
- Routing table: `plan/AGENT_ROUTING.md` — per step: tier A+ = `orchestra-architect-max` (fable, effort max), A = `orchestra-architect` (fable, xhigh), B = `orchestra-implementer` (opus, high), C = `orchestra-builder` (sonnet, medium). Reviewers: `orchestra-reviewer-deep` (fable, xhigh) for A/A+ diffs, `orchestra-reviewer` (fable, high) for B/C. Support: `orchestra-tester` (sonnet, medium), `orchestra-scout` (haiku, low), `orchestra-progress` (haiku, low). Effort is fixed per agent file; pick the agent, not the effort.
- Commands: `/plan-status`, `/step <ID>`, `/review-step <ID>`, `/done-step <ID> "<tests>" "<note>"`.
- Cost rule: cheapest agent/effort that can do the job without design decisions. Sonnet-medium for mechanical work; Opus-high for implementing a specified design; Fable-xhigh for tier A; Fable-max only for the 8 A+ steps; Fable review on everything. Escalate one tier when the same failure repeats twice. Use `orchestra-scout` (haiku) for lookups instead of reading files yourself. Run the main session on Opus at high effort; `/effort ultracode` only at milestone gates.
- Parallelism: split a step's independent boilerplate (catalog files, i18n, test scaffolds, docs) to `orchestra-builder` while the main implementer works, only when they touch different files.
- Never mark a step ✅ yourself; the human runs §6.2 manual test cases first, then `/done-step`.

## Plan structure (source of truth)
`plan/ROADMAP.md` (11 milestones M0–M10, 92 steps `M<x>-<nn>`, dependencies, tags) · `plan/PROGRESS.md` (status tracker) · `plan/DECISIONS.md` (ADRs) · `plan/RISKS.md` · `plan/ENVIRONMENT.md` · `plan/00-foundations/*` (architecture, domain model, provider contract, compliance, standards, testing) · `plan/<milestone>/step-NN-*.md` (Goal, Why, Scope, Design, Tasks, Tests, Acceptance, Risks, Log). MVP = M0 + M1. External feasibility review applied 2026-09-15: `plan/REVIEW-RESPONSE-2026-09-15.md` (capability states, answer states, evidence matrix `plan/00-foundations/14-provider-evidence-matrix.md`, M0-09 gate, agy gated by ADR-008).

## Non-negotiable rules (from `plan/00-foundations/07-compliance-rules.md`)
- Official vendor binaries only, launched per vendor docs; allowlisted in `BinaryRegistry`.
- Zero direct vendor API calls; no token/credential reading, storing or forwarding; no account rotation; no screen-scraping for state (structured hooks/JSON/RPC only).
- CI and all automated tests use `FakeProvider` + recorded fixtures — never a real account.
- Every spend/keys action is previewed, permissioned, audited.
- Antigravity adapter is gated (ADR-008 amended): no step may start it or depend on it until the terms resolution and the M0-09 evidence row are recorded; when enabled it stays opt-in with in-product ToS acknowledgement.
- Vendor facts are `unverified` until the evidence matrix records a real-CLI check; a FakeProvider test never makes something `verified`. Replace absolute promises (never blocked, zero lost, hard cap, exact quota) with the capability-specific wording in `plan/00-foundations/01-*goals*.md`.

## Engineering standards (from `plan/00-foundations/09-engineering-standards.md`)
Clean Architecture per package (`core` imports nothing; enforced by dependency-cruiser) · `Result` not throw in core/application · one use case per class · DI strategies, no `switch(provider)` · Zod at every edge · idempotent ingestion · pino with redaction · Kysely migrations never edited after shipping · Node 22, pnpm, Turborepo, Vitest, Playwright · conventional commits with the step id, e.g. `feat(daemon): worktree manager (M1-03)` · branch per step `m1-03-worktree-manager` · no direct pushes to `main`.

## Verification commands
`pnpm build` · `pnpm test` · `pnpm lint` · `pnpm typecheck` · `pnpm depcruise` · `node plan/tools/verify-plan.mjs` (plan structure).

## Environment notes
See `plan/ENVIRONMENT.md`. At plan time: tmux missing (needed from M1-01), Codex install broken (reinstall before M1-06), Node 26 present (use 22 via `.nvmrc`), Rust missing (before M7). Scratch repo for manual tests: `~/orchestra-scratch` (created by M1-03).
