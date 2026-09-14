# Agent routing — which sub-agent implements which step

Generated from `ROADMAP.md`. Main session = orchestrator (never implements). Each step is assigned to one implementer agent by complexity; every step is reviewed by `orchestra-reviewer` (Fable) before the human runs manual TCs.

| Tier | Agent | Model | When |
|---|---|---|---|
| A | `orchestra-architect` | fable | novel design, concurrency, vendor integration, security boundaries, anything in RISKS.md with score ≥ 12 |
| B | `orchestra-implementer` | opus | default: implement a fully specified step file |
| C | `orchestra-builder` | sonnet | data files, YAML catalogs, read-only screens, docs, CLI wiring, tests from a spec |
| — | `orchestra-reviewer` | fable | review every diff vs step §4/§7 + compliance |
| — | `orchestra-tester` | sonnet | write/run automated tests from §6.1, report |
| — | `orchestra-scout` | haiku | read-only codebase lookups for the orchestrator |
| — | `orchestra-progress` | haiku | update PROGRESS.md + step progress logs |

Escalation: implementer stuck twice on the same failure → hand the task to `orchestra-architect`. Builder output that touches `packages/core`, `packages/sdk` or `packages/providers/*` is always reviewed before merge.


## M0 — Foundation

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M0-01 | [Monorepo scaffold & toolchain](01-m0-foundation/step-01-monorepo-scaffold-and-toolchain.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M0-02 | [Core domain package](01-m0-foundation/step-02-core-domain-package.md) | 2 d | A | `orchestra-architect` | domain model shapes everything after |
| M0-03 | [SDK, contract harness, FakeProvider](01-m0-foundation/step-03-sdk-contract-harness-fakeprovider.md) | 3 d | A | `orchestra-architect` | plugin contract + FakeProvider is the test backbone |
| M0-04 | [Daemon skeleton](01-m0-foundation/step-04-daemon-skeleton.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M0-05 | [Event store & repositories](01-m0-foundation/step-05-event-store-and-repositories.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M0-06 | [HTTP API + WS gateway v1](01-m0-foundation/step-06-http-api-ws-gateway-v1.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M0-07 | [Web shell](01-m0-foundation/step-07-web-shell.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M0-08 | [CI & quality gates](01-m0-foundation/step-08-ci-and-quality-gates.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M1 — MVP: Live fleet

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M1-01 | [tmux control-mode driver](02-m1-mvp-live-fleet/step-01-tmux-control-mode-driver.md) | 3 d | A | `orchestra-architect` | tmux control-mode parser, R2 |
| M1-02 | [PTY port & SessionSupervisor](02-m1-mvp-live-fleet/step-02-pty-port-and-sessionsupervisor.md) | 3 d | A | `orchestra-architect` | single supervisor actor, crash recovery |
| M1-03 | [Worktree manager](02-m1-mvp-live-fleet/step-03-worktree-manager.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M1-04 | [BinaryRegistry & provider detection](02-m1-mvp-live-fleet/step-04-binaryregistry-and-provider-detection.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M1-05 | [Claude Code adapter v1](02-m1-mvp-live-fleet/step-05-claude-code-adapter-v1.md) | 4 d | A | `orchestra-architect` | first real adapter; reading live CLI behaviour |
| M1-06 | [Codex adapter v1](02-m1-mvp-live-fleet/step-06-codex-adapter-v1.md) | 4 d | A | `orchestra-architect` | Codex app-server RPC + stdio bridge, R3 |
| M1-07 | [Antigravity adapter v1 (opt-in)](02-m1-mvp-live-fleet/step-07-antigravity-adapter-v1-opt-in.md) | 3 d | A | `orchestra-architect` | agy stream-json + ToS gate, R4 |
| M1-08 | [Telemetry plane & fixture recorder](02-m1-mvp-live-fleet/step-08-telemetry-plane-and-fixture-recorder.md) | 2.5 d | A | `orchestra-architect` | telemetry pipeline + held hook responses |
| M1-09 | [Terminals grid UI](02-m1-mvp-live-fleet/step-09-terminals-grid-ui.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M1-10 | [Fleet screen v1 + start session](02-m1-mvp-live-fleet/step-10-fleet-screen-v1-start-session.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M1-11 | [Interaction Bridge v1 & Attention queue](02-m1-mvp-live-fleet/step-11-interaction-bridge-v1-and-attention-queue.md) | 4 d | A | `orchestra-architect` | prompt round-trips + transports, R5 |
| M1-12 | [Quick Delegate lite](02-m1-mvp-live-fleet/step-12-quick-delegate-lite.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M1-13 | [MVP acceptance](02-m1-mvp-live-fleet/step-13-mvp-acceptance.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M2 — Delegation & intelligence

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M2-01 | [Task taxonomy catalog](03-m2-delegation-intelligence/step-01-task-taxonomy-catalog.md) | 2 d | C | `orchestra-builder` | YAML catalog + schema |
| M2-02 | [Model catalog & profiles v1](03-m2-delegation-intelligence/step-02-model-catalog-and-profiles-v1.md) | 2.5 d | C | `orchestra-builder` | profile data + simple screen |
| M2-03 | [Capability manifests v1 (full)](03-m2-delegation-intelligence/step-03-capability-manifests-v1-full.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M2-04 | [Assignment engine](03-m2-delegation-intelligence/step-04-assignment-engine.md) | 3 d | A | `orchestra-architect` | assignment engine, 100 % branch, explainability |
| M2-05 | [MCP delegation server](03-m2-delegation-intelligence/step-05-mcp-delegation-server.md) | 3 d | A | `orchestra-architect` | MCP delegation server + elicitation |
| M2-06 | [Quick Delegate v2](03-m2-delegation-intelligence/step-06-quick-delegate-v2.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M2-07 | [Board (kanban)](03-m2-delegation-intelligence/step-07-board-kanban.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M2-08 | [Chat screen](03-m2-delegation-intelligence/step-08-chat-screen.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M2-09 | [Routing policy file & decision log](03-m2-delegation-intelligence/step-09-routing-policy-file-and-decision-log.md) | 1 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M3 — Missions, review & merge

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M3-01 | [Playbook schema & shipped playbooks](04-m3-missions-review-merge/step-01-playbook-schema-and-shipped-playbooks.md) | 2 d | C | `orchestra-builder` | playbook YAML + validation |
| M3-02 | [Mission lifecycle & Lead session](04-m3-missions-review-merge/step-02-mission-lifecycle-and-lead-session.md) | 3 d | A | `orchestra-architect` | mission lifecycle + Lead |
| M3-03 | [Task contract & result collection](04-m3-missions-review-merge/step-03-task-contract-and-result-collection.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M3-04 | [Cross-vendor review rule & rounds](04-m3-missions-review-merge/step-04-cross-vendor-review-rule-and-rounds.md) | 3 d | A | `orchestra-architect` | cross-vendor review rule + findings extraction |
| M3-05 | [Review & Merge UI](04-m3-missions-review-merge/step-05-review-and-merge-ui.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M3-06 | [PR integration](04-m3-missions-review-merge/step-06-pr-integration.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M3-07 | [Parallel isolation](04-m3-missions-review-merge/step-07-parallel-isolation.md) | 1.5 d | C | `orchestra-builder` | env injection + port allocator |
| M3-08 | [Missions screen](04-m3-missions-review-merge/step-08-missions-screen.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M3-09 | [E2E feature mission acceptance](04-m3-missions-review-merge/step-09-e2e-feature-mission-acceptance.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M4 — Quota, budgets, resilience

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M4-01 | [Quota signals & windows](05-m4-quota-resilience/step-01-quota-signals-and-windows.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M4-02 | [QuotaForecaster](05-m4-quota-resilience/step-02-quotaforecaster.md) | 2 d | A | `orchestra-architect` | forecaster math, property tests |
| M4-03 | [Rate-limit cooling & reroute](05-m4-quota-resilience/step-03-rate-limit-cooling-and-reroute.md) | 2.5 d | A | `orchestra-architect` | cooling/reroute; no retry storms (C5) |
| M4-04 | [Budgets & reserves](05-m4-quota-resilience/step-04-budgets-and-reserves.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M4-05 | [Lead handoff](05-m4-quota-resilience/step-05-lead-handoff.md) | 2 d | A | `orchestra-architect` | Lead handoff |
| M4-06 | [Dry-run simulation](05-m4-quota-resilience/step-06-dry-run-simulation.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M4-07 | [Fleet windows/forecast UI & KPIs](05-m4-quota-resilience/step-07-fleet-windows-forecast-ui-and-kpis.md) | 1.5 d | C | `orchestra-builder` | UI over existing data |

## M5 — History, recording, replay

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M5-01 | [Pane recorder (asciicast v2)](06-m5-history-replay/step-01-pane-recorder-asciicast-v2.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M5-02 | [Conversation & tool-call capture v2](06-m5-history-replay/step-02-conversation-and-tool-call-capture-v2.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M5-03 | [FTS5 search](06-m5-history-replay/step-03-fts5-search.md) | 1.5 d | C | `orchestra-builder` | FTS tables + search screen |
| M5-04 | [Timeline & Replay UI](06-m5-history-replay/step-04-timeline-and-replay-ui.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M5-05 | [Session restore with zero lost prompts](06-m5-history-replay/step-05-session-restore-with-zero-lost-prompts.md) | 2.5 d | A | `orchestra-architect` | restore with zero lost prompts |
| M5-06 | [Retention, redaction, export/import](06-m5-history-replay/step-06-retention-redaction-export-import.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M6 — Self-maintenance

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M6-01 | [Doctor](07-m6-self-maintenance/step-01-doctor.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M6-02 | [Drift detector & classifier](07-m6-self-maintenance/step-02-drift-detector-and-classifier.md) | 2.5 d | A | `orchestra-architect` | drift classifier |
| M6-03 | [Manifest registry client](07-m6-self-maintenance/step-03-manifest-registry-client.md) | 2 d | A | `orchestra-architect` | signed manifest registry client |
| M6-04 | [Remediation ladder 1–2](07-m6-self-maintenance/step-04-remediation-ladder-1-2.md) | 3 d | A | `orchestra-architect` | remediation ladder + guards (C12) |
| M6-05 | [Release watchers & canary lane](07-m6-self-maintenance/step-05-release-watchers-and-canary-lane.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M6-06 | [Model lifecycle](07-m6-self-maintenance/step-06-model-lifecycle.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M6-07 | [Health screen & SLOs](07-m6-self-maintenance/step-07-health-screen-and-slos.md) | 2 d | C | `orchestra-builder` | Health screen (read model) |

## M7 — Everywhere

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M7-01 | [Tauri desktop shell](08-m7-everywhere/step-01-tauri-desktop-shell.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M7-02 | [Signing, notarization, updater](08-m7-everywhere/step-02-signing-notarization-updater.md) | 2.5 d | A | `orchestra-architect` | signing/notarization/updater security |
| M7-03 | [PWA & Web Push](08-m7-everywhere/step-03-pwa-and-web-push.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M7-04 | [Remote access & auth](08-m7-everywhere/step-04-remote-access-and-auth.md) | 1.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M7-05 | [Multi-host](08-m7-everywhere/step-05-multi-host.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M7-06 | [`orch` CLI](08-m7-everywhere/step-06-orch-cli.md) | 2 d | C | `orchestra-builder` | CLI consolidation |
| M7-07 | [Cloud-session aggregation (optional)](08-m7-everywhere/step-07-cloud-session-aggregation-optional.md) | 1 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M8 — Customization & skills

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M8-01 | [Layered settings engine](09-m8-customization-skills/step-01-layered-settings-engine.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M8-02 | [Policy, roles, task-type editors](09-m8-customization-skills/step-02-policy-roles-task-type-editors.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M8-03 | [Prompt library](09-m8-customization-skills/step-03-prompt-library.md) | 1.5 d | C | `orchestra-builder` | prompt library |
| M8-04 | [Skills system](09-m8-customization-skills/step-04-skills-system.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M8-05 | [Skill evals](09-m8-customization-skills/step-05-skill-evals.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M8-06 | [Model Scorecard & learning loop](09-m8-customization-skills/step-06-model-scorecard-and-learning-loop.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M8-07 | [Playbook editor](09-m8-customization-skills/step-07-playbook-editor.md) | 1.5 d | C | `orchestra-builder` | playbook editor |
| M8-08 | [Instruction fragments, auto-answer & notifications editors](09-m8-customization-skills/step-08-instruction-fragments-auto-answer-and-notifications-editors.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M9 — Enterprise

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M9-01 | [RBAC](10-m9-enterprise/step-01-rbac.md) | 3 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-02 | [OIDC](10-m9-enterprise/step-02-oidc.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-03 | [Immutable audit log & SIEM export](10-m9-enterprise/step-03-immutable-audit-log-and-siem-export.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-04 | [Approval gates (4-eyes)](10-m9-enterprise/step-04-approval-gates-4-eyes.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-05 | [Postgres + S3 drivers](10-m9-enterprise/step-05-postgres-s3-drivers.md) | 3 d | A | `orchestra-architect` | Postgres/S3 driver swap + migration parity |
| M9-06 | [Container & Helm](10-m9-enterprise/step-06-container-and-helm.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-07 | [Automations](10-m9-enterprise/step-07-automations.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M9-08 | [Observability](10-m9-enterprise/step-08-observability.md) | 2 d | C | `orchestra-builder` | metrics exporters + dashboards |
| M9-09 | [Security hardening](10-m9-enterprise/step-09-security-hardening.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |

## M10 — Ecosystem & 1.0

| Step | Title | Effort | Tier | Agent | Why |
|---|---|---|---|---|---|
| M10-01 | [Repair Agent (ladder 3)](11-m10-ecosystem-launch/step-01-repair-agent-ladder-3.md) | 4 d | A | `orchestra-architect` | Repair Agent guardrails |
| M10-02 | [Community drift loop](11-m10-ecosystem-launch/step-02-community-drift-loop.md) | 2 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M10-03 | [Plugin/skill/playbook registry](11-m10-ecosystem-launch/step-03-plugin-skill-playbook-registry.md) | 3 d | A | `orchestra-architect` | plugin registry trust + verification |
| M10-04 | [Kimi adapter](11-m10-ecosystem-launch/step-04-kimi-adapter.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M10-05 | [OpenCode adapter](11-m10-ecosystem-launch/step-05-opencode-adapter.md) | 2.5 d | B | `orchestra-implementer` | fully specified; standard implementation |
| M10-06 | [Docs site](11-m10-ecosystem-launch/step-06-docs-site.md) | 2.5 d | C | `orchestra-builder` | docs site |
| M10-07 | [Governance & releases](11-m10-ecosystem-launch/step-07-governance-and-releases.md) | 2 d | C | `orchestra-builder` | governance files + release config |
| M10-08 | [1.0 Definition of Done audit](11-m10-ecosystem-launch/step-08-1-0-definition-of-done-audit.md) | 1.5 d | C | `orchestra-builder` | audit checklist |

## Totals

| Tier | Steps |
|---|---|
| A fable | 24 |
| B opus | 53 |
| C sonnet | 14 |
