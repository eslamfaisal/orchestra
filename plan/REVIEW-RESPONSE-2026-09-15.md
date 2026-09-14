# Feasibility review response — 2026-09-15

Source: [Astra review notes](../astra-review-notes.md). This revision continues the existing partial response and changes planning documents and plan-validation tooling only. The original review is preserved. No product implementation, provider installation, account workload, deployment or human approval is claimed.

**Design response complete; runtime feasibility remains unverified.** All 92 implementation steps remain not started. The new M0-09 specification closes the missing-file gap in the earlier response. Proposed ADRs remain proposed.

## Retained architecture

Keep the local daemon, official CLI ownership of authentication, clean dependency boundaries, deterministic policy/routing, provider adapters, separate terminal and structured telemetry planes, worktrees, attention queue, task artifacts, controlled reviews/merges, captured history and incremental web/desktop/mobile delivery.

## Findings and disposition

| Review finding | Disposition | Revised contract and location |
|---|---|---|
| Universal provider contract before evidence | Corrected | [M0-09](01-m0-foundation/step-09-provider-feasibility-gates-and-evidence-matrix.md) defines minimum usable modes; [foundation 14](00-foundations/14-provider-evidence-matrix.md) records per-operation evidence. Unsupported mandatory operations block the mode; optional unsupported features are disabled. |
| Claude hook/tool and headless approval assumptions | Corrected | M0-09 and M1-05 separate interactive/headless experiments, tool payloads and permission hosting. Exact protocol support stays unverified. |
| Codex transport and TUI equivalence | Narrowed | M1-06 uses a pinned schema, labels managed transcript panes, and treats exec as a separate execution. Socket existence does not establish reconnect semantics. |
| Antigravity downstream dependency and terms | Deferred | ADR-008 gates technical support and written terms resolution; a checkbox alone cannot enable it. M1-07 is excluded from required release dependencies. Soft-denial with exit 0 cannot prove task success; headless usage probing remains unverified. |
| Kimi/OpenCode generic Claude-style interfaces | Corrected | M10-04 prioritizes Wire/ACP evaluation; M10-05 prioritizes the local server API and per-backend capabilities. Illustrative invented hook manifests removed. |
| 1. Universal prompt answers/acknowledgement | Narrowed | M1-11 and foundation 04/05 define pending/submitted/acknowledged/expired/cancelled/delivery_uncertain. Echo and unrelated events cannot acknowledge; expired answers and unsafe retries are refused. |
| 2. tmux lifecycle/adoption | Corrected | Existing M1-01/02 retained-pane/metadata corrections preserved; M0-09 tests client disconnection separately from durable child exit. |
| 3. ULID prefix collisions | Corrected | M3-07 uses the full task identifier or checked full-ID hash; same-timestamp and forced-collision tests; external-service isolation requires application cooperation. |
| 4. Non-code task success | Corrected | M3-03 declares deliverables and acceptance evidence; report/review/investigation can succeed without file changes. Turn completion, process exit and task success are separate. |
| 5. Validation and merge revision | Corrected | M3-03/05 bind clean-checkout validation, review and human approval to recorded revisions; test the integration candidate and promote with expected-target precondition. M3-06 rechecks remote head/base/checks. Missing required tests block. |
| 6. Review independence identity | Corrected | ADR-022/M3-04 separate integration, publisher/family, endpoint and billing identity. Unknown or degraded identity cannot silently satisfy independence. |
| 7. Incompatible quota units/buckets | Corrected | M4-01 retains typed observations and consumption; adds overlap/cursor and credential-context rules. M4-04 refuses mismatched-unit estimates. No invented reset allowance. |
| 8. Hard spending cap | Removed | ADR-021/M4-04 define atomic admission reservations, late settlement and visible overshoot. External billing caps are not promised. |
| 9. Zero lost prompts | Removed | M5-05 separates persisted accounting, downtime capture, reconnection, answerable recovery and delivery uncertainty, with a fault-boundary matrix. No exactly-once external-effects claim. Stable file paths are retained. |
| 10. Historical filesystem replay | Narrowed | M5-04 uses recorded commits or explicit checkpoint hashes; current worktrees do not prove old uncommitted state. Missing segments/fields are visible. |
| 11. Automatic recovery reversibility | Narrowed | M6-04 requires fresh quiescence, replay-safe checkpoint, no uncertain effect and fenced ownership before restart/reroute. Otherwise human escalation. |
| 12. Duplicate desktop supervisors | Corrected | Existing ADR-020/M0-04/M7-01 single-owner lock and coordinated upgrade design preserved; helpers rediscover the endpoint. |
| 13. Instruction cleanup/committed managed content | Corrected | M8-08 prefers session-local instructions, preserves concurrent edits, rejects cleanup conflicts and inspects all submitted commits. Git ignore is not protection. M3-03 applies the boundary to TASK/RESULT files. |
| 14. Enterprise execution and human gates | Narrowed | ADR-019/M9-01 declare trusted shared-team v1. Per-user process/credential/filesystem isolation is deferred. M9-04 requires human actor identity; M3-05 blocks unsupported four-eyes gates rather than degrading. |
| 15. Plugin trust/sandboxing | Narrowed/deferred | ADR-014/M10-03 allow trusted code only; community artifacts remain inert/quarantined before import or harness execution. Untrusted hosting requires a future isolated process boundary. |
| 16. Postgres/Kubernetes | Corrected | ADR-010/016/M9-05 preserve shipped SQLite migrations and add a separate Postgres history plus repository/search contracts. M9-06 distinguishes access mode, storage topology and agent process loss. |
| Domain dependency inconsistency | Retained correction | Existing M0-01/02 allowlisted pure dependencies are preserved; no framework/infrastructure import into domain. |
| Event identity collisions | Corrected | M0-05, downstream Chat and M5 inbox include provider/session/source generation and source event identity. Unknown identity is quarantined. |
| MCP request identity/revision | Corrected | M2-05 retains persistent request handles/polling and adds payload conflict detection, verified base negotiation and safe owned-entry config cleanup. |
| Skills versus executable eval fixtures | Corrected | M8-04/05 separate instruction bundles from trusted pinned EvaluationEnvironment artifacts; installation does not execute evaluation code. |
| Causal claims from learning scores | Narrowed | M8-06 defaults to shadow proposals. Held-out evaluation and a human-approved policy version are required before routing changes. Sample thresholds alone are not proof. |
| KPI mismatch | Corrected | [Foundation 15](00-foundations/15-kpi-contract.md) owns definitions, denominators, missing data and query contracts. M4-07 implements them; M10-08 archives evidence. Total usage and cheap routing share cannot substitute for productive utilization. |
| Dependency/order drift | Corrected | Explicit prerequisites now agree in ROADMAP, step headers and milestone tables. [DEPENDENCIES.md](DEPENDENCIES.md) is generated and cycle-checked; gated steps cannot become required dependencies. |
| OpenCode credential reads | Corrected | M10-05 forbids reading potentially secret-bearing vendor config; use a verified credential-free projection or manual non-secret metadata. Local control API traffic is distinct from upstream model requests. |
| Mobile stale answers | Retained correction | M7-03 revalidates generation, payload, expiry and authorization on delivery. Unsupported browser actions open the app; no universal push-action parity. |

## Delivery and evidence gates

1. Start from M0-01; M0-09 follows the minimal SDK harness and must prove the selected Claude/Codex modes before adapter implementation. Missing mandatory support blocks that adapter; fake-provider tests cannot clear it.
2. Required local MVP remains M0 + M1: **55.5 working days** of step estimates; **58.5** including optional Antigravity.
3. Reliable orchestration requires declared task artifacts and revision-bound review/merge. Operational maturity adds bounded recovery, history, conservative quotas and platform-specific clients.
4. Enterprise v1 is a trusted shared-team release. Isolated multi-user execution and untrusted plugin execution remain separate future work.
5. Required roadmap estimates sum to **215 working days**; including optional Antigravity and cloud aggregation: **219 days / 43.8 engineer-weeks**. These are effort sums, not forecasts. High-risk contingency is separate; target dates remain unassigned.
6. The final audit needs at least **30 calendar days of real usage** with the relevant instrumentation, starting no earlier than instrumentation readiness (planned at M8 exit). Record actual dates and reset the interval for a materially changed metric. Unknown measurements are never counted as achieved targets.

## Validation performed for this revision

- `node plan/tools/verify-plan.mjs`: **92 step files, 11 milestones, zero structural problems**.
- `node --test plan/tools/verify-plan.test.mjs`: **9/9 tests pass**, including missing file, cycle, gated dependency, ambiguous/unknown prerequisite, header drift, duplicate test ID/effort mismatch and stale generated graph.
- Explicit relative Markdown links in the working plan resolve; no product or provider runtime tests were run.

The verifier checks structure and consistency, not vendor behavior, security isolation or delivery forecasts. Live provider evidence, proposed ADR decisions, Antigravity terms resolution, release identity/license decisions, manual acceptance and the real-usage observation window remain open.
