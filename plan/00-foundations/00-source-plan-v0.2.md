# Orchestra — AI Coding Fleet Platform
### Product, Architecture & UX Plan · v0.2 · September 14, 2026
*(v0.2 folds in the deep-research findings, the self-maintaining platform, and the model/task/skills intelligence layer. "Orchestra" is a working name — see §21.)*

> One open-source platform for every AI coding CLI you pay for — Claude Code, Codex, Antigravity (agy), Kimi Code, and any OpenAI-compatible model — with task decomposition, capability-aware assignment, cross-vendor review, quota-aware routing, self-healing against vendor changes, full history/replay, and access from any device.

---

## 0. Decisions (read first)

| # | Decision | Why |
|---|---|---|
| D1 | **Headless daemon + web UI, wrapped in a Tauri 2 macOS app; PWA for phone/tablet.** | Daemon runs where the CLIs run. One UI codebase, three surfaces. |
| D2 | **tmux + git worktrees are the session substrate.** Each agent = interactive PTY in tmux, in its own worktree/branch per task. Daemon drives tmux control mode. | Sessions survive UI crashes; attachable from any terminal; agents never trample each other's files. |
| D3 | **Two-tier orchestration: deterministic Policy/Assignment Engine (daemon) + LLM Lead.** The Lead decomposes work into typed tasks; the engine assigns provider/model. | Quota, capability fit, cost and failover are testable rules, not LLM guesses. |
| D4 | **Structured state from official channels only** (hooks, `--json` streams, app-server RPC, session logs, OTel, `/usage`, 429 + reset). Never screen-scraping, never private endpoints, never token proxying, never account rotation. | Survives CLI updates and stays inside every vendor's ToS (Antigravity's Terms explicitly ban third-party access to the *Service* — we only ever launch the user's own official binary). |
| D5 | **Every provider is a plugin** (`ProviderAdapter` + versioned **Capability Manifest**). Core knows no vendor. | Adding Kimi/DeepSeek/next thing = one package. |
| D6 | **The platform maintains itself.** Manifests, model catalog, plugins and app update independently; a Doctor detects drift in seconds; a Repair Agent proposes fixes under guardrails. | Vendors ship weekly; a fleet manager that breaks on every CLI release is useless. |
| D7 | **Intelligence layer is data, not code:** task taxonomy, model capability profiles, skills and mission playbooks are versioned artifacts, learned from your own outcomes. | "Which model for which job" changes monthly; it must be updatable without a release. |
| D8 | **Local-first (SQLite) → team mode (Postgres + S3).** | Solo ships today; enterprise is a driver swap. |
| D9 | **Node 22 + NestJS daemon, React 19 web, Tauri 2 desktop, TypeScript everywhere, Clean Architecture per package.** | Enterprise DI/guards/audit out of the box; one language across daemon, UI, plugins, SDK. |
| D10 | **License: Apache-2.0 for SDK/protocol/plugins; core license (Apache-2.0 vs AGPL-3.0) decided by ADR-001 before first external PR.** DCO, not CLA. | Ecosystem needs permissive edges; a future hosted offering may need a protective core. |

---

## 1. Problem

Developers pay for several AI coding subscriptions, each with its own CLI, models, strengths, rate windows and no awareness of the others. The strongest model burns quota on boilerplate, cheaper quota idles, reviews are done by the model that wrote the code, work is scattered across terminals with no shared plan or history, one exhausted window stops everything, and every vendor release silently breaks whatever glue you wrote last month.

## 2. Goals

1. One place to **see, control and talk to** every agent — live terminal + chat, on any device.
2. **Right model for the job, every time** — typed tasks, capability profiles, evidence-based assignment; ≥ 60 % of tasks routed off the top-tier model, ≥ 80 % of each paid window used productively.
3. **Better output through diversity** — cross-vendor review on 100 % of mission tasks.
4. **Never blocked** — quota forecasting, pre-emptive rerouting, Lead handoff.
5. **Total recall** — every session, plan, task, diff, review, prompt and decision recorded, searchable, replayable.
6. **Self-maintaining** — drift detected < 60 s, safe remediation < 10 s, vendor changes surfaced as actionable items, fixes shared through the registry.
7. **Extensible and open** — providers, skills, playbooks, policies and model profiles as versioned artifacts; global OSS project with enterprise-grade governance.

## 3. Non-goals (v1)

- Replacing vendor CLIs or calling model APIs behind them.
- Sharing one subscription across tools; multi-account rotation; quota "tricks".
- Exact remaining-quota readouts where vendors don't expose them (we forecast and label confidence).
- Hosted SaaS, billing, marketplace payments.

## 4. Personas & user stories

- **Solo principal engineer:** "Describe a feature once → planned, split, assigned, cross-reviewed, merged; I only review PRs." "Delegate this chore to the cheapest capable model." "Tell me on my phone when an agent needs me." "Replay what Codex did last Tuesday." "When Claude Code updates, nothing breaks — or it fixes itself and tells me."
- **Team lead:** policies, budgets, approval gates, audit, RBAC.
- **Team member:** own presets/skills/default models; limited permissions.
- **Plugin author:** implement one interface + manifest, publish to registry, get contract-tested.

## 5. Platform overview (what "integrated AI platform" means)

```
Agents      live panes, chat, commands, prompts/approvals, worktrees
Missions    playbooks → task DAG → assignment → implement → review → test → merge → retro
Board       kanban of tasks across agents
Models      catalog + capability profiles + scorecards (your own evidence)
Skills      library, packs, per-task auto-attach, evals
Policies    routing, budgets, approvals, sandbox profiles, prompt auto-answers
Fleet       providers, plans, windows/forecasts, health
Knowledge   PLAN/ADR/docs index per workspace (what agents read)
Automations scheduled/triggered missions, watchers
Health      doctor, drift, repairs, updates
History     search, replay, timeline, exports
```

## 6. System architecture

### 6.1 Planes
```
Surfaces: Tauri macOS app · Browser/PWA · `orch` CLI
            │ HTTPS + WS (local token / OIDC)
orchestrad (NestJS)
  A Terminal plane    tmux control-mode driver · worktree manager · PTY recorder
  B Telemetry plane   hooks receiver · JSON/JSONL stream parsers · app-server RPC client · OTLP receiver
  C Delegation plane  MCP server for Leads (capabilities/delegate/status/collect/ask_user via elicitation)
  D Intelligence      task taxonomy · model profiles · assignment engine · quota forecaster · skills resolver
  E Maintenance       doctor · drift detector · registry client · repair agent · update manager
  F Event store       append-only events · conversations · recordings (SQLite/Postgres)
  G Plugin host       ProviderAdapter · Manifest · SkillPack · Playbook · ModelCatalog loaders
            │ tmux pane per agent, one worktree per task, official binary, official login
  claude · codex · agy · kimi · opencode (DeepSeek/any OpenAI-compatible)
```

### 6.2 Components
| Component | Responsibility | Tech |
|---|---|---|
| `orchestrad` | daemon: tmux, storage, engines, MCP, HTTP/WS | Node 22, NestJS (Fastify, WS gateway), Zod |
| `web` | full UI, served by daemon, embedded in Tauri | React 19, Vite, Tailwind 4, shadcn/ui, Zustand, TanStack Query, xterm.js (WebGL addon), asciinema-player, cmdk |
| `desktop` | macOS shell: tray, notifications, deep links (`orchestra://`), signed updater | Tauri 2 |
| `core` | pure domain: entities, policies, contracts | TypeScript |
| `providers/*` | adapters + manifests | TypeScript |
| `catalog` | task taxonomy, model profiles, playbooks, skill packs (data packages) | JSON/YAML + Zod schemas |
| `cli` (`orch`) | scripting: `orch delegate`, `orch fleet`, `orch doctor`, `orch replay` | TypeScript |
| `sdk` | public types for plugin/skill/playbook authors + contract-test harness | TypeScript |

Terminal streams go over a raw WS channel, never the Tauri JSON IPC bridge.

### 6.3 Clean Architecture per package
```
core/            entities · value objects · repository interfaces · rules (PURE)
application/     use cases (StartSession, PlanMission, AssignTask, AnswerPrompt, RunDoctor, ApplyRepair …)
infrastructure/  tmux · worktrees · sqlite/postgres · recorder · otlp · registry client · adapters
interface/       http/ws controllers · mcp tools · cli commands
```
`dependency-cruiser` enforces `core` imports nothing. `Result<T, DomainError>` inside; exceptions only at the interface layer.

### 6.4 Engineering standards (OOP · SOLID · testable)
- **Aggregates:** Host, ProviderAccount, Session→Pane, Worktree, Mission→Task→TaskResult/Review, Conversation→Message, AgentPrompt, PolicySet, ModelProfile, Skill, Playbook, RepairCase.
- **Value objects:** ModelId, ProviderId, TaskType, WindowState, Budget, RoleName, WorktreeRef, CapabilityFlag.
- **Domain services:** AssignmentEngine, QuotaForecaster, ReviewRule, LeadHandoff, DriftClassifier, RemediationLadder.
- **SOLID:** one use case per class · providers/roles/drivers/remediations are DI-registered strategies (no switches in core) · every adapter passes the shared contract suite · adapter contract segregated (`AuthProbe, Launcher, TelemetryParser, RateLimitParser, PaneController, WorktreeHooks, SkillsInstaller, QuotaProbe`) · core depends on interfaces only.
- **Cross-cutting:** Zod-validated config (fail fast) · Kysely migrations (never edit shipped ones) · pino structured logs with correlation ids · OTel traces · single `SessionSupervisor` actor per host · idempotent event ingestion · RBAC guards · audit interceptor · secrets-redacting serializer.

### 6.5 Testing
| Level | What | Rule |
|---|---|---|
| Unit | core: assignment, quota, drift classifier, remediation ladder | Vitest, **100 % branch coverage** on these |
| Application | use cases with in-memory repos + `FakeProvider` | < 1 s suite |
| Adapter contract | every adapter vs **recorded fixtures** per CLI version (json lines, hook payloads, app-server messages, rate-limit errors, prompt keystroke protocol) | CI matrix; fixture drift = failing test = "vendor changed something" |
| Parser fuzz | tmux control-mode parser, stream parsers | fuzz + property tests |
| Integration | tmux + worktrees + SQLite + recorder + OTLP | Testcontainers |
| Architecture | layers, no vendor HTTP, allowlisted binaries | dependency-cruiser + custom ESLint rules |
| E2E | web + daemon + `FakeProvider` | Playwright; CI never touches real accounts |
| Load | 50 panes, 10k events/min | nightly |
| Skill evals | skills vs fixture tasks | see §12 |

CI gates: `tsc --strict`, ESLint (no `any`), Prettier, dependency-cruiser, coverage thresholds, conventional commits, semantic-release, CODEOWNERS on `core/` and `providers/`, ADR for adapter-contract/policy-schema changes.

## 7. Provider plugin contract & Capability Manifest

### 7.1 Adapter (segregated interfaces)
`AuthProbe` (plan/status only, tokens stripped) · `Launcher` (interactive argv/env; headless argv from typed spec) · `TelemetryParser` (structured lines → normalized events) · `RateLimitParser` · `PaneController` (send-keys with ack, model switch) · `WorktreeHooks` · `SkillsInstaller` · `QuotaProbe` (e.g. `agy -p "/usage"`, Codex token notifications).

### 7.2 Capability Manifest (versioned, pinned to CLI versions)
`models[]` · `limits` (maxConcurrentSessions, window kinds, maxTurns, resume/fork) · `features[]` (`subagents`, `hooks`, `mcp`, `skills`, `websearch`, `imagegen`, `vision`, `nativeReview`, `planMode`, `sandbox`, `appServer`, `streamJsonInput`, `elicitation`) · `sandboxProfiles[]` (Codex read-only/workspace-write/full; agy request-review/always-proceed; Claude permission modes) · `commands[]` (native + discovered custom, typed args, transport, effects, approval, ackEvent) · `promptProtocol` (prompt kinds + answer transport/keystrokes) · `headless` · `instructionFile`, `skillsDir`, `commandsDir` · `updateSources` (release feed URLs, docs changelog) · `fixturesVersion`.

Discovery merges workspace custom commands/skills at session start; CLI version outside range ⇒ commands marked *unverified* and Doctor opens a case.

### 7.3 Verified provider facts (Sept 2026) — adapter design inputs
| Provider | Control surface | Prompts/approvals | Quota signal | Notes |
|---|---|---|---|---|
| **Claude Code** | interactive PTY; `-p` + stream-json; Agent SDK; ~30 hooks; `--worktree`; `remote-control`; `--cloud/--teleport` | `PreToolUse` (allow/deny/ask/defer), `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`, `Elicitation*`, `Notification` (`agent_needs_input`, `agent_completed`, `permission_prompt`, `elicitation_dialog`, `quota_auto_resume_*`) | usage in stream-json + session JSONL + `/usage`; 5-h + weekly windows | in plain `-p`, automated decisions go through `PreToolUse`; Fable metered on Max |
| **Codex** | `codex exec --json --output-schema`; **`codex app-server`** JSON-RPC (threads/turns/items, approvals, model switch, token notifications); Codex SDK; `remote-control` | app-server `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval` | app-server token/usage notifications; `turn.completed` usage | **`codex mcp-server` removed** — never depend on it; app-server is experimental → pin schema fixture |
| **Antigravity `agy`** | `-p` + `--input-format stream-json --output-format stream-json` over **stdio** (official multi-turn); 5 hooks (`PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop`); MCP via config files | hook decisions; approval prompts in PTY (ack via events) | `-p "/usage"` structured, quota-free; `/credits` | **no JSON-RPC/app-server/ACP**; `remote-control` is a Google-hosted relay, not a local API; ToS §6 forbids third-party access to the Service — only launch the official binary |
| **Kimi Code** | open-source CLI; hooks; MCP; ACP; skills/plugins with trust levels | hooks/ACP | local logs | first-class adapter |
| **OpenCode** (DeepSeek/any OpenAI-compatible) | headless/JSON/MCP/hooks | hooks | local logs | one adapter covers all API-backed models; Goose as alternate |

## 8. Intelligence layer — task taxonomy, model profiles, assignment

### 8.1 Task taxonomy (software work, v1)
Each `TaskType` carries: required/preferred capabilities, quality weights (reasoning · speed · cost · context · tool-reliability · platform expertise), risk level (→ approval gate), review requirement, default budget, default skills.

| Group | Task types |
|---|---|
| Discovery | codebase-qa, research (web/docs), dependency-audit, spike |
| Design | architecture (ADR/system design), api-design, data-model, ux-spec |
| Planning | decomposition, estimation, deploy-checklist |
| Build | feature-impl (per layer: domain/data/app/presentation), boilerplate, bulk-edit/migration, ui-impl (Flutter/SwiftUI/Compose/React), refactor, dependency-upgrade, i18n |
| Quality | test-gen (unit/integration/e2e), bugfix/debug, code-review (correctness · security · performance · architecture-compliance), security-audit, perf-optimization |
| Data | schema-migration, query-optimization, data-script |
| Platform | infra (Terraform/Docker/Cloud Run/CI), release, incident/postmortem |
| Docs | readme/api-docs, adr-writing, changelog, pr-description, commit-message |
| AI | prompt-engineering, ai-integration |

### 8.2 Model capability profiles (`catalog/models`)
Per model: `dimensions` (reasoning, long-context, speed, instruction-following, tool-use reliability, code quality per language/platform, multimodal), `contextWindow`, `costTier`, `bestFor[]`, `avoidFor[]`, `evidence` (pinned benchmarks with date, community, **your own outcomes**), `validFrom/validTo`. Community-maintained package + local overrides; updated through the registry without a release (§10).

### 8.3 Assignment engine (deterministic, explainable)
`score(model, task) = capabilityFit × quotaAvailability × costEfficiency × constraints` where constraints include cross-vendor review (reviewer provider ≠ implementer), risk gates, sandbox requirements, org allowlists, protect-Lead reserve. Output = assignment + reasons + top alternatives; every decision logged. Dry-run simulates a whole mission's window impact.

**Learning loop (evidence-based routing):** per `(model, taskType)` track review findings, test pass rate, rework rounds, latency, cost → adjusts *local* profile weights; shown in **Model Scorecard**; never touches ToS/auth rules; can be exported (anonymized, opt-in) to improve the community catalog.

### 8.4 Default assignment matrix (starting point — your subscriptions; the engine and your evidence override it)
| Task type | Primary | Fallback | Reviewer |
|---|---|---|---|
| architecture / api-design / data-model | Claude Fable → Opus | agy Gemini Pro | Codex GPT-5.x |
| decomposition (Lead) | Claude Fable/Opus | agy Claude-Opus (Google plan) | — |
| feature-impl (well-specified) | Codex GPT-5.x-Codex | Claude Sonnet | Claude Opus |
| boilerplate / bulk-edit / i18n | agy Gemini Flash | Kimi | Codex |
| ui-impl | Claude Sonnet/Opus | Codex | agy Gemini Pro |
| refactor (large, cross-file) | Claude Opus | Codex | agy Gemini Pro |
| bugfix / debug | Codex GPT-5.x-Codex | Claude Opus | Claude Sonnet |
| test-gen | Codex | agy Gemini Flash | Claude Sonnet |
| code-review (default round) | *different vendor than author* | — | — |
| security-audit | Claude Opus + Codex (two-reviewer) | — | — |
| perf-optimization | Claude Opus | Codex | agy |
| infra / migrations / release | Claude Opus | Codex | Codex/Opus |
| research / codebase-qa (large context) | agy Gemini Pro (websearch, long context) | Claude Opus | — |
| docs / changelog / pr-description | agy Gemini Flash | Claude Sonnet | any |
| quick chores | agy Gemini Flash / Sonnet | Kimi | — |

### 8.5 Mission playbooks (`catalog/playbooks`)
Mission types → standard task DAG templates the Lead instantiates: `new-feature-fullstack` (research → ADR → plan → implement per layer → tests → cross-review → docs → deploy-checklist), `bugfix`, `refactor`, `dependency-upgrade`, `incident`, `release`. Playbooks are YAML, versioned, editable per workspace, and can require skills and gates per step.

## 9. Delegation, worktrees, review & merge

- **Task contract:** `TaskSpec {id, missionId, taskType, role, goal, context, acceptance[], constraints[], budget, requiredCapabilities, skills[], worktree}` → `TaskResult {branch, diffStat, summary, testsPassed, artifacts, usage, verdict}`.
- **Worktree per task:** created by the daemon (Claude native `--worktree` + `WorktreeCreate/Remove` hooks; Codex worktrees; `git worktree` otherwise); dev-server **port injection** (`$ORCH_PORT`, `$ORCH_DB_SUFFIX`) so parallel agents don't collide on ports/DBs.
- **Review & Merge module (P0):** branch/diff view per task, inline comments routed back to the author agent, cross-vendor review rounds (max N), test status, one-click PR via the user's own GitHub/GitLab credentials, merge by Lead or human per policy.
- **Lead:** any provider; registered MCP tools `capabilities()`, `delegate()`, `status()`, `collect()`, `ask_user()` (MCP elicitation, 2026-07-28 return-based); long delegations use the MCP **tasks** extension. Lead handoff via PLAN.md on exhaustion.
- **Quick Delegate:** one task, `quick` type, no plan file.

### 9.1 Interaction Bridge (prompts, questions, plans)
Every agent stop-and-ask becomes a structured **`AgentPrompt`** (permission · question · planApproval · confirm · login · error) with options, payload (tool/command/files/plan), `answerTransport` (hook-response · permission-tool · app-server RPC · elicitation · send-keys-acked). Sources per provider in §7.3. **Attention Queue** = one durable, prioritized inbox across all agents (persisted; survives restarts; push to phone with inline Approve/Deny). **Plan cards** (Claude plan mode, Codex plans, PLAN.md) render with Approve / Edit & resend / Reject; approved plans versioned. **Auto-answer policy** (autoApprove read-only/tests, autoDeny destructive, escalate infra→admin, merge:main→lead, timeouts → notify → pause) with every auto-decision audited.

## 10. Self-maintaining platform (updates, drift, self-healing)

### 10.1 Update channels (independent, signed, rollbackable)
| Artifact | Source | Cadence | Applies |
|---|---|---|---|
| App/daemon | GitHub Releases (signed, notarized; Tauri updater; **never delete-before-verify**; staged rollout; OS-floor check) | releases | on quit / user choice |
| Provider plugins | npm registry with provenance (`orchestra-provider-*`) | semver, engine-compat | hot-reload adapter |
| Capability Manifests | **Manifest Registry** (signed JSON, separate from plugin code) | as vendors change | hot-reload in seconds |
| Model catalog / profiles | `@orchestra/catalog` data package + registry | weekly/as needed | hot-reload |
| Skill packs / playbooks / policy packs | registry or git | user choice | hot-reload |

### 10.2 Doctor & drift detection (`orch doctor`, continuous)
- **Boot + hourly + on every CLI version change:** binary present & allowlisted; version vs manifest range; auth/plan status; quota-free probes (`--version`, `--help` parse, `codex app-server generate-json-schema` diff vs pinned fixture, `agy -p "/usage"` schema check).
- **Runtime signals:** Zod parse failures on hook/stream/RPC payloads, unknown event types, send-keys ack timeouts, unexpected exit codes, approval loops, model-not-found errors, 429 patterns.
- **Watchers:** official release feeds/changelogs of each CLI (from `manifest.updateSources`) → "Provider Update" items in Attention with impacted manifests and suggested action; **canary lane** tests a new CLI version in an isolated worktree before it is marked *verified* for users.
- SLOs: time-to-detect < 60 s; safe remediation < 10 s; every case visible in **Health**.

### 10.3 Remediation ladder (automatic → assisted, guardrailed)
1. **Safe auto-fixes (seconds, no approval):** reload manifest, re-register hooks/MCP, restart pane and resume session, switch transport (e.g. app-server → exec), reroute task to next candidate provider, roll back a plugin/manifest to last-known-good.
2. **Registry fix:** fetch a newer manifest/plugin matching the CLI version; apply hot.
3. **Repair Agent (assisted):** the fleet fixes the fleet — a sandboxed agent gets the failing fixture, the CLI's `--help`/changelog/docs, the adapter's contract tests, and proposes a manifest/adapter patch; runs the contract suite; opens a PR (or applies locally **with approval**). Guardrails: cannot touch auth, ToS rules, allowlist, ESLint bans, or spend beyond a repair budget; all diffs audited.
4. **Community loop (opt-in, anonymized):** drift reports per CLI version → registry marks manifests stale → maintainers notified → fix propagates to everyone.

### 10.4 Model lifecycle
Model added/renamed/deprecated by a vendor → catalog update → assignment engine re-scores → affected policies flagged ("your `architect` role lists a deprecated model") → one-click migration suggestion.

## 11. Quota, budgets & forecasting
Windows per provider (5-h/weekly/daily/tokens) from in-band signals only; **burn-rate forecasting** (time-to-limit per window, ccusage-style) with pre-emptive rerouting at thresholds; every number labeled *official* vs *estimate*; dry-run before missions; Lead reserve; protect-review budgets (e.g. ChatGPT $20 reserved for review). Cooling on 429 until `resetAt`; max one retry; no retry storms by construction.

## 12. Skills system
- **Skill = portable, versioned artifact** (SKILL.md-style with frontmatter: name, taskTypes, providers, requiredCapabilities, inputs, evals) rendered into each provider's native location (`.claude/skills`, `.agents/skills`, Codex/Kimi skills) with per-install **trust level**.
- **Library scopes:** org → workspace → user; packs for your stack (Clean-Arch Flutter feature, Spring Boot feature, Next.js feature, GCP Cloud Run deploy, Flyway migration, i18n AR/EN, ADR writing).
- **Auto-attach:** tasks get skills by `taskType` + platform; the Lead sees available skills in `capabilities()`.
- **Evals:** each skill has fixture tasks; `orch skill eval` runs them across providers and records quality/cost → feeds Model Scorecard and skill health.
- **Registry:** signed manifest, semver, engine compatibility, install from registry or GitHub repo.

## 13. History, recording & replay
asciicast v2 per pane · append-only events · conversations/messages/tool-calls copied into our DB · agent_prompts · plan_versions · routing_decisions · repair_cases · FTS5 across everything · timeline scrubber linking replay ↔ chat ↔ event ↔ diff · pin/tag/fork/resume/delete/purge · retention TTL · redaction (capture-time regex + manual) · export/import mission bundles.
Schema (v1): hosts · providers · provider_windows · sessions · panes · worktrees · recordings · missions · tasks · task_results · reviews · review_findings · routing_decisions · conversations · messages · message_tool_calls · attachments · agent_prompts · plan_versions · model_profiles · outcomes · skills · playbooks · repair_cases · events · audit_log · users · roles · permissions · settings_layers.

## 14. Multi-device access
Daemon binds `127.0.0.1`; remote via Tailscale/Cloudflare Tunnel only; PWA with Web Push; local token or OIDC; multiple hosts (Mac + server) in one UI; phone = attention/approve/chat/replay first; optional aggregation of vendors' own cloud sessions (Claude web, Codex cloud, agy remote) as monitor + handoff surfaces (P3).

## 15. UI/UX

**Principles:** attention over information · calm density · keyboard-first (`⌘K`) · truth labelling (official/estimate) · zero-surprise control (preview before spend/keys).
**IA:** Attention · Chat · Board · Missions · Terminals · Review · Models · Skills · Fleet · Timeline · History · Health · Settings.
**Screens:** Attention (queue) · Chat (rendered conversation + `/` command palette + plan cards + prompts) · Board (kanban) · Missions (plan, DAG, assignments + reasons, review rounds, cost, simulate) · Terminals (xterm grid, headers: provider·model·task·worktree·status; broadcast bar; attach externally) · Review (diff, inline comments, PR) · Models (catalog, scorecards, deprecations) · Skills (library, evals) · Fleet (plans, windows, forecasts, health) · Timeline · History/Replay · Health (doctor, drift cases, repairs, updates) · Settings (§16).
**Design system:** dark-first; semantic status never color-only; JetBrains Mono + Inter + Noto Sans Arabic; **RTL from day one** (logical properties); shadcn/ui base; WCAG 2.1 AA; reduce-motion.
**Reliability budgets:** cold start ≤ 1.5 s · first WS frame ≤ 500 ms · idle ≤ 300 MB, ≤ 40 MB per pane · 60 fps on 10k-line scrollback · input echo ≤ 50 ms · notifications coalesced and deep-linked · offline shows history and queues answers · session restore by re-attaching tmux + replaying events (no lost prompts).

## 16. Settings & customization
Precedence **task > user > workspace > org > defaults**, all files, versionable. Editors: routing/assignment policy (form + YAML + live "what runs where"), roles, task-type overrides, model profile overrides, prompt library (templates with variables), skills manager, playbooks, instruction-file fragments (CLAUDE.md/AGENTS.md per provider), auto-answer rules, sandbox profiles, notification channels, update channels (stable/beta), permissions (team mode).

## 17. Enterprise
RBAC (Admin/Lead/Member/Viewer) · OIDC · immutable audit (SIEM export) · approval gates (4-eyes option) · secrets never stored, scrubbed in recordings, encryption at rest · daemon OTel + Prometheus + health · single container / Helm · Postgres + S3 drivers · retention policies · data stays on your infra.

## 18. "Official-only" compliance — enforced by code
| Rule | Enforcement |
|---|---|
| Only official binaries, launched per vendor docs | `BinaryRegistry` allowlist; version verified at boot |
| Zero direct vendor API calls | ESLint rule + egress test (allowed: Web Push, OIDC, registries, update check) |
| Auth only inside official login flows; tokens never seen/stored/forwarded | `AuthProbe` returns plan/status only; tests assert no secret fields |
| One account per provider; no rotation/pooling/sharing | non-feature in `SECURITY.md`; registry enforces |
| Rate limits respected | cooling + backoff; max one retry |
| Concurrency within vendor allowances | `maxConcurrentSessions` per manifest |
| No screen-scraping for state | structured parsers only |
| Headless via documented flags only | typed argv builders |
| CI never touches real accounts | `FakeProvider` + fixtures |
| Every spend/keys action previewed, permissioned, audited | guards + interceptor + UI preview |
| **Antigravity:** never proxy/borrow OAuth, never hit the Service backend; adapter is opt-in with in-product ToS acknowledgement | adapter flag + docs |
| Repair Agent cannot modify auth/ToS/allowlist/ESLint rules | path-based guard + CODEOWNERS |

Never built: token proxies, account switchers, quota tricks, private usage readers, vendor-client impersonation.

## 19. Tech stack
Node 22 · TypeScript 5 · NestJS (Fastify, WS) · Kysely + better-sqlite3 (FTS5) / Postgres · tmux ≥ 3.3 (pinned) · node-pty **1.1.0** (pinned, prebuilt; PTY abstracted for `tauri-plugin-pty`/Rust fallback) · neverthrow · pino · OpenTelemetry JS (`gen_ai.*` pinned snapshot, dual-emit via `OTEL_SEMCONV_STABILITY_OPT_IN`) · React 19 · Vite · Tailwind 4 · shadcn/ui · Zustand · TanStack Query · xterm.js + WebGL · asciinema-player · cmdk · Tauri 2 (signed sidecars, hardened runtime, notarized, updater with separate signing key) · Zod · pnpm + Turborepo · Vitest + Playwright + Testcontainers · dependency-cruiser · semantic-release · Sigstore/cosign · npm provenance.

## 20. Roadmap (revised)
| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 · Foundation + compliance (3 wks)** | daemon, tmux control mode, **worktree manager**, WS API, Terminals grid, Fleet, adapters claude/codex(app-server)/agy(stdio stream-json), allowlist + ESLint bans + `SECURITY.md`, supply-chain CI (provenance, Scorecard) | 3 live panes in worktrees, model switch, plan detection; Scorecard running |
| **P1 · Delegation, intelligence, review (4 wks)** | MCP tools (elicitation), task taxonomy, model catalog v1, assignment engine + dry-run, quota forecasting, Interaction Bridge + **Attention Queue**, **Review & Merge**, Board, Quick Delegate, Missions v1 + playbooks | feature → planned, split, implemented, cross-reviewed, PR'd; 429 reroutes; prompts answered from web |
| **P2 · Self-maintenance + history (3 wks)** | Doctor, drift detector, manifest registry client, remediation ladder 1–2, Health screen, recordings, event store, Timeline, Replay, exports | kill/restart with no lost prompts; simulated CLI drift auto-remediated < 10 s |
| **P3 · Everywhere (2 wks)** | Tauri app (signed/notarized/updater), PWA + push, multi-host, cloud-session aggregation, `orch` CLI | approve from phone; zero Gatekeeper dialogs |
| **P4 · Customization + skills (3 wks)** | layered settings, policy/roles/task-type editors, prompt library, skills library + evals + auto-attach, Model Scorecard learning loop, playbook editor | teammate has own defaults; skill evals feed routing |
| **P5 · Enterprise (3–4 wks)** | RBAC, OIDC, audit export, approval gates, Postgres/S3, container/Helm, automations (scheduled/triggered missions) | two users, different permissions; audit passes review |
| **P6 · Ecosystem** | Repair Agent (ladder 3), community drift loop, plugin/skill/playbook registry, kimi + opencode adapters, docs site, RFC process | third party ships a provider without a core PR |

**1.0 Definition of Done:** four adapters pass contract tests on pinned fixtures incl. approval round-trips and quota parsing · worktrees + Review & Merge end-to-end on ≥ 2 providers · cross-vendor review enforced (e2e) · Interaction Bridge from web + PWA on all providers via official channels · Doctor + ladder 1–2 live with SLOs met · Tauri signed/notarized, safe updater, budgets met · restore with no lost prompts · forecasting on all providers · OpenSSF Best Practices *passing*, Scorecard ≥ 7, provenance + signed artifacts, SECURITY.md · docs with ADRs + Plugin Author Guide · ≥ 1 third-party plugin · EN + AR (RTL) UI · trademark-cleared identity.

## 21. Open source & governance
- **Name:** "Orchestra" likely conflicts (ORCHESTRA AI / Orchestral marks in adjacent classes). Run formal clearance; shortlist coined marks (e.g. *Maestrae*, *Fleetwright*, *Podium*); secure GitHub org + npm scope + `.dev/.com` before public launch.
- **License:** Apache-2.0 SDK/protocol/plugins; core per ADR-001 (Apache-2.0 vs AGPL-3.0) decided before first external PR. **DCO**, not CLA.
- **Governance:** BDFL → steering committee at objective triggers (≥ 3 sustained maintainers, N external PRs); public roadmap; RFC process; Contributor Covenant.
- **Security & supply chain:** `SECURITY.md` + private advisories + SLA; OpenSSF Best Practices badge + Scorecard in CI; npm provenance; Sigstore-signed releases; SLSA provenance; SBOM; pinned + integrity-checked deps (2026 npm worms targeting `.claude/` configs are a real threat — allowlist and ESLint bans are security controls).
- **Releases:** semantic-release, signed tags, GitHub Releases, Homebrew tap (cask), npm.
- **Docs:** Starlight; ADRs; Plugin Author Guide (adapter + manifest + fixture harness); Skill/Playbook Author Guide; versioned per CLI version; EN + AR.
- **Community:** Discussions + Discord; good-first-issue; plugin/skill registry with trust levels.

## 22. Risks & open decisions
Core license (ADR-001) · final name · Antigravity ToS comfort (legal review; opt-in adapter) · Codex app-server experimental status · agy quota numerics undocumented (label estimates) · OTel GenAI conventions unstable · "Fable" = model tier vs the coding agent (disambiguate in docs) · depth of cloud-session aggregation · Repair Agent trust boundary (ladder 3 stays assisted, never autonomous, until proven).

## 23. Repository layout
```
orchestra/
  apps/ daemon · web · desktop · cli
  packages/ core · sdk · catalog (taxonomy, model-profiles, playbooks, skill-packs) · ui
  packages/providers/ claude · codex · agy · kimi · opencode
  docs/ adr · plugin-guide · skill-guide · deployment
  examples/ policies · playbooks · skill-packs
  LICENSE · CONTRIBUTING.md (DCO) · CODE_OF_CONDUCT.md · SECURITY.md · ADR-001-license.md
```

---
*Next step after sign-off: ADR-001 (license) + name clearance, then scaffold the monorepo and ship P0.*
