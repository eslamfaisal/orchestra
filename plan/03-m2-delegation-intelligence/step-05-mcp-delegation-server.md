# Step M2-05 — MCP delegation server

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M2-04, M1-11 |
| Estimated effort | 3 days |
| Packages touched | `apps/daemon`, `apps/cli`, `packages/core`, `packages/sdk`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, `apps/web` |
| Risk | High |
| Owner | |

## 1. Goal
After this step any session started with role *Lead* gets an Orchestra MCP server wired into its own MCP config before launch, and the Lead agent can call five tools — `capabilities()`, `delegate(TaskSpec)`, `status(taskId)`, `collect(taskId)`, `ask_user(question)` — to route work through the M2-04 assignment engine and the M1-12 execution path without the user typing anything. Delegations that spend quota surface as a confirm `AgentPrompt` in the Attention queue with the routing preview attached (C10); `ask_user` surfaces as a question prompt in Attention and Chat and returns the user's answer to the Lead. Every tool call is Zod-validated, scoped to one session by a per-session token, and written to `audit_log` with `actor.kind = 'agent'`.

## 2. Why
- D3: the Lead is the LLM half of the two-tier design; MCP is the only official, vendor-neutral channel through which it can reach the deterministic engine. Without it M3-02 (mission lifecycle) has nothing to launch.
- D4/C2: MCP is a documented, local, official surface of each CLI — no vendor API calls, no relay, no private endpoints. The daemon only writes a config file the vendor documents and speaks stdio JSON-RPC to a process the vendor's own binary spawned.
- D14: `ask_user` is a stop-and-ask and therefore becomes a durable `AgentPrompt` with a typed transport, not an in-memory promise — it must survive a daemon restart.
- C10: a Lead spending quota on another provider is exactly "a spend action"; it is previewed (the M2-04 decision), permissioned (confirm prompt or policy auto-approve), and audited.
- G1/G3: one place to see and approve what agents ask of each other; cross-vendor review becomes reachable by an agent, not only by the UI.

## 3. Scope
### In scope
- `OrchestraMcpServer` (`@modelcontextprotocol/sdk`) in `apps/daemon/src/interface/mcp/`, one instance per Lead session, with the five tools and Zod input/output schemas.
- `orch mcp serve --session <id>` stdio bridge in `apps/cli` (transport only, no tool logic) + streamable-HTTP endpoint `POST /mcp` behind `features.mcpHttp` for CLIs configured that way.
- Per-session registration through `Launcher.preLaunchFiles()` (the daemon writes the MCP config file named by `manifest.paths.mcpConfig`) and a per-session token in the child env allowlist.
- `LeadTokenRegistry`: mint/verify/revoke session-scoped tokens, 0600 files under `~/.orchestra/mcp/`.
- Approval path: `delegate` → `RoutingDecision` (M2-04, dry-run) → confirm `AgentPrompt` (M1-11) → on approve, `DelegateTask` use case (M1-12 execution path).
- `ask_user` via the deterministic **return-based** strategy (tool returns when answered / times out), with MCP **elicitation** and the **tasks** extension as opt-in strategies behind flags.
- Guardrails: per-Lead concurrent delegation cap, delegation depth 1, per-tool rate limit, task-type allowlist from policy, budget check.
- Audit rows + `mcp.*` events; Attention list items for Lead requests.
### Out of scope (deferred to …)
- Mission decomposition, playbooks, plan approval, multi-round review orchestration → M3-01/M3-02/M3-04. `delegate` in M2 creates a **standalone task**, never a mission.
- `collect` returning review findings, PR links or test reports → M3-03 (result contract v2). M2 returns the M1-12 shape only.
- Lead handoff on quota exhaustion → M4-05.
- Recursive delegation (a delegated agent delegating further) → M3-02 with explicit depth policy.
- RBAC on who may be a Lead → M9-01 (single-user no-op guard until then).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `LeadSession` is not a new aggregate: it is a `Session` with `role = 'lead'` (new nullable column, §4.3). Only a session with that role may hold a valid MCP token.
- `DelegationRequest` VO (`packages/core/src/delegation/`): `{ requestId, leadSessionId, taskSpec, decision, state: 'pending_approval'|'approved'|'rejected'|'running'|'done'|'failed'|'cancelled', createdAt }`. State transitions mirror the `Task` machine (`04 §2`) and never skip `pending_approval` unless a policy rule auto-approves.
- Rules:
  - A `delegate` call is rejected (`Err(PolicyDenied)`) when the task type is not in `policy.lead.allowedTaskTypes`, when the Lead already has `maxConcurrentDelegations` active, or when the mission/task budget is exhausted.
  - Depth: a task created by `delegate` gets `delegation_depth = lead.depth + 1`; in M2 the executing session never receives an MCP config, so depth cannot exceed 1.
  - Idempotency: every tool call carries `idempotencyKey` (client-supplied or derived from `(sessionId, tool, argsHash)`); a repeat returns the first result rather than delegating twice.
  - `ask_user` maps to `AgentPrompt {kind:'question', answerTransport:'mcp-return'}` — a new transport id registered in the M1-11 transport DI map, so the Attention UI needs no special case.
  - Token rules: bound to one `sessionId`, minted at launch, revoked on `session.stopped|crashed`, never logged (redaction serializer), never returned by any API.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/interface/mcp/tools.schema.ts  (Zod at the edge — C: validation at edges)
export const DelegateInput = z.object({
  goal: z.string().min(8).max(4000),
  taskType: z.string(),                                  // validated against TaxonomyPort
  variants: z.record(z.string()).optional(),
  language: z.string().optional(),
  acceptance: z.array(z.string()).max(20).optional(),
  contextPaths: z.array(z.string()).max(50).optional(),  // repo-relative, traversal-checked
  constraints: z.object({ sandbox: z.string().optional(), maxMinutes: z.number().int().positive().optional() }).optional(),
  preferRef: z.string().optional(),                      // hint only; engine may reject it
  idempotencyKey: z.string().max(200).optional(),
});
export const DelegateOutput = z.object({
  taskId: z.string(), state: z.enum(['pending_approval','assigned','running']),
  decision: z.object({ chosen: z.string(), score: z.number(), reasons: z.array(z.string()), alternatives: z.array(z.string()) }),
  pollAfterMs: z.number().int(),
});
export const StatusOutput = z.object({
  taskId: z.string(), state: z.string(), assigned: z.string().nullable(),
  progress: z.object({ lastEventAt: z.string().nullable(), summary: z.string().nullable() }),
  openPrompts: z.array(z.object({ promptId: z.string(), kind: z.string(), title: z.string() })),
});
export const CollectOutput = z.object({                  // M1-12 TaskResult shape only (M3-03 extends)
  taskId: z.string(), verdict: z.enum(['succeeded','failed','cancelled']),
  branch: z.string().nullable(), diffStat: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).nullable(),
  summary: z.string().nullable(), testsPassed: z.boolean().nullable(), artifacts: z.array(z.string()),
});
export const AskUserInput = z.object({
  question: z.string().min(3).max(2000),
  options: z.array(z.object({ id: z.string(), label: z.string() })).max(10).optional(),
  allowFreeText: z.boolean().default(true),
  timeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
});
export const AskUserOutput = z.object({
  promptId: z.string(), state: z.enum(['answered','timeout','cancelled']),
  answer: z.object({ optionId: z.string().optional(), text: z.string().optional() }).nullable(),
});

// apps/daemon/src/interface/mcp/orchestra-mcp.server.ts
export class OrchestraMcpServer {                        // interface layer: maps Result → MCP error/content
  constructor(private readonly deps: {
    capabilities: GetLeadCapabilities; delegate: DelegateFromLead; status: GetTaskStatus;
    collect: CollectTaskResult; askUser: AskUserFromLead; audit: AuditPort; clock: Clock;
  }) {}
  forSession(sessionId: SessionId): McpServer;           // fresh registration per Lead session
}

// apps/daemon/src/application/delegation/*.use-case.ts   (one use case per class)
export class DelegateFromLead {
  execute(cmd: { leadSessionId: SessionId; input: DelegateInputDto; idempotencyKey: string }):
    Promise<Result<DelegateOutputDto, PolicyDenied | NoEligibleCandidate | TaxonomyUnknown | BudgetExhausted>>;
}
export class AskUserFromLead {
  execute(cmd: { leadSessionId: SessionId; input: AskUserInputDto }):
    Promise<Result<AskUserOutputDto, PromptCancelled | SessionNotFound>>;   // resolves on answer / timeout
}

// packages/sdk — new answer transport id, implemented in the daemon's transport registry
export type AnswerTransport = … | 'mcp-return';
```
`capabilities()` output (read-only, quota-free — the Lead's map of the world):
```jsonc
{ "hostId": "…", "taskTypes": [{ "id": "test-gen", "label": "…", "risk": "low", "reviewRequired": true, "variants": {…} }],
  "providers": [{ "id": "codex", "cliVersion": "…", "verified": true, "auth": "logged_in",
                  "models": [{ "ref": "codex/gpt-5-codex", "costTier": 3, "bestFor": ["feature-impl"], "deprecated": false }],
                  "window": "healthy", "freeSessions": 2 }],
  "policy": { "allowedTaskTypes": ["…"], "maxConcurrentDelegations": 3, "requiresApproval": true },
  "limits": { "maxGoalChars": 4000, "pollAfterMs": 3000 },
  "catalogVersion": "…", "policyVersion": "…" }
```

### 4.3 Data / schema changes
- Migration `m2_05_delegation`: `sessions.role TEXT NULL` (`lead|implementer|reviewer`); `tasks.origin TEXT NOT NULL DEFAULT 'ui'` (`ui|cli|mcp`), `tasks.requested_by_session_id TEXT NULL`, `tasks.delegation_depth INTEGER NOT NULL DEFAULT 0`, `tasks.idempotency_key TEXT NULL` with unique index `(requested_by_session_id, idempotency_key)`.
- `agent_prompts` reused unchanged for both the delegate-confirm prompt (`kind = 'confirm'`, `payload_json` = the `RoutingDecision`) and `ask_user` (`kind = 'question'`, `answer_transport = 'mcp-return'`).
- New event types (extending `04 §3`): `mcp.session_registered {sessionId, tools[]}`, `mcp.tool_called {sessionId, tool, ok, durationMs, idempotencyKey}`, `mcp.tool_denied {sessionId, tool, reason}`. Every mutating tool also writes an `audit_log` row (`action: 'mcp.delegate' | 'mcp.ask_user'`, `actor = {kind:'agent', id: sessionId}`, before/after redacted).
- No token is ever stored in the DB; `~/.orchestra/mcp/<sessionId>.token` (0600) plus an in-memory hash map is the only store.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Registration**: `SessionSupervisor.start()` (M1-02) already writes `Launcher.preLaunchFiles()`. For `role = 'lead'` the daemon appends an Orchestra entry to the file at `manifest.paths.mcpConfig` — command `orch`, args `["mcp","serve","--session","<id>"]`, env `{ ORCH_MCP_TOKEN: <token>, ORCH_DAEMON_URL: "http://127.0.0.1:4300" }` — merging into (never overwriting) the user's existing MCP servers; the original file is backed up to `<file>.orchestra.bak` and restored on session stop.
- **Transport**: the vendor CLI spawns `orch mcp serve`, which is a ~150-line stdio↔loopback bridge (`StdioServerTransport` on one side, authenticated streamable HTTP to the daemon on the other). All tool logic stays in the daemon so there is one audit path and one source of state. `features.mcpHttp` instead points a CLI's config directly at `POST /mcp` where the vendor supports HTTP MCP servers *(verify per provider docs at step start)*.
- Child env stays on the allowlist (`09-engineering-standards.md`): `PATH HOME TERM LANG` + `ORCH_MCP_TOKEN` + `ORCH_DAEMON_URL` + provider-required vars. Nothing else is inherited.
- Execution of an approved delegation reuses M1-12 unchanged: worktree from `WorktreeManager` (M1-03) → session via `SessionSupervisor` → result extraction. The MCP layer never touches tmux or git directly.
- Egress: loopback only; the `no-vendor-endpoints` ESLint rule and the M0-08 egress test cover the new module (C2).

### 4.5 API / UI surface
- MCP tools (the real "API" of this step): `capabilities`, `delegate`, `status`, `collect`, `ask_user`. Tool descriptions are written for an LLM reader and pinned by a snapshot test so a wording change is a reviewed diff.
- HTTP: `POST /mcp` (streamable HTTP, token-authenticated, flag-gated); `GET /api/sessions/:id/delegations` → the Lead's requests with their decisions; `POST /api/delegations/:id/approve|reject` (also reachable through the normal Attention answer route).
- WS: `mcp.*` events on the `sessions` topic; delegation prompts arrive on the existing `prompts` topic so Attention needs no new subscription.
- UI: Attention gains two item renderers — **Lead requests delegation** (goal, task type, chosen model + score + top reason, alternatives, Approve / Approve & always for this task type / Reject) and the existing question card for `ask_user`. Both reuse M1-11 components; the delegation card embeds the M2-06 preview component when it lands (order-independent: whichever ships first owns the component).
- CLI: `orch mcp serve --session <id>` (internal, not documented for users) and `orch delegations list|approve|reject`.

### 4.6 Flow / sequence
```
Fleet "Start session… role: Lead" ─▶ SessionSupervisor.start()
   ├─ LeadTokenRegistry.mint(sessionId) ─▶ ~/.orchestra/mcp/<sid>.token (0600)
   ├─ preLaunchFiles() + orchestra MCP entry merged into manifest.paths.mcpConfig
   └─ launch claude|codex|agy in tmux ─▶ CLI spawns `orch mcp serve --session <sid>` ─▶ emit mcp.session_registered

Lead: capabilities()  ─▶ bridge ─▶ daemon ─▶ Taxonomy+Catalog+Manifest+Windows ─▶ JSON (no quota spent)
Lead: delegate({goal, taskType:'test-gen'})
   ─▶ Zod ─▶ DelegateFromLead ─▶ policy/budget/concurrency checks
        ├─ denied ─▶ mcp.tool_denied ─▶ MCP error with reason (Lead may re-plan)
        └─ ok ─▶ PreviewAssignment (M2-04, dryRun) ─▶ Task(draft, origin=mcp)
              ─▶ AgentPrompt(kind=confirm, payload=decision) ─▶ Attention (+ push, M7-03)
              ─▶ return {taskId, state:'pending_approval', pollAfterMs}
user Approve ─▶ AnswerPrompt (M1-11) ─▶ DecideAssignment (real) ─▶ task.assigned
              ─▶ M1-12 path: worktree ─▶ session on chosen provider ─▶ task.running
Lead: status(taskId) ──(poll)──▶ {state, progress, openPrompts}
Lead: collect(taskId) ─▶ task done? ─▶ {branch, diffStat, summary, testsPassed} : {state:'running'} error
Lead: ask_user({question, options})
   ─▶ AgentPrompt(kind=question, transport='mcp-return') ─▶ Attention + Chat
   ─▶ tool call parked (long-poll ≤ timeoutMs) ─▶ answered ─▶ {state:'answered', answer}
                                               └─ timeout ─▶ {state:'timeout'} (prompt stays open, Lead may re-ask)
daemon restart mid-ask ─▶ prompt re-derived from DB (M1-11/M5-05); bridge reconnects; Lead's retry returns the stored answer
```

## 5. Tasks
- [ ] Add `@modelcontextprotocol/sdk` (pinned, `minimumReleaseAge` respected) and record the spec revision the tools target in the module header.
- [ ] `packages/core/src/delegation/`: `DelegationRequest` VO + state machine + policy rules (caps, depth, allowed task types) with unit tests.
- [ ] `LeadTokenRegistry` (mint/verify/revoke, 0600 files, redaction) + revocation on `session.stopped|crashed`.
- [ ] MCP config merge/restore in the launch path (`preLaunchFiles` extension per provider; backup file, restore on stop) for claude, codex, agy.
- [ ] `orch mcp serve --session` stdio bridge (no tool logic) + `POST /mcp` streamable-HTTP endpoint behind `features.mcpHttp`.
- [ ] Zod schemas for all five tools + snapshot test on tool names/descriptions/schemas.
- [ ] `GetLeadCapabilities` use case (taxonomy × catalog × manifests × window health × policy).
- [ ] `DelegateFromLead` use case: validation, policy checks, idempotency, `PreviewAssignment`, confirm prompt, task creation with `origin='mcp'`.
- [ ] Approval path: prompt answer → `DecideAssignment` → M1-12 execution; auto-approve rule when `policy.lead.autoApprove` matches (default off).
- [ ] `GetTaskStatus` and `CollectTaskResult` use cases over the M1-12 result shape.
- [ ] `AskUserFromLead`: `mcp-return` transport registered in the M1-11 transport map; long-poll with timeout; restart-safe resolution from the DB.
- [ ] Migrations `m2_05_delegation`; repositories updated; `mcp.*` event schemas + audit interceptor coverage for agent actors.
- [ ] Attention renderers for delegation-confirm and `ask_user`; `GET /api/sessions/:id/delegations`; `orch delegations` commands.
- [ ] Guardrail tests: rate limit per tool, concurrent cap, depth, traversal check on `contextPaths`.
- [ ] Docs: `docs/plugin-guide` draft section "Registering the Orchestra MCP server for a Lead" + `apps/daemon/src/interface/mcp/README.md` listing the tool contract.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M2-05-01 | unit | `DelegationRequest` transitions incl. reject and cancel-on-session-stop | illegal transitions return `Err(IllegalTransition)`; no state lost |
| UT-M2-05-02 | unit | policy rules: task type not allowed / cap reached / depth 1 exceeded / budget exhausted | each returns the matching `PolicyDenied` reason |
| UT-M2-05-03 | unit | `contextPaths` with `../` or absolute paths | rejected before any fs access |
| AT-M2-05-01 | application | `DelegateFromLead` twice with the same `idempotencyKey` | one task, one prompt; second call returns the first result |
| AT-M2-05-02 | application | `AskUserFromLead` answered after 2 s / not answered before timeout | `state: 'answered'` with payload / `state: 'timeout'` and prompt still `open` |
| CT-M2-05-01 | contract | tool schema snapshot + `capabilities()` output against the taxonomy/catalog Zod schemas | no drift; every advertised task type resolves |
| CT-M2-05-02 | contract | launcher contract re-run with a Lead spec for all three adapters | MCP config file written with only the allowlisted command/args/env; original file restored on stop |
| IT-M2-05-01 | integration | FakeProvider Lead driving all five tools over the real stdio bridge | full round-trip; `audit_log` has one row per mutating call with `actor.kind='agent'` |
| IT-M2-05-02 | integration | token of session A used against session B's tools | `401`/MCP auth error; `mcp.tool_denied` emitted; no data leak in the error body |
| IT-M2-05-03 | integration | daemon `kill -9` while an `ask_user` is parked, then restart and answer | prompt re-derived, answer delivered on the Lead's retry; no duplicate prompt |
| IT-M2-05-04 | integration | delegate → reject | task ends `cancelled`, no worktree created, no session started |
| E2E-M2-05-01 | e2e | Playwright + FakeProvider Lead: delegate appears in Attention, approve, task runs to done, Lead collects | Board/Attention update over WS; collected payload matches the M1-12 result |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-05-01 | Lead registration on real Claude Code | 1. Fleet → Start session, provider claude, role Lead 2. In the pane list MCP servers (vendor's own command) | An `orchestra` MCP server is listed with 5 tools; `mcp.session_registered` in the WS stream; the user's pre-existing MCP entries are still present | ⬜ |
| TC-M2-05-02 | capabilities is quota-free and truthful | 1. Ask the Lead to call `capabilities` | Output lists only installed providers with their real CLI versions and only models present in the manifests; no vendor quota consumed beyond the Lead's own turn | ⬜ |
| TC-M2-05-03 | delegate → approve → collect across vendors | 1. Ask the Lead (claude) to delegate a `test-gen` task for a file in `~/orchestra-scratch` 2. Approve in Attention 3. Wait, then ask the Lead to `collect` | Attention card shows chosen model + score + reasons; task runs on the other vendor; `collect` returns branch and diffstat matching `git log` in the worktree | ⬜ |
| TC-M2-05-04 | ask_user round-trip | 1. Ask the Lead to call `ask_user` with options 2. Answer from Attention (or Chat) | Question appears within 2 s with the options rendered; after answering, the Lead echoes the chosen option; prompt state `answered → delivered` | ⬜ |
| TC-M2-05-05 | Negative: policy denial | 1. Set `policy.lead.allowedTaskTypes` to exclude `infra` 2. Ask the Lead to delegate an `infra` task | Tool returns an error naming the policy reason; no task row, no prompt; `mcp.tool_denied` recorded; the Lead can still delegate an allowed type afterwards | ⬜ |
| TC-M2-05-06 | Negative: stolen/stale token | 1. Copy a token file 2. Stop that session 3. Run `orch mcp serve --session <old>` with the copied token | Bridge exits non-zero with an auth error; nothing is delegated; no stack trace or token value in the daemon log | ⬜ |
| TC-M2-05-07 | Restart / resilience | 1. Have the Lead call `ask_user` 2. `kill -9` the daemon before answering 3. Restart the daemon 4. Answer the question | The question is still in Attention after restart; after answering, the Lead receives the answer (directly or on its retry); no duplicate delegation or prompt | ⬜ |
| TC-M2-05-08 | Config hygiene | 1. Note the contents of the Lead provider's MCP config before the session 2. Stop the session 3. Compare | File restored byte-identical to the backup; token file removed; `~/.orchestra/mcp/` contains no orphan tokens | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] A real Claude Code Lead completes `capabilities → delegate → status → collect → ask_user` end-to-end on the scratch repo, with the delegated task running on a different vendor.
- [ ] Every mutating tool call has exactly one `audit_log` row with `actor.kind = 'agent'` and redacted args; no token value appears in any log, event, or API response.
- [ ] No delegation starts a session before an approval (or an explicitly configured auto-approve rule), and the approval card shows the same `RoutingDecision` that is later persisted (C10).
- [ ] Tokens are session-scoped: a token from another session or a stopped session is rejected (IT-M2-05-02, TC-M2-05-06).
- [ ] The Lead's MCP config file is merged, backed up and restored; a session crash leaves no orphan config entry or token file.
- [ ] `ask_user` survives a `kill -9` of the daemon with zero lost prompts (TC-M2-05-07) — the M5-05 guarantee holds for this transport from day one.
- [ ] Guardrails enforced and tested: concurrency cap, depth ≤ 1, per-tool rate limit, task-type allowlist, path traversal.
- [ ] All TC-M2-05-* pass; no new lint/arch violations (incl. the egress test); `PROGRESS.md` updated.

## 8. Risks / open questions
- MCP spec revisions move: **elicitation** semantics and the **tasks** extension for long-running calls are assumed from the spec revision pinned in the module header — *(verify against the MCP specification and `@modelcontextprotocol/sdk` release notes at step start)*. Mitigation: the default `ask_user` strategy is return-based (plain tool result + long poll), which needs neither feature; elicitation and tasks are DI-registered alternative strategies behind `features.mcpElicitation` / `features.mcpTasks`.
- Whether each CLI reads MCP servers from the path in `manifest.paths.mcpConfig`, supports `env` passthrough, and supports HTTP MCP servers is a vendor fact beyond `05-provider-contract.md §3` — *(verify against claude / codex / antigravity docs at step start)*; anything unverified stays out of the manifest and the provider is simply not Lead-capable (`features` lacks `mcp`).
- Codex's control surface is `app-server` (ADR-009, R3): a Codex **Lead** may need a different registration path than a Codex **worker** — *(verify against the generated app-server schema)*. M2 requires only one Lead-capable provider; Codex Lead support may be deferred to M3-02 without blocking this step.
- Long-poll parking of `ask_user` holds an HTTP/stdio request open for up to an hour. Budget: one parked call per Lead, bounded by `maxConcurrentDelegations`; the bridge sends keep-alives. If a CLI's MCP client has a shorter hard timeout, the tool returns `state: 'timeout'` and the Lead is instructed (tool description) to re-call — the prompt stays open, so no answer is lost.
- Tool descriptions are prompt surface: wording changes Lead behaviour. They are snapshot-tested and reviewed like code, but there is no automated way to prove a Lead uses them well (R11) — the M2 demo script is the only behavioural check until M3-02 adds mission-level evaluation.
- Auto-approve is powerful and dangerous; default is off, and the rule format is deliberately minimal here (task type + max cost tier). The full auto-answer/approval policy editor is M8-08, gated by M9-04 for 4-eyes.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
