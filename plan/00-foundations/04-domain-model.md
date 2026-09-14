# 04 — Domain model

## 1. Aggregates and value objects

| Aggregate (root → children) | Purpose |
|---|---|
| **Host** | a machine running `orchestrad`; owns ProviderAccounts, Sessions |
| **ProviderAccount** → ProviderWindow[] | one official login per provider; plan, auth status, quota windows |
| **Session** (holds `PaneRef` value object) → Recording | one running agent (tmux pane) bound to a provider/model/worktree; pane ids live on the session row, there is no separate `panes` table |
| **Worktree** | git worktree + branch for a task |
| **Mission** → Task[] → TaskResult, Review[] → ReviewFinding[] | a unit of user intent decomposed into typed tasks |
| **Conversation** → Message[] → ToolCall[] | rendered chat per session |
| **AgentPrompt** | a stop-and-ask from an agent, with answer transport |
| **PlanVersion** | versioned plan artifact (plan mode / PLAN.md) |
| **RoutingDecision** | assignment output with reasons and alternatives |
| **PolicySet** | routing, budgets, approvals, sandbox, auto-answer rules (layered) |
| **ModelProfile**, **Outcome** | capability profile + your evidence per (model, taskType) |
| **Skill**, **Playbook** | versioned artifacts |
| **RepairCase** | drift/remediation case with ladder step, status, audit |
| **User / Role / Permission** | team mode (M9) |

Value objects: `ProviderId`, `ModelId`, `TaskType`, `RoleName`, `WindowState`, `Budget`, `WorktreeRef`, `CapabilityFlag`, `SandboxProfile`, `AnswerTransport`, `Confidence(official|estimate)`.

Domain services: `AssignmentEngine`, `QuotaForecaster`, `ReviewRule` (cross-vendor), `LeadHandoff`, `DriftClassifier`, `RemediationLadder`, `PromptClassifier`.

## 2. State machines

### Session
```
requested → launching → running ⇄ waiting_for_input → stopping → stopped
                 │                      │                        ↑
                 └── failed ◀───────────┴──── crashed ───────────┘ (supervisor may resume → running)
```
### Task
```
draft → assigned → running → review_pending → in_review → changes_requested → running …
                                                       └→ approved → merging → done
        any → blocked / cancelled / failed (with reason)
```
### Mission
```
draft → planning → plan_review → executing → reviewing → merging → done | failed | cancelled
```
### AgentPrompt
```
open → answered (by user | policy | lead) → delivered → acknowledged
open → expired → (fallback transport) open
open → cancelled (session ended)
```
### RepairCase
```
detected → classified → auto_fixing → fixed
                     → registry_fix → fixed
                     → assisted (repair agent) → proposed → approved → applied → fixed
                     → needs_human
```

## 3. Event catalog (append-only `events` table; `type` is namespaced)

| Namespace | Events |
|---|---|
| `session.*` | requested, launched, model_switched, output_chunk (recording only, not DB), stopped, crashed, resumed |
| `prompt.*` | opened, answered, delivered, expired, auto_answered |
| `task.*` | created, assigned, started, progress, result_submitted, review_requested, reviewed, merged, failed |
| `mission.*` | created, planned, plan_approved, executing, completed |
| `routing.*` | decided, rerouted, dry_run |
| `quota.*` | window_updated, rate_limited, forecast_updated, reserve_breached |
| `provider.*` | detected, version_changed, auth_changed, update_available, manifest_reloaded, manifest_rolled_back (M1-04, M6-03, M6-05) |
| `doctor.*` | ran, drift_signal, drift_detected, remediation_applied, remediation_failed, canary_verified (M6-01..05) |
| `audit.*` | every mutating API call: who, what, before/after (redacted) |
| `telemetry.*` | unknown_payload, parse_failed, ack_timeout — raw parse-level signals from the pipeline (M1-08); M6-02 aggregates them into `doctor.drift_signal` before classification |
| `review.*` | requested, round_started, findings_captured, verdict, degraded_same_vendor (M3-04) |
| `forge.*` | pr_created, pr_updated, merged, merge_blocked (M3-06) |
| `isolation.*` | port_leased, port_released, collision_detected (M3-07) |
| `catalog.*` | taxonomy_loaded, models_loaded, playbooks_loaded, playbook_invalid (M2-01..03, M3-01) |
| `settings.*` | layer_changed, validation_failed (M8-01) |
| `gate.*` | opened, approved, rejected, escalated (M9-04) |
| `security.*` | scan_started, scan_finding, secret_scrubbed (M9-09) |
| `automation.*` | scheduled, triggered, run_started, run_finished (M9-07) |
| `restore.*` | started, session_adopted, prompt_rederived, completed (M5-05) |
| `push.*` | subscribed, sent, failed (M7-03) |
| `auth.*` | token_rotated, login, logout, strategy_changed (M7-04, M9-02) |
| `host.*` | registered, seen, unreachable (M7-05) |
| `cloud.*` | session_seen, handoff (M7-07, optional) |

**Extension rule:** a step may add event *types* inside an existing namespace (list them in the step and in `eventSchema`); adding a *namespace* requires a row here. Steps already known to add types: M3-02 `mission.plan_rejected`, M4-03 `quota.cooling_started|ended`, `task.blocked`, M4-04 `mission.budget_warned|paused|resumed`, M4-05 `mission.lead_handoff_started|completed|failed`, M5-05 `session.restored`, M6-* `doctor.*` details.

Every event: `{id (ulid), ts, hostId, type, correlation:{sessionId?, taskId?, missionId?, promptId?}, actor:{kind:user|agent|policy|system, id}, payload (zod-validated per type), source:{provider?, channel: hook|stream|rpc|tmux|ui|cli}}`.

Ingestion is idempotent: `(source.channel, source.externalId)` unique when provided.

## 4. Schema v1 (SQLite, Kysely migrations; Postgres-compatible types only)

| Table | Key columns |
|---|---|
| hosts | id, name, os, daemon_version, last_seen_at |
| providers | id, host_id, provider_id, cli_version, manifest_version, auth_status, plan_label, verified(bool), tos_acknowledged_at |
| provider_windows | id, provider_row_id, kind(5h/weekly/daily/tokens), used, limit_value, reset_at, confidence, source, updated_at |
| sessions | id, host_id, provider_id, model_id, task_id?, worktree_id?, tmux_window, tmux_pane, state, started_at, ended_at, exit_code, headless(bool) |
| worktrees | id, repo_path, path, branch, base_ref, task_id?, created_at, removed_at, port, db_suffix |
| recordings | id, session_id, path, format(asciicast-v2), bytes, started_at, ended_at |
| missions | id, title, playbook_id, state, lead_session_id?, plan_version_id?, budget_json, sandbox(bool, excluded from KPIs/outcomes), created_at |
| tasks | id, mission_id?, task_type, role, goal, context_json, acceptance_json, constraints_json, budget_json, state, assigned_provider, assigned_model, worktree_id?, session_id?, parent_task_id?, order_index, idempotency_key (unique) |
| task_results | id, task_id, branch, diff_stat_json, summary, tests_passed, artifacts_json, usage_json, verdict |
| reviews | id, task_id, round, reviewer_provider, reviewer_model, verdict, session_id |
| review_findings | id, review_id, severity, file, line, message, resolved(bool) |
| routing_decisions | id, task_id, task_type, chosen_provider, chosen_model, score, reasons_json, alternatives_json, breakdown_json, excluded_json, inputs_hash, policy_version, catalog_version, engine_version, actor_json, dry_run(bool), created_at |
| conversations | id, session_id |
| messages | id, conversation_id, role(user/assistant/system/tool), content, ts, external_id |
| message_tool_calls | id, message_id, tool, args_json(redacted), result_summary, duration_ms |
| attachments | id, message_id, path, mime |
| agent_prompts | id, session_id, kind, title, options_json, payload_json, answer_transport, state, answer_json, answered_by, opened_at, answered_at, expires_at |
| plan_versions | id, mission_id?, session_id?, version, content, source(plan_mode/codex/plan_md), approved(bool) |
| model_profiles | id, model_id, provider_id, dimensions_json, context_window, cost_tier, best_for_json, avoid_for_json, evidence_json, valid_from, valid_to, source(community/local) |
| outcomes | id, model_id, provider_id, task_type, task_id, skill_id?, source(mission/quick/eval), review_findings, tests_pass_rate, rework_rounds, latency_ms, cost_est, created_at |
| skills | id, name, version, scope, task_types_json, providers_json, trust_level, checksum, source_url?, installed_at, path |
| playbooks | id, name, version, scope, yaml |
| repair_cases | id, host_id, provider_id, cli_version, kind, fingerprint (dedupe), confidence, evidence_json (incl. metrics.ttdMs/ttrMs), ladder_step, state, patch_ref, detected_at, opened_at, closed_at |
| events | id, ts, host_id, type, correlation_json, actor_json, payload_json, source_json |
| audit_log | id, ts, user_id, action, target, before_json, after_json, ip |
| users, roles, permissions, settings_layers | team mode (M9-01) — note `RoleName` as a routing *value object* (role → model prefs) is editable data from M8-02; RBAC roles are a separate M9 concept |
| fts_* | FTS5 virtual tables over messages, events.payload, review_findings, plan_versions (M5-03) |

Conventions: ids are ULIDs (text); timestamps ISO-8601 UTC text; JSON columns are Zod-validated on write and read; no foreign key cascades on `events` (append-only, never deleted except retention purge). Column names avoid SQL reserved words (`order_index`, `limit_value`, `position`) so migrations port unquoted to Postgres (D8).

### Extension tables (added by later steps' migrations; listed here so the baseline stays the single map)
| Table | Added by | Purpose |
|---|---|---|
| telemetry_inbox | M1-08 / M5-05 | raw vendor payloads (redacted) persisted before parsing; replayed on restore |
| usage_samples, quota_forecasts, provider_cooling, task_retries | M4-01..03 | quota signals, EWMA forecasts, cooling state, one-retry ledger |
| mission_budget_usage, reserve_breaches, lead_handoffs, mission_simulations | M4-04..06 | budgets, reserves, handoff records, dry-run results |
| push_subscriptions | M7-03 | Web Push endpoints per user/device |
| hosts_registry (UI) | M7-05 | client-side; not a daemon table |
| automations, automation_runs | M9-07 | scheduled/triggered missions |
| gates, gate_decisions | M9-04 | approval gates + decisions (4-eyes) |
| user_roles, api_tokens, auth_sessions, auth_login_attempts | M9-01, M9-02 | RBAC + auth |
| audit_spool, audit_anchors (+ `audit_log.prev_hash`, `hash`) | M9-03 | hash-chained audit, SIEM export |
| security_scans | M9-09 | secrets-scrub audit runs |
| (none) prompt templates | M8-03 | prompt library is files under settings layers + `settings.*` events, no table |
| fts_* | M5-03 | FTS5 virtual tables |
