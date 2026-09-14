# Orchestra — Progress Tracker

| | |
|---|---|
| Last updated | 2026-09-14 |
| Current milestone | M0 — Foundation |
| Current step | M0-01 |
| MVP target | M0 + M1 complete, all TCs green |

Legend: ⬜ Not started · 🟨 In progress · 🧪 In test · ✅ Done · ⛔ Blocked · ⏸ Deferred

Update rule: change **Status**, fill **Started/Done** (ISO dates), put test summary in **Tests** (e.g. `12/12 TC ✅`), one-line **Notes**. Keep this file in sync with the step file's header Status. Add a row to the Change log for every status change.

## Milestone summary

| Milestone | Steps | ⬜ | 🟨 | 🧪 | ✅ | ⛔ | Status | Target start | Target end | Actual end |
|---|---|---|---|---|---|---|---|---|---|---|
| M0 — Foundation | 8 | 8 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M1 — MVP: Live fleet | 13 | 13 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M2 — Delegation & intelligence | 9 | 9 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M3 — Missions, review & merge | 9 | 9 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M4 — Quota, budgets, resilience | 7 | 7 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M5 — History, recording, replay | 6 | 6 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M6 — Self-maintenance | 7 | 7 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M7 — Everywhere | 7 | 7 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M8 — Customization & skills | 8 | 8 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M9 — Enterprise | 9 | 9 | 0 | 0 | 0 | 0 | ⬜ | | | |
| M10 — Ecosystem & 1.0 | 8 | 8 | 0 | 0 | 0 | 0 | ⬜ | | | |

## Step tracker

### M0 — Foundation
Folder: `01-m0-foundation/` · [README](01-m0-foundation/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M0-01 | Monorepo scaffold & toolchain | [step-01-monorepo-scaffold-and-toolchain.md](01-m0-foundation/step-01-monorepo-scaffold-and-toolchain.md) | 1.5 d | ⬜ | | | | |
| M0-02 | Core domain package | [step-02-core-domain-package.md](01-m0-foundation/step-02-core-domain-package.md) | 2 d | ⬜ | | | | |
| M0-03 | SDK, contract harness, FakeProvider | [step-03-sdk-contract-harness-fakeprovider.md](01-m0-foundation/step-03-sdk-contract-harness-fakeprovider.md) | 3 d | ⬜ | | | | |
| M0-04 | Daemon skeleton | [step-04-daemon-skeleton.md](01-m0-foundation/step-04-daemon-skeleton.md) | 2.5 d | ⬜ | | | | |
| M0-05 | Event store & repositories | [step-05-event-store-and-repositories.md](01-m0-foundation/step-05-event-store-and-repositories.md) | 1.5 d | ⬜ | | | | |
| M0-06 | HTTP API + WS gateway v1 | [step-06-http-api-ws-gateway-v1.md](01-m0-foundation/step-06-http-api-ws-gateway-v1.md) | 2 d | ⬜ | | | | |
| M0-07 | Web shell | [step-07-web-shell.md](01-m0-foundation/step-07-web-shell.md) | 2.5 d | ⬜ | | | | |
| M0-08 | CI & quality gates | [step-08-ci-and-quality-gates.md](01-m0-foundation/step-08-ci-and-quality-gates.md) | 2 d | ⬜ | | | | |

### M1 — MVP: Live fleet
Folder: `02-m1-mvp-live-fleet/` · [README](02-m1-mvp-live-fleet/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M1-01 | tmux control-mode driver | [step-01-tmux-control-mode-driver.md](02-m1-mvp-live-fleet/step-01-tmux-control-mode-driver.md) | 3 d | ⬜ | | | | |
| M1-02 | PTY port & SessionSupervisor | [step-02-pty-port-and-sessionsupervisor.md](02-m1-mvp-live-fleet/step-02-pty-port-and-sessionsupervisor.md) | 3 d | ⬜ | | | | |
| M1-03 | Worktree manager | [step-03-worktree-manager.md](02-m1-mvp-live-fleet/step-03-worktree-manager.md) | 2 d | ⬜ | | | | |
| M1-04 | BinaryRegistry & provider detection | [step-04-binaryregistry-and-provider-detection.md](02-m1-mvp-live-fleet/step-04-binaryregistry-and-provider-detection.md) | 1.5 d | ⬜ | | | | |
| M1-05 | Claude Code adapter v1 | [step-05-claude-code-adapter-v1.md](02-m1-mvp-live-fleet/step-05-claude-code-adapter-v1.md) | 4 d | ⬜ | | | | |
| M1-06 | Codex adapter v1 | [step-06-codex-adapter-v1.md](02-m1-mvp-live-fleet/step-06-codex-adapter-v1.md) | 4 d | ⬜ | | | | |
| M1-07 | Antigravity adapter v1 (opt-in) | [step-07-antigravity-adapter-v1-opt-in.md](02-m1-mvp-live-fleet/step-07-antigravity-adapter-v1-opt-in.md) | 3 d | ⬜ | | | | |
| M1-08 | Telemetry plane & fixture recorder | [step-08-telemetry-plane-and-fixture-recorder.md](02-m1-mvp-live-fleet/step-08-telemetry-plane-and-fixture-recorder.md) | 2.5 d | ⬜ | | | | |
| M1-09 | Terminals grid UI | [step-09-terminals-grid-ui.md](02-m1-mvp-live-fleet/step-09-terminals-grid-ui.md) | 3 d | ⬜ | | | | |
| M1-10 | Fleet screen v1 + start session | [step-10-fleet-screen-v1-start-session.md](02-m1-mvp-live-fleet/step-10-fleet-screen-v1-start-session.md) | 2 d | ⬜ | | | | |
| M1-11 | Interaction Bridge v1 & Attention queue | [step-11-interaction-bridge-v1-and-attention-queue.md](02-m1-mvp-live-fleet/step-11-interaction-bridge-v1-and-attention-queue.md) | 4 d | ⬜ | | | | |
| M1-12 | Quick Delegate lite | [step-12-quick-delegate-lite.md](02-m1-mvp-live-fleet/step-12-quick-delegate-lite.md) | 2.5 d | ⬜ | | | | |
| M1-13 | MVP acceptance | [step-13-mvp-acceptance.md](02-m1-mvp-live-fleet/step-13-mvp-acceptance.md) | 2 d | ⬜ | | | | |

### M2 — Delegation & intelligence
Folder: `03-m2-delegation-intelligence/` · [README](03-m2-delegation-intelligence/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M2-01 | Task taxonomy catalog | [step-01-task-taxonomy-catalog.md](03-m2-delegation-intelligence/step-01-task-taxonomy-catalog.md) | 2 d | ⬜ | | | | |
| M2-02 | Model catalog & profiles v1 | [step-02-model-catalog-and-profiles-v1.md](03-m2-delegation-intelligence/step-02-model-catalog-and-profiles-v1.md) | 2.5 d | ⬜ | | | | |
| M2-03 | Capability manifests v1 (full) | [step-03-capability-manifests-v1-full.md](03-m2-delegation-intelligence/step-03-capability-manifests-v1-full.md) | 2.5 d | ⬜ | | | | |
| M2-04 | Assignment engine | [step-04-assignment-engine.md](03-m2-delegation-intelligence/step-04-assignment-engine.md) | 3 d | ⬜ | | | | |
| M2-05 | MCP delegation server | [step-05-mcp-delegation-server.md](03-m2-delegation-intelligence/step-05-mcp-delegation-server.md) | 3 d | ⬜ | | | | |
| M2-06 | Quick Delegate v2 | [step-06-quick-delegate-v2.md](03-m2-delegation-intelligence/step-06-quick-delegate-v2.md) | 1.5 d | ⬜ | | | | |
| M2-07 | Board (kanban) | [step-07-board-kanban.md](03-m2-delegation-intelligence/step-07-board-kanban.md) | 2 d | ⬜ | | | | |
| M2-08 | Chat screen | [step-08-chat-screen.md](03-m2-delegation-intelligence/step-08-chat-screen.md) | 2.5 d | ⬜ | | | | |
| M2-09 | Routing policy file & decision log | [step-09-routing-policy-file-and-decision-log.md](03-m2-delegation-intelligence/step-09-routing-policy-file-and-decision-log.md) | 1 d | ⬜ | | | | |

### M3 — Missions, review & merge
Folder: `04-m3-missions-review-merge/` · [README](04-m3-missions-review-merge/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M3-01 | Playbook schema & shipped playbooks | [step-01-playbook-schema-and-shipped-playbooks.md](04-m3-missions-review-merge/step-01-playbook-schema-and-shipped-playbooks.md) | 2 d | ⬜ | | | | |
| M3-02 | Mission lifecycle & Lead session | [step-02-mission-lifecycle-and-lead-session.md](04-m3-missions-review-merge/step-02-mission-lifecycle-and-lead-session.md) | 3 d | ⬜ | | | | |
| M3-03 | Task contract & result collection | [step-03-task-contract-and-result-collection.md](04-m3-missions-review-merge/step-03-task-contract-and-result-collection.md) | 2 d | ⬜ | | | | |
| M3-04 | Cross-vendor review rule & rounds | [step-04-cross-vendor-review-rule-and-rounds.md](04-m3-missions-review-merge/step-04-cross-vendor-review-rule-and-rounds.md) | 3 d | ⬜ | | | | |
| M3-05 | Review & Merge UI | [step-05-review-and-merge-ui.md](04-m3-missions-review-merge/step-05-review-and-merge-ui.md) | 3 d | ⬜ | | | | |
| M3-06 | PR integration | [step-06-pr-integration.md](04-m3-missions-review-merge/step-06-pr-integration.md) | 2 d | ⬜ | | | | |
| M3-07 | Parallel isolation | [step-07-parallel-isolation.md](04-m3-missions-review-merge/step-07-parallel-isolation.md) | 1.5 d | ⬜ | | | | |
| M3-08 | Missions screen | [step-08-missions-screen.md](04-m3-missions-review-merge/step-08-missions-screen.md) | 3 d | ⬜ | | | | |
| M3-09 | E2E feature mission acceptance | [step-09-e2e-feature-mission-acceptance.md](04-m3-missions-review-merge/step-09-e2e-feature-mission-acceptance.md) | 2.5 d | ⬜ | | | | |

### M4 — Quota, budgets, resilience
Folder: `05-m4-quota-resilience/` · [README](05-m4-quota-resilience/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M4-01 | Quota signals & windows | [step-01-quota-signals-and-windows.md](05-m4-quota-resilience/step-01-quota-signals-and-windows.md) | 2.5 d | ⬜ | | | | |
| M4-02 | QuotaForecaster | [step-02-quotaforecaster.md](05-m4-quota-resilience/step-02-quotaforecaster.md) | 2 d | ⬜ | | | | |
| M4-03 | Rate-limit cooling & reroute | [step-03-rate-limit-cooling-and-reroute.md](05-m4-quota-resilience/step-03-rate-limit-cooling-and-reroute.md) | 2.5 d | ⬜ | | | | |
| M4-04 | Budgets & reserves | [step-04-budgets-and-reserves.md](05-m4-quota-resilience/step-04-budgets-and-reserves.md) | 2 d | ⬜ | | | | |
| M4-05 | Lead handoff | [step-05-lead-handoff.md](05-m4-quota-resilience/step-05-lead-handoff.md) | 2 d | ⬜ | | | | |
| M4-06 | Dry-run simulation | [step-06-dry-run-simulation.md](05-m4-quota-resilience/step-06-dry-run-simulation.md) | 1.5 d | ⬜ | | | | |
| M4-07 | Fleet windows/forecast UI & KPIs | [step-07-fleet-windows-forecast-ui-and-kpis.md](05-m4-quota-resilience/step-07-fleet-windows-forecast-ui-and-kpis.md) | 1.5 d | ⬜ | | | | |

### M5 — History, recording, replay
Folder: `06-m5-history-replay/` · [README](06-m5-history-replay/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M5-01 | Pane recorder (asciicast v2) | [step-01-pane-recorder-asciicast-v2.md](06-m5-history-replay/step-01-pane-recorder-asciicast-v2.md) | 2.5 d | ⬜ | | | | |
| M5-02 | Conversation & tool-call capture v2 | [step-02-conversation-and-tool-call-capture-v2.md](06-m5-history-replay/step-02-conversation-and-tool-call-capture-v2.md) | 2.5 d | ⬜ | | | | |
| M5-03 | FTS5 search | [step-03-fts5-search.md](06-m5-history-replay/step-03-fts5-search.md) | 1.5 d | ⬜ | | | | |
| M5-04 | Timeline & Replay UI | [step-04-timeline-and-replay-ui.md](06-m5-history-replay/step-04-timeline-and-replay-ui.md) | 3 d | ⬜ | | | | |
| M5-05 | Session restore with zero lost prompts | [step-05-session-restore-with-zero-lost-prompts.md](06-m5-history-replay/step-05-session-restore-with-zero-lost-prompts.md) | 2.5 d | ⬜ | | | | |
| M5-06 | Retention, redaction, export/import | [step-06-retention-redaction-export-import.md](06-m5-history-replay/step-06-retention-redaction-export-import.md) | 2 d | ⬜ | | | | |

### M6 — Self-maintenance
Folder: `07-m6-self-maintenance/` · [README](07-m6-self-maintenance/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M6-01 | Doctor | [step-01-doctor.md](07-m6-self-maintenance/step-01-doctor.md) | 2.5 d | ⬜ | | | | |
| M6-02 | Drift detector & classifier | [step-02-drift-detector-and-classifier.md](07-m6-self-maintenance/step-02-drift-detector-and-classifier.md) | 2.5 d | ⬜ | | | | |
| M6-03 | Manifest registry client | [step-03-manifest-registry-client.md](07-m6-self-maintenance/step-03-manifest-registry-client.md) | 2 d | ⬜ | | | | |
| M6-04 | Remediation ladder 1–2 | [step-04-remediation-ladder-1-2.md](07-m6-self-maintenance/step-04-remediation-ladder-1-2.md) | 3 d | ⬜ | | | | |
| M6-05 | Release watchers & canary lane | [step-05-release-watchers-and-canary-lane.md](07-m6-self-maintenance/step-05-release-watchers-and-canary-lane.md) | 2 d | ⬜ | | | | |
| M6-06 | Model lifecycle | [step-06-model-lifecycle.md](07-m6-self-maintenance/step-06-model-lifecycle.md) | 1.5 d | ⬜ | | | | |
| M6-07 | Health screen & SLOs | [step-07-health-screen-and-slos.md](07-m6-self-maintenance/step-07-health-screen-and-slos.md) | 2 d | ⬜ | | | | |

### M7 — Everywhere
Folder: `08-m7-everywhere/` · [README](08-m7-everywhere/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M7-01 | Tauri desktop shell | [step-01-tauri-desktop-shell.md](08-m7-everywhere/step-01-tauri-desktop-shell.md) | 3 d | ⬜ | | | | |
| M7-02 | Signing, notarization, updater | [step-02-signing-notarization-updater.md](08-m7-everywhere/step-02-signing-notarization-updater.md) | 2.5 d | ⬜ | | | | |
| M7-03 | PWA & Web Push | [step-03-pwa-and-web-push.md](08-m7-everywhere/step-03-pwa-and-web-push.md) | 2.5 d | ⬜ | | | | |
| M7-04 | Remote access & auth | [step-04-remote-access-and-auth.md](08-m7-everywhere/step-04-remote-access-and-auth.md) | 1.5 d | ⬜ | | | | |
| M7-05 | Multi-host | [step-05-multi-host.md](08-m7-everywhere/step-05-multi-host.md) | 2.5 d | ⬜ | | | | |
| M7-06 | `orch` CLI | [step-06-orch-cli.md](08-m7-everywhere/step-06-orch-cli.md) | 2 d | ⬜ | | | | |
| M7-07 | Cloud-session aggregation (optional) | [step-07-cloud-session-aggregation-optional.md](08-m7-everywhere/step-07-cloud-session-aggregation-optional.md) | 1 d | ⬜ | | | | |

### M8 — Customization & skills
Folder: `09-m8-customization-skills/` · [README](09-m8-customization-skills/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M8-01 | Layered settings engine | [step-01-layered-settings-engine.md](09-m8-customization-skills/step-01-layered-settings-engine.md) | 2.5 d | ⬜ | | | | |
| M8-02 | Policy, roles, task-type editors | [step-02-policy-roles-task-type-editors.md](09-m8-customization-skills/step-02-policy-roles-task-type-editors.md) | 3 d | ⬜ | | | | |
| M8-03 | Prompt library | [step-03-prompt-library.md](09-m8-customization-skills/step-03-prompt-library.md) | 1.5 d | ⬜ | | | | |
| M8-04 | Skills system | [step-04-skills-system.md](09-m8-customization-skills/step-04-skills-system.md) | 3 d | ⬜ | | | | |
| M8-05 | Skill evals | [step-05-skill-evals.md](09-m8-customization-skills/step-05-skill-evals.md) | 2 d | ⬜ | | | | |
| M8-06 | Model Scorecard & learning loop | [step-06-model-scorecard-and-learning-loop.md](09-m8-customization-skills/step-06-model-scorecard-and-learning-loop.md) | 2.5 d | ⬜ | | | | |
| M8-07 | Playbook editor | [step-07-playbook-editor.md](09-m8-customization-skills/step-07-playbook-editor.md) | 1.5 d | ⬜ | | | | |
| M8-08 | Instruction fragments, auto-answer & notifications editors | [step-08-instruction-fragments-auto-answer-and-notifications-editors.md](09-m8-customization-skills/step-08-instruction-fragments-auto-answer-and-notifications-editors.md) | 2 d | ⬜ | | | | |

### M9 — Enterprise
Folder: `10-m9-enterprise/` · [README](10-m9-enterprise/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M9-01 | RBAC | [step-01-rbac.md](10-m9-enterprise/step-01-rbac.md) | 3 d | ⬜ | | | | |
| M9-02 | OIDC | [step-02-oidc.md](10-m9-enterprise/step-02-oidc.md) | 2 d | ⬜ | | | | |
| M9-03 | Immutable audit log & SIEM export | [step-03-immutable-audit-log-and-siem-export.md](10-m9-enterprise/step-03-immutable-audit-log-and-siem-export.md) | 2 d | ⬜ | | | | |
| M9-04 | Approval gates (4-eyes) | [step-04-approval-gates-4-eyes.md](10-m9-enterprise/step-04-approval-gates-4-eyes.md) | 2 d | ⬜ | | | | |
| M9-05 | Postgres + S3 drivers | [step-05-postgres-s3-drivers.md](10-m9-enterprise/step-05-postgres-s3-drivers.md) | 3 d | ⬜ | | | | |
| M9-06 | Container & Helm | [step-06-container-and-helm.md](10-m9-enterprise/step-06-container-and-helm.md) | 2.5 d | ⬜ | | | | |
| M9-07 | Automations | [step-07-automations.md](10-m9-enterprise/step-07-automations.md) | 2.5 d | ⬜ | | | | |
| M9-08 | Observability | [step-08-observability.md](10-m9-enterprise/step-08-observability.md) | 2 d | ⬜ | | | | |
| M9-09 | Security hardening | [step-09-security-hardening.md](10-m9-enterprise/step-09-security-hardening.md) | 2 d | ⬜ | | | | |

### M10 — Ecosystem & 1.0
Folder: `11-m10-ecosystem-launch/` · [README](11-m10-ecosystem-launch/README.md)

| Step | Title | File | Effort | Status | Started | Done | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| M10-01 | Repair Agent (ladder 3) | [step-01-repair-agent-ladder-3.md](11-m10-ecosystem-launch/step-01-repair-agent-ladder-3.md) | 4 d | ⬜ | | | | |
| M10-02 | Community drift loop | [step-02-community-drift-loop.md](11-m10-ecosystem-launch/step-02-community-drift-loop.md) | 2 d | ⬜ | | | | |
| M10-03 | Plugin/skill/playbook registry | [step-03-plugin-skill-playbook-registry.md](11-m10-ecosystem-launch/step-03-plugin-skill-playbook-registry.md) | 3 d | ⬜ | | | | |
| M10-04 | Kimi adapter | [step-04-kimi-adapter.md](11-m10-ecosystem-launch/step-04-kimi-adapter.md) | 2.5 d | ⬜ | | | | |
| M10-05 | OpenCode adapter | [step-05-opencode-adapter.md](11-m10-ecosystem-launch/step-05-opencode-adapter.md) | 2.5 d | ⬜ | | | | |
| M10-06 | Docs site | [step-06-docs-site.md](11-m10-ecosystem-launch/step-06-docs-site.md) | 2.5 d | ⬜ | | | | |
| M10-07 | Governance & releases | [step-07-governance-and-releases.md](11-m10-ecosystem-launch/step-07-governance-and-releases.md) | 2 d | ⬜ | | | | |
| M10-08 | 1.0 Definition of Done audit | [step-08-1-0-definition-of-done-audit.md](11-m10-ecosystem-launch/step-08-1-0-definition-of-done-audit.md) | 1.5 d | ⬜ | | | | |

## Blockers

| Date | Step | Blocker | What unblocks it | Owner | Resolved |
|---|---|---|---|---|---|
| | | | | | |

## Decisions pending (see DECISIONS.md)

| ADR | Topic | Needed before | Status |
|---|---|---|---|
| ADR-001 | Core license (Apache-2.0 vs AGPL-3.0) | first external PR (M10-07 latest) | Proposed |
| ADR-002 | Product name clearance | public launch (M10-07) | Open |
| ADR-003 | Node floor 22 vs 24 | M0-01 | Proposed (22) |
| ADR-004 | Recording source: tmux pipe-pane vs control-mode %output | M5-01 | Open |
| ADR-005 | Daemon packaging in Tauri (Node SEA vs bundled runtime vs Rust port) | M7-01 | Open |
| ADR-006 | Manifest/registry signing scheme (Sigstore vs minisign) | M6-03 | Open |

## Change log

| Date | Step | Change |
|---|---|---|
| 2026-09-14 | — | Plan created (11 milestones, 91 steps). |
