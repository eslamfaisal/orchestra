# 02 — Architectural decisions (D1–D14)

These are the load-bearing decisions. Changing one requires an ADR (see `../DECISIONS.md`).

| # | Decision | Why | Enforced by |
|---|---|---|---|
| D1 | **Headless daemon + web UI, wrapped in a Tauri 2 macOS app; PWA for phone/tablet.** | Daemon runs where the CLIs run. One UI codebase, three surfaces. | M0-04, M0-07, M7-01, M7-03 |
| D2 | **tmux + git worktrees are the session substrate.** Each agent = interactive PTY in tmux, in its own worktree/branch per task. Daemon drives tmux control mode. | Sessions survive UI/daemon crashes; attachable from any terminal; agents never trample each other's files. | M1-01, M1-03 |
| D3 | **Two-tier orchestration: deterministic Policy/Assignment Engine (daemon) + LLM Lead.** Lead decomposes into typed tasks; engine assigns provider/model. | Quota, capability fit, cost and failover are testable rules, not LLM guesses. | M2-04, M3-02 |
| D4 | **Structured state from official channels only** (hooks, `--json` streams, app-server RPC, session logs, OTel, `/usage`, 429 + reset). Never screen-scraping, never private endpoints, never token proxying, never account rotation. | Survives CLI updates; stays inside every vendor's ToS. Antigravity ToS §6 forbids third-party access to the *Service* — we only launch the user's own official binary. | ESLint rules + egress tests (M0-08), `07-compliance-rules.md` |
| D5 | **Every provider is a plugin** (`ProviderAdapter` + versioned Capability Manifest). Core knows no vendor. | Adding Kimi/DeepSeek/next thing = one package. | M0-03 (SDK), M1-05..07 |
| D6 | **The platform maintains itself.** Manifests, model catalog, plugins and app update independently; Doctor detects drift in seconds; Repair Agent proposes fixes under guardrails. | Vendors ship weekly; glue that breaks every release is useless. | M6, M10-01 |
| D7 | **Intelligence layer is data, not code:** task taxonomy, model profiles, skills, playbooks are versioned artifacts learned from your own outcomes. | "Which model for which job" changes monthly; must update without a release. | M2-01..03, M8-04..06 |
| D8 | **Local-first (SQLite) → team mode (Postgres + S3).** | Solo ships today; enterprise is a driver swap. | M0-04 (Kysely), M9-05 |
| D9 | **Node 22 LTS + NestJS daemon, React 19 web, Tauri 2 desktop, TypeScript everywhere, Clean Architecture per package.** | Enterprise DI/guards/audit out of the box; one language across daemon, UI, plugins, SDK. | M0-01, dependency-cruiser |
| D10 | **License: Apache-2.0 for SDK/protocol/plugins; core license decided by ADR-001 before first external PR.** DCO, not CLA. | Ecosystem needs permissive edges; a future hosted offering may need a protective core. | ADR-001, M10-07 |
| D11 | **MVP = M0 + M1.** Substrate + live fleet + prompts from web + Quick Delegate (manual provider pick). Nothing in M2+ rewrites M0/M1 interfaces; they extend them. | Prove the riskiest parts first (tmux control mode, adapters, prompt round-trips) on real CLIs before investing in intelligence. | `../ROADMAP.md` |
| D12 | **Node version floor.** Dev machine has Node 26; plan targets **22 LTS** (node-pty 1.1.0 prebuilt, NestJS matrix). `.nvmrc` + `engines` pin 22; CI matrix 22 + 24. Raise floor only via ADR-003. | Avoid native-module surprises in the daemon; keep Tauri sidecar build reproducible. | M0-01 |
| D13 | **One `SessionSupervisor` actor per host owns all tmux/PTY state.** All mutations are messages to it; no other module talks to tmux. | Serialises control-mode I/O; makes crash recovery a single re-attach; testable with a fake tmux. | M1-02 |
| D14 | **Every agent stop-and-ask becomes a durable `AgentPrompt`** with a typed `answerTransport`. UI never sends raw keystrokes to answer a prompt unless the transport says `send-keys-acked`. | Prompts must survive restarts and be answerable from any device via official channels. | M1-11 |

## Decision → milestone map
- Substrate (D2, D13): M1
- Compliance (D4): every milestone; hard gates in M0-08 and M1-04
- Plugins (D5): SDK in M0-03, first real adapters M1-05..07, third-party proof M10
- Intelligence (D3, D7): M2, M3, M8
- Self-maintenance (D6): M6, M10
- Storage (D8): SQLite from M0-04, Postgres/S3 in M9-05
- Surfaces (D1): web from M0-07, Tauri/PWA in M7
