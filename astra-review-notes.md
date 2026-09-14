# Orchestra — Plan Feasibility Review Notes

Research date: **15 September 2026**  
Reviewed scope: **91 step specifications across 11 milestones**, supporting architecture and planning documents, and current official documentation for important external dependencies.

**Verdict: the core idea is feasible and logical. The full plan is not achievable exactly as written.** Several provider assumptions are incorrect, some requirements contradict each other, and several absolute guarantees exceed what Orchestra can control.

The appropriate decision is **revise the plan before implementation**, while preserving the core architecture.

The existing read-only plan verifier reported **91 steps checked, zero structural problems**. That validates document structure—not technical feasibility. All milestones were marked “Not started” in [PROGRESS.md](PROGRESS.md) at review time.

The original audit changed no project files. This report file was subsequently added at the user's request; no existing plan or implementation files were changed. No providers were installed or live agent workloads executed. This is a design assessment, not runtime certification.

## 1. What is sound and worth keeping

These parts form a credible product:

- A local daemon coordinating official coding CLIs.
- Clean Architecture with provider adapters behind explicit interfaces.
- Separate structured telemetry and terminal rendering.
- Git worktrees for parallel development.
- Deterministic routing, with an LLM proposing plans rather than controlling policy.
- An attention queue for supported approvals and questions.
- Task results, review rounds, merge controls, and PR creation.
- Recorded history, search, and playback of captured events.
- Explicit `unknown` or `estimate` labels for unavailable quota information.
- Versioned provider fixtures and bounded recovery attempts.
- A browser interface, followed by a desktop shell and mobile access.

The main architectural weakness is that the plan designs a **universal provider contract before proving which capabilities each provider actually exposes**.

## 2. Feasibility across the full roadmap

“Feasible with revision” means the milestone's purpose is achievable, but its present specification needs correction.

| Milestone | Coverage | Verdict | What needs to change |
|---|---:|---|---|
| **M0 — Foundation** | 8 steps | Feasible with corrections | Reconcile dependency rules, event identity, and the trust boundary before building shared contracts. |
| **M1 — Live fleet MVP** | 13 steps | Feasible with substantial adapter revision | Prove Claude/Codex interaction modes, correct tmux lifecycle handling, and keep Antigravity genuinely optional. |
| **M2 — Delegation and intelligence** | 9 steps | Feasible with revision | Capability-driven routing is realistic; universal prompt support and reliable long-lived MCP calls need narrower contracts. |
| **M3 — Missions, review and merge** | 9 steps | Feasible with important correctness fixes | Fix non-code task results, isolation identifiers, review identity, and validation of the exact revision being merged. |
| **M4 — Quota and resilience** | 7 steps | Partially feasible as specified | Monitoring and conservative routing are feasible. Exact universal quota prediction, guaranteed availability, and current “hard” budgets are not. |
| **M5 — History and replay** | 6 steps | Feasible within explicit capture boundaries | Captured history can be durable; universal zero-loss interaction recovery and arbitrary historical working-tree reconstruction cannot be promised. |
| **M6 — Self-maintenance** | 7 steps | Feasible as bounded recovery | Detection and known recovery strategies are realistic. Automatic repair of every vendor change is not. |
| **M7 — Everywhere** | 7 steps | Feasible with platform constraints | Resolve daemon ownership during upgrades; define browser-specific notification behavior and stale-answer handling. |
| **M8 — Customization and skills** | 8 steps | Feasible with revision | Fix instruction-file restoration, skill/evaluation packaging, policy precedence, and unsupported claims about learned model quality. |
| **M9 — Enterprise** | 9 steps | Requires architectural expansion | RBAC alone does not isolate users' processes, credentials, or repositories. Storage portability also needs more than driver substitution. |
| **M10 — Ecosystem and launch** | 8 steps | Conditional | Additional adapters and a registry are feasible, but capability parity, untrusted plugin execution, licensing, and release evidence remain gates. |

**No entire milestone is inherently impossible. Several requirements inside them are impossible under the present constraints or unsupported by the proposed design.**

## 3. Provider integration findings

### A. Claude Code: feasible, but the approval contract is incorrect

The [Claude adapter specification](02-m1-mvp-live-fleet/step-05-claude-code-adapter-v1.md) treats `AskUserQuestion` and `ExitPlanMode` as hook events and excludes `updatedInput` from v1.

Current documentation identifies them as **tools** handled through hooks such as `PreToolUse`. Programmatic answers require the correct `updatedInput` payload. In non-interactive mode, these tools also require a permission host; returning `allow` alone is insufficient. [Claude hooks reference](https://code.claude.com/docs/en/hooks)

**Required correction:** specify and verify separate interactive and non-interactive approval flows. Do not make the MVP depend on hook names or answer formats that do not exist.

The official legal documentation does allow end users to authenticate to an unmodified Claude Code binary hosted by another platform, subject to the stated conditions. That supports the plan's native-binary approach; it does **not** authorize collecting users' credentials or reselling their usage. [Claude legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

### B. Codex: feasible; use the documented protocol directly

The [Codex adapter](02-m1-mvp-live-fleet/step-06-codex-adapter-v1.md) should be grounded in a pinned app-server schema.

Current documentation includes structured session control, approvals, native transport options, and account rate-limit methods. Some app-server transport surfaces carry experimental caveats. These need version-specific evidence rather than a broad assumption of stable reconnect behavior. [Codex app-server documentation](https://developers.openai.com/codex/app-server/)

A headless app-server process with its transcript mirrored into a pane is **not an interactive Codex TUI**. The UI must distinguish those execution modes. Switching from app-server to `exec` cannot automatically preserve every pending interaction.

### C. Antigravity: technically possible in part; unresolved release dependency

The [Antigravity step](02-m1-mvp-live-fleet/step-07-antigravity-adapter-v1-opt-in.md) is optional for MVP but becomes required later. Other acceptance criteria also expect all three initial adapters.

That makes an optional, uncertain integration a downstream blocker.

Official headless documentation supports structured output, but rejects `control_request`/`control_response` input events. Tools requiring unavailable approval can be soft-denied while the process still exits successfully. A generic Claude-style control protocol and exit-code-only success detection therefore cannot be assumed. [Antigravity headless documentation](https://www.antigravity.google/docs/cli/headless/)

Its published terms also contain broad restrictions on third-party access, with different terms potentially applying to enterprise access. **The documentation does not settle whether Orchestra's exact wrapper is permitted.** An acknowledgement checkbox does not resolve that question. [Antigravity terms, section 6](https://antigravity.google/terms)

**Required correction:** keep Antigravity disabled and outside mandatory milestone dependencies until both its supported interaction contract and applicable usage terms are resolved.

### D. Kimi and OpenCode: viable candidates, but not generic copies of Claude

Kimi documents a structured Wire protocol and ACP integration. These are credible integration paths. They should be assessed before assuming Claude-like hooks or a structured side channel attached to an independently running TUI. [Kimi Wire documentation](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html)

OpenCode documents a local server API with session management, messages, events, and permission responses. The plan should evaluate that surface rather than primarily describing hypothetical hook equivalents. [OpenCode server documentation](https://opencode.ai/docs/server/)

“One OpenCode adapter” can support many configured backends. It cannot guarantee identical tool quality, context behavior, quotas, or approval semantics across every compatible model.

**Required correction for all providers:** use a capability matrix keyed by **provider + CLI version + execution mode**, with states such as:

- Supported and verified.
- Supported with limitations.
- Manual interaction only.
- Unsupported.
- Unverified.

An unsupported capability should disable the affected feature, rather than invalidate the entire provider.

## 4. Concrete design problems Claude should fix

### 1. Universal prompt handling is stronger than the available interfaces

[M2-03 capability manifests](03-m2-delegation-intelligence/step-03-capability-manifests-v1-full.md) expects broad prompt round-trips and fallback transports.

However, a prompt cannot be reliably answered externally if the provider exposes neither a structured request nor a supported answer channel. Sending terminal keys does not create a reliable acknowledgement protocol.

**Change:** make prompt support conditional. Model answer states explicitly: pending, submitted, acknowledged, expired, cancelled, and delivery uncertain. A subsequent unrelated message or echoed text must not automatically prove that an approval succeeded.

### 2. tmux exit detection and adoption need correction

[M1-02](02-m1-mvp-live-fleet/step-02-pty-port-and-sessionsupervisor.md) maps `%exit` to child-process termination and reads `pane_dead_status` after window closure. It also proposes `show-environment` “per pane.”

The tmux manual defines `%exit` as the **control client exiting**. `show-environment` exposes session/global environments. A destroyed pane cannot reliably supply its former exit status. [tmux manual](https://man.openbsd.org/tmux)

**Change:** define a tested lifecycle mechanism using retained panes or a process wrapper that records exit status durably. Use explicit pane metadata for adoption. Test control-client disconnection separately from agent-process termination.

### 3. Database isolation identifiers will collide

[M3-07](04-m3-missions-review-merge/step-07-parallel-isolation.md) derives database suffixes from the **first eight characters of a ULID**.

ULID's first ten characters encode time, not randomness. Consequently, concurrently created tasks can receive the same database/cache namespace. This is a concrete correctness defect. [ULID specification](https://github.com/ulid/spec)

**Change:** use the full task identifier or a sufficiently long hash of the complete identifier, with a uniqueness check. Add a test creating many tasks at the same timestamp.

Also, injected environment variables only isolate databases if the application and test harness actually honor them.

### 4. Successful research and review tasks would be marked failed

[M3-03](04-m3-missions-review-merge/step-03-task-contract-and-result-collection.md) maps zero changed files to `no_changes`, then to a failed task.

That contradicts the taxonomy's research, review, analysis, and other tasks that can succeed without modifying code.

**Change:** introduce task-specific result requirements: code change, report, review, investigation, validation, or another declared artifact. Determine success from the relevant acceptance criteria.

A finished model turn, a successful CLI exit, and a completed business task must also remain separate concepts.

### 5. Merge approval is not sufficiently bound to tested code

[M3-05](04-m3-missions-review-merge/step-05-review-and-merge-ui.md) permits merging when `tests.passed !== false`, which includes an unknown or missing test result.

Although task results record SHAs, the merge rules do not sufficiently require that the tested, reviewed, approved, and merged revisions are identical.

**Change:**

- Make required validation explicit per task.
- Run validation against a clean checkout of a recorded commit.
- Bind review and human approval to that commit.
- Invalidate approval when the source changes.
- Revalidate the integrated result when parallel changes interact.
- Recheck remote PR head and required checks at merge time.

Tasks that legitimately need no tests should carry an explicit policy decision, not silently pass through `null`.

### 6. “Cross-vendor” review currently means different adapter IDs

[M3-04](04-m3-missions-review-merge/step-04-cross-vendor-review-rule-and-rounds.md) compares provider identifiers.

Claude through its own CLI and Claude through another integration could count as different vendors, despite sharing the underlying model publisher. Conversely, two different publishers accessed through OpenCode could be treated as one.

**Change:** separate integration identity, model publisher/family, endpoint, and billing/quota identity. Define exactly what review independence means.

Cross-vendor review is a useful policy; it does not guarantee correctness.

### 7. Quota accounting mixes incompatible units

[M4-01](05-m4-quota-resilience/step-01-quota-signals-and-windows.md) allows official usage in percentages, credits, requests, or tokens, then adds later token samples to that official value.

Adding tokens to a percentage or credit balance is invalid without a documented conversion.

The same step assumes fixed rollover behavior and stores windows mainly by provider and window kind, which is insufficient for providers with multiple account/model limit buckets.

**Change:** keep quota observations and token consumption as separate typed measurements. Include account and limit-bucket identity. Do not infer a new full allowance unless the provider's reset semantics support that inference.

For Codex, the documented `account/rateLimits/read` and `account/rateLimits/updated` surfaces expose account limit information, including multiple buckets; these should be evaluated directly. [Codex app-server documentation](https://developers.openai.com/codex/app-server/)

The assumed structured, quota-free `agy -p "/usage"` probe is also not established by the cited command documentation, which describes an interactive panel. Treat it as unverified. [Antigravity usage command](https://www.antigravity.google/docs/cli/commands/usage/)

### 8. The proposed “hard” budgets are admission limits

[M4-04](05-m4-quota-resilience/step-04-budgets-and-reserves.md) stops new tasks after a cap is reached but lets running tasks continue. Much of the accounting arrives after task completion.

Therefore, spending can exceed the cap.

**Change:** call this a soft budget or admission budget. Stronger enforcement needs reservations for in-flight work, live accounting where available, cancellation behavior, and a documented overshoot allowance. Orchestra cannot promise an exact external billing cap without provider support.

### 9. “Zero lost prompts” is not demonstrated by the recovery design

[M5-05](06-m5-history-replay/step-05-session-restore-with-zero-lost-prompts.md) replays payloads persisted before the daemon died. That does not cover requests first emitted while the daemon is unavailable.

Its loss metric also counts expired or cancelled prompts as recovered. That can demonstrate state accounting while the user's original interaction is no longer answerable.

**Change:** define distinct guarantees for:

- Persisted event durability.
- Capture during daemon downtime.
- Reconnecting to a surviving agent.
- Resuming a terminated agent.
- Recovering an unanswered approval.
- Avoiding duplicate external actions.

Where needed, use a surviving session gateway with a durable inbox/outbox. Do not claim exactly-once external delivery unless the provider supports the required acknowledgement and idempotency semantics.

### 10. Historical playback is feasible; arbitrary filesystem time travel is not

[M5-04](06-m5-history-replay/step-04-timeline-and-replay-ui.md) offers a working-tree diff at a historical time when the worktree still exists.

A current worktree does not contain every previous uncommitted state.

**Change:** offer recorded terminal/event replay and commit-based history. Historical uncommitted state requires explicit snapshots or checkpoints. Label capture gaps and unsupported transcript fields.

Likewise, best-effort redaction cannot support an absolute promise that arbitrary secrets never enter recordings.

### 11. Automatic remediation is not always reversible

[M6-04](07-m6-self-maintenance/step-04-remediation-ladder-1-2.md) permits restart/resume with some older unanswered prompts and describes restart, rerouting, and transport changes as safe automatic fixes.

Restarting a task can duplicate an already completed external action. Returning to the original provider does not undo that action.

The plan already refuses an observed in-flight tool call, which helps, but missing or stale telemetry can make that observation incomplete.

**Change:** reserve automatic restart for verified quiescent, replay-safe situations. Require explicit handling of uncertain execution, checkpoints, ownership transfer, and old-session revocation. Otherwise escalate to a human.

Known recovery strategies are feasible. Generic repair of arbitrary vendor protocol changes is not.

### 12. Desktop upgrade behavior can create two supervisors

[M7-01](08-m7-everywhere/step-01-tauri-desktop-shell.md) proposes starting another daemon on a different port when the existing daemon version differs.

That conflicts with the single-supervisor model if both daemons share the database, tmux namespace, and session resources. Existing helpers may also retain the old endpoint.

**Change:** define one owner per data directory/runtime namespace, stable endpoint discovery, and a coordinated upgrade protocol. A second daemon is safe only with fully separate resources.

### 13. Instruction injection can enter commits or discard legitimate edits

[M8-08](09-m8-customization-skills/step-08-instruction-fragments-auto-answer-and-notifications-editors.md) appends managed instructions, adds the filename to Git exclusions, then restores the original bytes before result collection.

Two problems:

- Ignore rules do not affect files already tracked by Git.
- Restoring the original bytes can overwrite legitimate edits made during the task.

An agent could also commit the managed block before restoration. [Git ignore documentation](https://git-scm.com/docs/gitignore)

**Change:** prefer documented session-local instruction mechanisms. Where file composition is unavoidable, specify preservation of concurrent edits and validation that managed content cannot enter the submitted commit.

### 14. Enterprise RBAC does not isolate execution

[M9-01](10-m9-enterprise/step-01-rbac.md) controls API permissions, but the broader design runs agents under shared host resources.

Different application users sharing an OS identity, home directory, provider authentication, and tmux access are not securely isolated merely because API responses are filtered.

**Change:** explicitly choose between a trusted shared-team installation and isolated per-user execution. The latter needs separate workers or OS identities, credential contexts, filesystem access, and process boundaries.

There is also an approval ambiguity: agents inherit owner permissions, while [M9-04](10-m9-enterprise/step-04-approval-gates-4-eyes.md) describes human gates. The authorization rule should explicitly require a human actor for human approval; role membership alone is insufficient.

### 15. Plugin provenance does not make plugin code safe

[M10-03](11-m10-ecosystem-launch/step-03-plugin-skill-playbook-registry.md) explicitly accepts running provider plugins inside the daemon without runtime sandboxing.

This risk is acknowledged in the plan, but its consequences conflict with a strong enterprise isolation story. A signature establishes provenance, not harmless behavior. Worker threads alone would not establish a security boundary either.

**Change:** make v1 trusted-plugin-only, or introduce an appropriately isolated plugin process before supporting untrusted community code. Do not defer the trust decision until a plugin reaches an installation-count threshold.

### 16. PostgreSQL and Kubernetes need more precise contracts

[M9-05](10-m9-enterprise/step-05-postgres-s3-drivers.md) must accommodate SQLite-specific migrations, generated columns, JSON functions, full-text search, and concurrency behavior.

**Change:** plan dialect-specific migrations and repository contract tests. Equivalent search functionality is realistic; identical ranking across different search engines is not a sound universal acceptance criterion.

[M9-06](10-m9-enterprise/step-06-container-and-helm.md) incorrectly links persistent-data survival to RWO storage returning to the same node. `ReadWriteOnce` describes mount access, not whether storage is node-local. Persistence depends on the storage class, backing volume, and lifecycle policy. [Kubernetes persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)

Also distinguish losing a running agent process from losing its persisted worktree.

## 5. Additional inconsistencies to reconcile

| Area | Problem | Required revision |
|---|---|---|
| Domain dependencies | M0-01 prohibits imports outside core, while M0-02 requires runtime Zod/neverthrow usage. | Define the permitted dependency boundary precisely. |
| Event identity | M0-05 deduplicates by channel and external ID; IDs can repeat across provider sessions. | Include provider/session identity and an appropriate source sequence or cursor. |
| MCP recovery | M2-05 assumes a retry can reconnect a parked question, but its question contract lacks a clear stable request identity. | Persist an explicit request handle and define retry/timeout semantics. |
| MCP compatibility | The plan defers protocol verification while specifying transport behavior. | Pin a supported revision per client. The current MCP release changes elicitation and task mechanisms; do not assume all CLIs implement it. [Official MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) |
| Skills/evals | Allowed skill artifact formats and proposed executable/repository evaluation fixtures do not align. | Separate instruction packages from trusted evaluation environments. |
| Learning loop | Small observational samples and model-generated review scores do not establish causal model superiority. | Start with visible heuristics and shadow evaluation; require evidence before automatic routing changes. |
| KPI definitions | Some release queries measure a different quantity from the stated goal—for example cheaper-task share versus productive quota utilization. | Give each KPI one definition, denominator, query, and treatment of missing data. |
| Dependency order | Numbered order, step dependencies, and parallel milestone diagrams are not fully consistent. | Generate and validate the actual dependency graph. |
| OpenCode credentials | Reading a configuration file and then removing secret fields still reads those values into memory. | Distinguish “never reads credentials” from “never persists/exposes credentials,” or use a safe provider-produced projection. |
| Mobile actions | A queued offline answer can become stale before delivery. | Revalidate prompt generation, session state, expiry, and authorization before applying it. |

The plan already recognizes several limitations—unknown quota, browser push fallbacks, imperfect redaction, tamper-evident auditing, and human-assisted repair. Those qualifications should be preserved and propagated into the headline requirements and acceptance criteria.

## 6. Promises that should be replaced

| Current ambition | Defensible requirement |
|---|---|
| “Every coding CLI works fully” | Supported capabilities for explicitly tested CLI versions and modes. |
| “Never blocked” | Reduce avoidable interruptions; pause clearly when no eligible capacity exists. |
| Exact universal remaining quota | Official observations where exposed; otherwise estimates or unknown. |
| Hard spending caps with ongoing tasks | Admission limits with documented in-flight overshoot, unless provider enforcement exists. |
| Zero lost prompts in every failure | Durable captured prompts, explicit recovery outcomes, and declared failure boundaries. |
| Complete historical working-tree replay | Recorded commits and explicitly captured snapshots. |
| Automatic repair of vendor changes | Bounded recovery for known failures, followed by human escalation. |
| Guaranteed correct model selection | Explainable routing evaluated against measured outcomes. |
| Seamless cross-provider continuation | A new execution using an explicit handoff package; hidden provider state is not transferable. |
| Absolute secret-free recording | Defined capture exclusions, redaction, restricted access, and documented residual limitations. |

## 7. Scope and timeline assessment

The individual step estimates total:

| Scope | Planned effort |
|---|---:|
| M0 + M1 MVP | **53.5 working days** |
| Full M0–M10 roadmap | **213 working days** |
| Full roadmap at five working days/week | **42.6 engineer-weeks** |

These are sums of the plan's estimates, not independently validated delivery forecasts.

For one engineer, this is already a substantial multi-month product. The current estimates are optimistic around provider integration, recovery correctness, desktop packaging, enterprise isolation, and plugin security.

Parallel implementation can reduce some elapsed time, but cannot remove shared-contract dependencies or external validation requirements. The final audit also requires at least 30 days of real usage evidence; that observation window should be scheduled explicitly, potentially overlapping other work.

A more logical release sequence would be:

1. **Provider feasibility gates:** prove supported Claude and Codex modes, approvals, cancellation, usage signals, and restart behavior.
2. **Local MVP:** fleet, worktrees, terminal/transcript views, supported attention prompts, and simple delegation.
3. **Reliable orchestration:** task-specific results, dependency scheduling, review, immutable validation evidence, and controlled merges.
4. **Operational maturity:** bounded recovery, history, conservative quota handling, desktop/mobile access.
5. **Separate enterprise and ecosystem releases:** user isolation, untrusted plugin execution, additional providers, and distribution.

Basic authentication, policy protection, and safe process ownership belong in the foundation; they should not wait for the enterprise milestone.

## 8. Handoff instructions for Claude

You can give Claude this report with the following direction:

> Revise the Orchestra plan without implementing the product. Preserve its local-first architecture, official-CLI boundary, deterministic policy engine, and provider adapters.
>
> Correct the concrete defects identified in this report. Replace unsupported universal guarantees with measurable, capability-specific requirements. Add a provider evidence matrix containing official source, tested CLI version, execution mode, supported operations, unsupported operations, and required acceptance tests.
>
> Make Antigravity genuinely optional until its technical and terms questions are resolved. Separate the local MVP from enterprise isolation and untrusted-plugin support.
>
> Reconcile all affected foundations, ADRs, step specifications, dependencies, tests, milestone exit criteria, KPI definitions, roadmap estimates, and progress records. Do not mark an assumption verified merely because a fake-provider test passes.
>
> Produce a change summary showing which requirements were retained, corrected, narrowed, deferred, or removed, and explain why.
