# Step M9-04 — Approval gates (4-eyes)

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M9-01, M3-04 |
| Estimated effort | 2 days |
| Packages touched | `packages/core` (`src/gates/`), `packages/catalog` (`schemas/gate-policy.schema.ts`), `apps/daemon` (`src/application/gates`, `src/infrastructure/persistence`, `src/interface/http`, `src/interface/ws`), `apps/web` (Attention gate card, Review/Missions badges, Settings → Policies), `apps/cli` (`orch gate`) |
| Risk | High (a gate that can be bypassed is a false assurance; a gate that deadlocks stops the fleet) |
| Owner | |

## 1. Goal
Policy decides when work must stop and wait for a human decision. When a task is `risk: high`, or its `taskType` is in `{infra, migration, release, security}`, or a merge targets a protected branch, the daemon opens an **approval gate**: the task moves to `blocked/awaiting_approval`, an `AgentPrompt` of the new kind `gate` appears at the top of Attention with the reasons that triggered it and a preview of what will happen, and nothing proceeds until an authorised approver decides. With `fourEyes: true` the requester cannot be the approver. Gates time out into a configured outcome (`escalate` by default, never a silent approve), escalate to a named role or user, and every open/approve/reject/expire/escalate is audited into the M9-03 chain. In single-user mode gates are off by default; turning them on in a solo setup still works (you approve your own gate unless `fourEyes` is set, which would deadlock and is therefore refused at config load).

## 2. Why
- Persona "team lead" needs "policies, budgets, **approval gates**, audit, RBAC" (`00-foundations/01-vision-scope.md`); source plan §17 lists "approval gates (4-eyes option)" as an enterprise pillar.
- C10: "every spend/keys action previewed, permissioned, audited" — M9-01 gave the permission, M9-03 the audit, and this step gives the *preview and hold*, which is also UX principle 5 ("zero-surprise control").
- D3: the deterministic plane, not the LLM Lead, decides when to stop. A gate is a rule over `TaskType`/risk/branch, evaluated in `packages/core`, never a Lead judgement call.
- D14: a gate is a stop-and-ask, so it must be an `AgentPrompt` with a durable state and a transport — otherwise it would be a second, weaker prompt mechanism that does not survive restarts or reach the phone (M7-03).
- M3-01 already defines gate kinds on playbook steps (`lead`, `human`, `4-eyes` — with `4-eyes` degraded to `human` "until M9-04"); this step is the promised implementation.
- G3: cross-vendor review (M3-04) raises quality but cannot authorise a production-affecting change; gates are the human authority layer above review.

## 3. Scope
### In scope
- `Gate` aggregate, state machine, and pure `evaluateGates(context, policy)` rule in `packages/core/src/gates/` (100 % branch).
- New `AgentPrompt` kind `gate` with `answerTransport: 'internal'` (the daemon is the consumer — no vendor channel involved) and priority above permission prompts.
- Gate triggers: task `risk`, `taskType` in a configured set, merge to a protected branch, mission budget breach (from M4-04 `onExhausted`), and an explicit `requiresApproval: true` on a playbook step (M3-01).
- 4-eyes rule (approver ≠ requester), approver-role rule (`gate.approve` permission from M9-01, Lead cannot approve their own request), optional `minApprovals: 1|2`.
- Timeout + escalation: `onTimeout: 'escalate' | 'reject'` (never `approve`), escalation to a role or a named user, repeat interval, maximum escalations.
- `gates` and `gate_decisions` tables; full audit through M9-03.
- Attention gate card (reasons, preview diff/plan/command, Approve/Reject with mandatory reason on reject), Review and Missions badges, blocked-task banner.
- `orch gate list|show|approve|reject` with `--json`.
- Policy authoring in the M8-01 layered settings (`policies.gates`), editable in Settings → Policies (M8-02 editor gains the section).
### Out of scope (deferred to …)
- Approval via phone push — the card is an `AgentPrompt`, so M7-03's PWA push already carries it; no extra work here beyond a payload test.
- Approvals delegated to an external system (ServiceNow/Jira change tickets) — deferred to M10 backlog.
- Break-glass "emergency override" with post-hoc review — deferred to M10 backlog; the only escape today is an Admin editing the policy (audited).
- Signed approvals (per-approver key) — deferred to M9-09's key-management decision.
- Gate evaluation for automations — M9-07 wires its runs through the same use case; the trigger source `automation` is defined here but exercised there.
- Per-file / per-path gates (e.g. "anything under `infra/`") — deferred to M10 backlog; only `taskType`, `risk`, branch and explicit step flags in 1.0.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Gate { id, kind: GateKind, state, subject: GateSubject, reasons: GateReason[], policyId, requesterUserId, requiredApprovals, fourEyes, approvals: GateDecision[], promptId, openedAt, expiresAt?, escalations: number, decidedAt?, outcome? }`.
- `GateKind = 'task_start' | 'task_merge' | 'mission_plan' | 'budget_override' | 'remediation_apply'`.
- `GateSubject = { kind: 'task'|'mission'|'merge'|'repair_case'; id: string; missionId?: string }`.
- `GateReason = { code: 'risk_high' | 'task_type' | 'protected_branch' | 'playbook_step' | 'budget_exhausted' | 'policy_explicit'; detail: string }` — the UI renders these verbatim so a user always knows *why* they were stopped.
- `GateDecision { id, gateId, userId, decision: 'approve'|'reject', reason?, ts, actorRoles }`.
- State machine: `open → approved | rejected | expired | cancelled`; `open → escalated → open` (escalation re-arms the deadline and widens the notified audience without resetting decisions already recorded).
- Pure rules (`packages/core/src/gates/rules.ts`, 100 % branch):
  - `evaluateGates(ctx: GateContext, policy: GatePolicy) → Gate[]` — pure, deterministic, order-stable; returns zero or more gates with their reasons. `ctx` carries `{ taskType, risk, branchTarget?, playbookStep?, budgetState?, missionId?, requesterUserId }`.
  - `canDecide(gate, actor) → Result<void, GateError>`: requires `gate.approve` scope-checked by M9-01; `fourEyes && actor.userId === gate.requesterUserId ⇒ Err(FourEyesViolation)`; an actor who already decided ⇒ `Err(AlreadyDecided)`; a non-`open` gate ⇒ `Err(GateClosed)`.
  - `applyDecision(gate, decision) → Gate` — one reject closes the gate immediately (`rejected`); approvals accumulate until `requiredApprovals` is reached (`approved`).
  - `onDeadline(gate, policy, now) → 'escalate' | 'reject' | 'noop'` — `escalate` while `escalations < maxEscalations`, then the configured terminal outcome; **never** `approve`.
  - Config validity rule (checked at policy load, not at runtime): `fourEyes: true` with fewer than two users holding `gate.approve` ⇒ `Err(FourEyesUnsatisfiable)`, so a solo install cannot configure itself into a deadlock.
- Rule: a gate on `task_start` holds the task in `blocked` with `blocked_reason: 'awaiting_approval'` (the `Task` machine from `04-domain-model.md` §2 already has `blocked`; no new task state). A gate on `task_merge` holds the merge in M3-05/06 exactly where M3-02 described ("evaluated after review approval and before merge").
- Rule: cancelling a mission or stopping a task cancels its open gates (`cancelled`) and the underlying prompt (M1-11's `CancelPromptsForSession` precedent).

### 4.2 Interfaces / contracts
```ts
// packages/catalog/schemas/gate-policy.schema.ts  → PolicySet.gates (M8-01 layer)
export interface GatePolicy {
  enabled: boolean;                                   // default false in local mode, true in team mode
  rules: GateRule[];
  protectedBranches: string[];                        // glob patterns, e.g. ['main', 'release/*']
  defaultTimeout: IsoDuration;                        // default 'PT4H'
  onTimeout: 'escalate' | 'reject';                   // default 'escalate'; 'approve' is not representable
  maxEscalations: number;                             // default 2
  escalateTo: { role?: RoleName; userIds?: string[] };
}
export interface GateRule {
  id: string;                                         // stable id for explainability + audit
  when: { kind: GateKind; taskTypes?: TaskType[]; risk?: ('low'|'medium'|'high')[]; branches?: string[] };
  requiredApprovals: 1 | 2;
  fourEyes: boolean;
  timeout?: IsoDuration;
  approverRoles?: RoleName[];                         // default ['lead','admin'] (must hold gate.approve)
}

// packages/core/src/gates/rules.ts (pure)
export function evaluateGates(ctx: GateContext, policy: GatePolicy): Gate[];
export function canDecide(gate: Gate, actor: Actor): Result<void, GateError>;
export function applyDecision(gate: Gate, d: GateDecision): Gate;
export function onDeadline(gate: Gate, policy: GatePolicy, now: Iso8601): 'escalate' | 'reject' | 'noop';
export type GateError =
  | { code: 'FourEyesViolation'; requesterUserId: string }
  | { code: 'AlreadyDecided'; userId: string }
  | { code: 'GateClosed'; state: GateState }
  | { code: 'NotAnApprover'; missing: Permission }
  | { code: 'FourEyesUnsatisfiable'; approversAvailable: number }
  | { code: 'GateNotFound'; id: string };

// packages/core/src/gates/ports.ts
export interface GateRepository {
  save(g: Gate): Promise<Result<void, RepoError>>;
  get(id: string): Promise<Result<Gate, GateError>>;
  openBySubject(s: GateSubject): Promise<Result<Gate[], RepoError>>;
  listOpen(filter?: { missionId?: string; dueBefore?: Iso8601 }): Promise<Result<Gate[], RepoError>>;
  addDecision(gateId: string, d: GateDecision): Promise<Result<Gate, GateError>>;   // conditional on state=open
}

// apps/daemon/src/application/gates/ — one use case per class
export class OpenGates      { execute(ctx: GateContext, actor: Actor): Promise<Result<Gate[], GateError>>; }
export class DecideGate     { execute(i: { gateId: string; decision: 'approve'|'reject'; reason?: string }, actor: Actor): Promise<Result<Gate, GateError>>; }
export class EscalateGates  { execute(now: Iso8601): Promise<Result<{ escalated: number; closed: number }, GateError>>; }
export class CancelGates    { execute(s: GateSubject, reason: string): Promise<Result<number, GateError>>; }
export class ExplainGate    { execute(id: string): Promise<Result<GateExplanation, GateError>>; }   // rules that fired + policy layer that supplied them
```

### 4.3 Data / schema changes
Migration `0093_approval_gates` (new tables — **not** in `04-domain-model.md` §4, flag for update):
- `gates (id text pk, kind text, state text, subject_kind text, subject_id text, mission_id text null, policy_id text, rule_ids_json text, reasons_json text, requester_user_id text, required_approvals integer, four_eyes integer, prompt_id text null, opened_at text, expires_at text null, escalations integer default 0, decided_at text null, outcome text null)`; indices `(state, expires_at)`, `(subject_kind, subject_id)`, `(mission_id)`.
- `gate_decisions (id text pk, gate_id text, user_id text, decision text, reason text null, ts text, actor_roles_json text, unique(gate_id, user_id))` — the unique constraint is the second line of defence behind `AlreadyDecided`.
- `tasks`: reuse `blocked_reason` (added in M3-02) with value `awaiting_approval`; add `gate_id text null` for the direct link.
- `agent_prompts`: no schema change — `kind` gains the value `gate`, `answer_transport` gains `internal`, `payload_json` carries `{ gateId, reasons, preview }` (M1-11 kept both columns free-form).
- New events (extension of `04-domain-model.md` §3, new `gate.*` namespace): `gate.opened`, `gate.approved`, `gate.rejected`, `gate.expired`, `gate.escalated`, `gate.cancelled`, `gate.denied_decision` (a `FourEyesViolation`/`NotAnApprover` attempt).
- Config: `policies.gates` (the `GatePolicy` above, layered per M8-01), `features.gates: boolean` (default `true` when `auth.mode: team`, `false` in local mode).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- No tmux or network work. The gate does **not** stop the agent process: for `task_start` the gate is evaluated *before* `StartSession` is called, so no pane is ever created; for `task_merge` the gate is evaluated in the merge use case before `git merge`/`gh pr merge` runs. This matters because a held session would burn a concurrency slot (C6) and quota.
- Protected-branch matching uses the same glob helper as the worktree manager's branch naming (M1-03), evaluated against the **target** ref of the merge, resolved from the repo rather than from user input.
- Deadlines are persisted (`gates.expires_at`) and the `EscalateGates` scheduler re-arms them on boot — the same pattern M1-11 used for prompt deadlines, so a restart cannot lose or double-fire a timeout. The scheduler runs at `min(30s, nextDeadline)` granularity and is idempotent (a gate already closed is a no-op).
- Escalation notification reuses the M8-08 notification channels; escalation never changes who *may* decide unless `escalateTo.role` widens it, and widening is recorded as a reason in the audit row.
- Every `DecideGate` call is written to the M9-03 chain with `action: 'gate.decide'`, `outcome: allowed|denied`, the gate id, the rule ids and the decision reason. Denied decisions (4-eyes violations) are audited too — that is the point of 4-eyes.

### 4.5 API / UI surface
| Route | Permission | Behaviour |
|---|---|---|
| `GET /gates?state=open&missionId=` | `audit.read` or `gate.approve` | list with reasons and remaining time |
| `GET /gates/:id` | as above | gate + decisions + `ExplainGate` output |
| `POST /gates/:id/decision` `{ decision, reason? }` | `gate.approve` (+ 4-eyes rule) | 200 gate; 403 `FourEyesViolation` / `NotAnApprover`; 409 `GateClosed`; `Idempotency-Key` honoured |
| `POST /gates/:id/cancel` | `user.manage` | Admin-only abort (audited) |

- The same decision is reachable through `POST /prompts/:id/answer` (M1-11) because the gate is an `AgentPrompt` — both paths funnel into `DecideGate`, so there is exactly one authorisation check.
- WS: topic `gates` (deltas, filtered by M9-01's `VisibilityFilter`) and the existing `prompts` topic for the card itself.
- Web:
  - **Attention** — gate card at priority 0 (above destructive permissions): title "Approval required — `<subject>`", a reasons list rendered from `GateReason.code` with human copy, a preview block (task goal + acceptance for `task_start`; diffstat + target branch + review verdicts for `task_merge`; plan summary for `mission_plan`), approver hints ("needs 2 approvals · you are 1 of 3 eligible"), Approve / Reject (reject requires a reason ≥ 10 chars), a "why am I blocked?" link to `ExplainGate`, and a countdown with the timeout outcome spelled out ("escalates to Admins in 3 h 12 m — never auto-approves").
  - When the viewer is the requester and `fourEyes` is on, the buttons are disabled with the tooltip "You requested this — a second approver is required (4-eyes)". The server still rejects a forced call.
  - **Missions** (M3-08) and **Board** (M2-07): a `status-blocked` badge "awaiting approval" on the task with a deep link to the gate.
  - **Review** (M3-05): the merge button is replaced by "Request approval" / "Awaiting approval (1/2)".
  - **Settings → Policies** (M8-02): the `policies.gates` section with a live "what would be gated" preview over the current task taxonomy, and an inline error when `FourEyesUnsatisfiable`.
  - EN + AR strings; status by icon + text, never colour alone (12-ux).
- CLI: `orch gate list [--open]`, `orch gate show <id>`, `orch gate approve <id> [--reason]`, `orch gate reject <id> --reason <text>`, all `--json`.

### 4.6 Flow / sequence
```
DelegateTask / MissionScheduler about to start a task
  → OpenGates(ctx{taskType, risk, playbookStep, requesterUserId})
      evaluateGates → [] ⇒ proceed to StartSession (unchanged M1/M3 path)
      evaluateGates → [g] ⇒ task.state = blocked(blocked_reason='awaiting_approval', gate_id=g.id)
                            OpenPrompt(kind='gate', priority 0, transport 'internal')
                            gate.opened → ws 'gates' + 'prompts' → Attention card (+ PWA push, M7-03)
                            audit(action='gate.open', reasons, ruleIds)

approver clicks Approve (or POST /prompts/:id/answer)
  → DecideGate → canDecide(gate, actor)
        Err(FourEyesViolation) ⇒ 403 + gate.denied_decision + audit(outcome='denied')
        Ok ⇒ addDecision (unique(gate_id,user_id)) → applyDecision
             approvals < required ⇒ gate stays open, card shows 1/2
             approvals == required ⇒ gate.approved → AnswerPrompt(delivered) → task.state = assigned
                                     → MissionScheduler resumes → StartSession
  → reject ⇒ gate.rejected → task.state = cancelled(reason) → mission continues per playbook onFailure

EscalateGates (every ≤30 s, deadlines persisted)
  → onDeadline == 'escalate' ⇒ escalations++, expires_at += timeout, notify escalateTo, gate.escalated
  → onDeadline == 'reject'   ⇒ gate.expired → task cancelled; never an implicit approve
```

## 5. Tasks
- [ ] `packages/core/src/gates/`: types, state machine, `evaluateGates`, `canDecide`, `applyDecision`, `onDeadline`, `FourEyesUnsatisfiable` validation; table-driven tests to 100 % branch coverage.
- [ ] `packages/catalog/schemas/gate-policy.schema.ts` (Zod) + default policy shipped in `examples/policies/gates.yaml`; loader hooked into the M8-01 precedence chain.
- [ ] Migration `0093_approval_gates` (`gates`, `gate_decisions`, `tasks.gate_id`, indices); Kysely + in-memory repositories + shared contract spec.
- [ ] Use cases `OpenGates`, `DecideGate`, `EscalateGates`, `CancelGates`, `ExplainGate`.
- [ ] `AgentPrompt` kind `gate` + `internal` transport in the M1-11 transport registry (no keystrokes, no vendor channel); priority rules updated so gates sort above destructive permissions.
- [ ] Insertion points: `MissionScheduler`/`DelegateTask` (task_start), merge use case (task_merge, protected branches), `DecidePlan` (mission_plan when the playbook step says so), M4-04 budget breach (budget_override), M6-04 ladder (remediation_apply).
- [ ] Persisted deadline scheduler + boot re-arm; idempotent escalation; notification via M8-08 channels.
- [ ] Audit wiring into M9-03 for open/approve/reject/expire/escalate/denied-decision, including rule ids and the policy layer that supplied them.
- [ ] HTTP `/gates*` routes with M9-01 permissions and `Idempotency-Key`; WS `gates` topic with visibility filtering; unify `POST /prompts/:id/answer` into `DecideGate`.
- [ ] Web: Attention gate card (reasons, preview, counts, countdown, disabled-for-requester state), Missions/Board badges, Review "Request approval" state, Settings → Policies gate section with live preview; EN/AR.
- [ ] CLI `orch gate list|show|approve|reject` with `--json` and documented exit codes.
- [ ] FakeProvider scenario `gate-high-risk.yaml` (a task that triggers `risk_high` and one that triggers `protected_branch`) for E2E.
- [ ] Docs `docs/deployment/approval-gates.md` (policy reference, 4-eyes semantics, timeout behaviour, what a gate does *not* stop).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-04-01 | unit | `evaluateGates` matrix: risk × taskType × branch × playbook flag × policy disabled | exact gate set and reason codes; deterministic order; 100 % branches |
| UT-M9-04-02 | unit | `canDecide`: requester with 4-eyes, requester without 4-eyes, non-approver role, second decision by the same user, closed gate | `FourEyesViolation` / ok / `NotAnApprover` / `AlreadyDecided` / `GateClosed` |
| UT-M9-04-03 | unit | `onDeadline` over escalation counts and both `onTimeout` values | escalate → escalate → terminal; `approve` is unrepresentable (type-level test) |
| UT-M9-04-04 | unit | policy validation with one eligible approver and `fourEyes: true` | `FourEyesUnsatisfiable` at load; policy not applied |
| AT-M9-04-01 | application | `DecideGate` with `requiredApprovals: 2`: two different Leads approve | gate open after the first, approved after the second, task resumes once, exactly one `gate.approved` |
| AT-M9-04-02 | application | concurrent double-approve by the same user (two requests in flight) | one decision row (unique constraint), one `AlreadyDecided` error, no double task start |
| IT-M9-04-01 | integration | high-risk task through the full path with FakeProvider | no tmux pane is created while blocked (`tmux list-panes` count unchanged); pane appears only after approval |
| IT-M9-04-02 | integration | timeout with `onTimeout: 'escalate'`, `maxEscalations: 1`, short timeouts | escalated once (notification sent), then expired; task cancelled; four audit rows in chain order |
| IT-M9-04-03 | integration | restart during an open gate (`kill -9`, restart) | gate still open, deadline re-armed exactly once, no duplicate escalation, prompt still in Attention |
| E2E-M9-04-01 | e2e | Playwright: alice (Lead) delegates an `infra` task, tries to approve her own gate, carol (Admin) approves | alice's buttons disabled with tooltip; forced call 403 `FourEyesViolation`; carol's approval starts the task |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-04-01 | High-risk task gate | 1. Team mode, gates enabled. 2. As alice (Lead), Quick Delegate a task with `taskType: infra` on the scratch repo. 3. Open Attention. | Task shows `blocked · awaiting approval`; the gate card is first in the queue with reasons `task_type=infra` and the rule id; the preview shows the task goal and acceptance; countdown says "escalates to Admins in 4 h — never auto-approves"; no tmux pane exists for the task. | ⬜ |
| TC-M9-04-02 | Negative: requester cannot approve (4-eyes) | 1. From TC-M9-04-01, as alice click Approve. 2. Force the call: `curl -X POST /gates/<id>/decision -d '{"decision":"approve"}'` with alice's token. | UI buttons are disabled with the 4-eyes tooltip; the forced call returns 403 `{code:'FourEyesViolation'}`; `gate.denied_decision` event and an audit row with `outcome: denied` exist; the gate is still `open` with zero decisions. | ⬜ |
| TC-M9-04-03 | Second approver unblocks | 1. As carol (Admin), open Attention, read the gate card, click Approve. 2. Watch Terminals and Board. | Gate → `approved`; the task leaves `blocked`, a session starts, a pane appears; audit chain contains `gate.open` → `gate.decide(approve)` → `gate.approved` in order with carol's user id. | ⬜ |
| TC-M9-04-04 | Protected-branch merge gate | 1. Set `protectedBranches: ['main']`. 2. Take a reviewed, approved task from an M3 mission and click Merge in Review. | Merge is not executed; a `task_merge` gate opens with reason `protected_branch=main`, and the preview shows the diffstat, target branch and both review verdicts; after approval the merge runs exactly once (no double merge on a retried click). | ⬜ |
| TC-M9-04-05 | Timeout escalates, never approves | 1. Set `defaultTimeout: PT1M`, `maxEscalations: 1`, `escalateTo.role: admin`. 2. Open a gate and do nothing for 3 minutes. | At 1 min: `gate.escalated`, a notification to Admins, countdown restarts; at 2 min: `gate.expired`, task cancelled with a readable reason; **nothing was ever auto-approved**; all four transitions are in the audit chain. | ⬜ |
| TC-M9-04-06 | Reject with reason | 1. Open a gate. 2. As carol, click Reject with an empty reason, then with "changes infra outside the mission scope". | Empty reason is refused client- and server-side; the real rejection closes the gate, cancels the task, and the reason text appears in the task's blocked banner, in the mission timeline, and in the audit row. | ⬜ |
| TC-M9-04-07 | Resilience: daemon restart with gates open | 1. Open two gates (one with a 10-minute timeout). 2. `kill -9` the daemon, wait 30 s, restart. 3. Check Attention, `orch gate list --json`, and the escalation at the deadline. | Both gates are still open with their original `openedAt` and `expires_at`; the deadline fires once, not twice or never; approving after the restart works and starts the task. | ⬜ |
| TC-M9-04-08 | Solo-mode guardrail | 1. `auth.mode: local`. 2. Enable gates and set `fourEyes: true` in `policies.gates`. 3. Reload settings. | The policy is refused with `FourEyesUnsatisfiable` (one approver available) and the previous policy stays active; with `fourEyes: false` the gate opens and you can approve it yourself. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `evaluateGates`, `canDecide`, `applyDecision` and `onDeadline` are pure with 100 % branch coverage; `onTimeout: 'approve'` is not representable in the type or the schema.
- [ ] A gate holds work *before* any pane, quota or merge is used (IT-M9-04-01, TC-M9-04-04).
- [ ] 4-eyes is enforced on the server for both the `/gates` and the `/prompts` answer path, with denials audited (TC-M9-04-02).
- [ ] Gates are durable `AgentPrompt`s: they survive `kill -9`, re-arm their deadline exactly once, and are answerable from the phone payload (TC-M9-04-07).
- [ ] Timeouts escalate and then reject; no configuration can produce a silent approval.
- [ ] Every gate transition and every denied decision lands in the M9-03 audit chain with rule ids and the policy layer.
- [ ] Reasons are shown verbatim in Attention, Board, Missions and Review, and `ExplainGate` names the rule and layer that fired.
- [ ] A policy that cannot be satisfied (`FourEyesUnsatisfiable`) is rejected at load, not at runtime.
- [ ] All TC-M9-04-* pass and are recorded.
- [ ] No new lint/arch violations; `docs/deployment/approval-gates.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- Deadlock by construction: a team where every eligible approver is on holiday stalls the fleet. `escalateTo` plus a terminal `reject` bounds it, but the first real team will probably want a break-glass override — deliberately deferred, so watch for it in the milestone log (verify with the first team user).
- Gate fatigue: gating every `infra` task may train people to approve without reading, which is worse than no gate. The default rule set should be narrow (`risk: high` + `release` + protected-branch merges) and the preview must be genuinely informative; revisit the defaults after the first month of real use.
- M3-01's playbook `gate` field already has values `lead | human | 4-eyes`; the mapping from those to `GateRule` must be exact and is not yet written down in M3-01 — coordinate and note the mapping in both files (inconsistency, not fixed here).
- `gates` and `gate_decisions` are not in `04-domain-model.md` §4, and the `gate.*` event namespace is not in §3 — the domain model doc needs an update (not done here), consistent with M9-01/M9-02 flags.
- The `internal` answer transport is new in M1-11's registry; confirm that M1-11's fallback logic (which expects a vendor channel) tolerates a transport with no fallback, or add an explicit `fallback: none` (verify).
- Budget-breach gates (`budget_override`) overlap with M4-04's `onExhausted: 'pause' | 'warn'`; two mechanisms can fight. Proposal: the gate is only opened when the policy sets `onExhausted: 'pause'` **and** `gates.rules` contains a `budget_override` rule; confirm with M4-04's author before implementing.
- Approvals are currently authenticated but not signed, so a database-level attacker could forge one. M9-09 owns the decision on signing approvals with a per-user key; until then the audit chain is the only evidence.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
