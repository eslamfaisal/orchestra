# Step M1-11 — Interaction Bridge v1 & Attention queue

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-05, M1-06, M1-08 |
| Estimated effort | 4 days |
| Packages touched | `packages/core` (AgentPrompt rules, PromptClassifier), `apps/daemon/src/application/prompts`, `apps/web` (Attention), `packages/ui` |
| Risk | High (R5) |
| Owner | |

## 1. Goal
Every structurally captured, supported agent stop-and-ask becomes a durable, prioritised `AgentPrompt` (permission · question · planApproval · confirm · login · error) with typed options, payload (tool/command/files/plan text), an `answerTransport`, deadline and fallback. The Attention screen is one queue across all sessions: cards with inline Allow/Deny/Answer/Approve/Edit-and-resend/Reject, keyboard-first, deep-linkable, with delivery acknowledgement states (answered → delivered → acknowledged) and a first conservative auto-answer policy (auto-approve read-only tools only when the user enables it; everything audited).

## 2. Why
D14 (typed durable prompts), G1/G4 (never blocked by a prompt you didn't see), C10 (previewed, permissioned, audited), R5 mitigation; source plan §9.1.

## 3. Scope
### In scope
- Core: `AgentPrompt` aggregate + state machine (from `04-domain-model.md`), `PromptClassifier` (PromptDraft → kind, priority, risk hints: destructive command patterns, file paths outside worktree, network, infra), `AnswerTransport` strategies (DI): `HookResponseTransport`, `AppServerRpcTransport`, `ElicitationTransport` (stub until M2-05), `ManualTerminalTransport` (manual interaction only; terminal echo and unrelated telemetry never acknowledge an answer).
- Use cases: `OpenPrompt` (from pipeline draft; dedupe by provider/session/generation/externalId), `AnswerPrompt` (validate option/text against prompt; choose transport; deliver; on failure → fallback transport; state transitions; audit), `ExpirePrompts` (deadline → default answer per manifest, keep open with fallback), `CancelPromptsForSession`.
- Priority: `login/error` > `permission(destructive)` > `planApproval` > `permission` > `question` > `confirm`; per-session cap on open prompts (oldest auto-superseded when the CLI moved on).
- Attention UI: queue grouped by priority, card per kind (permission: tool + args diff-style; plan: rendered markdown with Approve/Edit & resend/Reject; question: options/free text), badges (session, provider, worktree), states (open/answering/delivered/ack), keyboard (`j/k`, `a` allow, `d` deny, `Enter` answer, `e` edit plan), deep link `/attention/:promptId`, sound/desktop notification toggle (browser Notification API), empty state.
- Auto-answer policy v1 (config `autoAnswer`): `readOnlyTools: off|on`, `denyDestructive: on`, `timeouts: notify-then-wait`; decisions logged as `prompt.auto_answered` with rule id; UI shows "auto" badge and lets the user override if still open.
- Plan cards v1: `planApproval` payload rendered; Edit & resend sends the edited plan as the answer text where the transport allows (Claude `ExitPlanMode` hook response "(verify)") else as a follow-up message via `PaneController.sendCommand`.
### Out of scope (deferred)
- Push to phone → M7-03. Policy editor + escalation rules → M8-08. Approval gates/4-eyes → M9-04. Re-derivation after restart → M5-05 (M1 stores prompts durably; smoke test only).

## 4. Design
### 4.1 Domain
```ts
export interface AgentPrompt { id; sessionId; kind; title; options: PromptOption[]; payload: PromptPayload; answerTransport; fallbackTransport?; state: 'pending'|'submitted'|'acknowledged'|'delivery_uncertain'|'expired'|'cancelled'; priority: 1|2|3|4|5; risk: 'low'|'medium'|'high'; openedAt; deadlineAt?; answer?: PromptAnswer; answeredBy?: {kind:'user'|'policy'|'lead'; id}; externalId }
export type PromptPayload = { tool?: string; input?: unknown; command?: string; files?: string[]; plan?: string; question?: string; raw: unknown }
```
Rules: validate session generation, deadline, current authorization and payload hash before submission. Expired/cancelled prompts reject answers. Only a correlated provider response acknowledges delivery; a timeout after possible delivery becomes `delivery_uncertain`. Retry automatically only with documented provider idempotency and the same request key. A known pre-send failure may use another verified channel; never send through multiple channels after uncertain delivery.
### 4.2 Interfaces / contracts
```ts
export interface AnswerTransportStrategy { readonly id: AnswerTransport; canHandle(p: AgentPrompt): boolean; deliver(p: AgentPrompt, a: PromptAnswer): Promise<Result<Ack, DomainError>> }
export class AnswerPrompt { execute(i: { promptId: string; answer: PromptAnswer; actor: Actor }): Promise<Result<AgentPrompt, DomainError>> }
// REST: GET /prompts?state=open&sessionId=  · POST /prompts/:id/answer  · POST /prompts/:id/cancel ; WS topic 'prompts' (snapshot = open prompts)
```
### 4.3 Data / schema changes
`agent_prompts` (baseline) + migration `0008_prompts_v1.ts`: `priority`, `risk`, `fallback_transport`, `delivered_at`, `acknowledged_at`, `external_id` unique per session.
### 4.4 Infrastructure
Transports call into the hooks registry (M1-08), Codex RPC (M1-06), or the supervisor `PtyPort` (send-keys). Deadline scheduler (in-process, persisted deadlines so restart re-arms).
### 4.5 API / UI surface
Route `/attention`; command palette "Answer next prompt"; browser notifications (opt-in).
### 4.6 Flow
```
pipeline PromptDraft → OpenPrompt (classify, dedupe) → prompt.opened → WS → Attention card
user click Allow → validate pending request → persist submitted answer → transport send → correlated ack or delivery_uncertain
deadline → ExpirePrompts → prompt.expired → no late delivery; native fallback only through a newly validated request
```

### 4.7 Review reconciliation contract (2026-09-15)
Capability checks use provider + exact version + execution mode + prompt kind. A manual-only operation has no programmatic Allow/Answer button. Prompt identity includes provider session generation and external request ID; answer attempts include stable request key, expected payload hash and submitting actor. An HTTP receipt proves local persistence only; provider acknowledgement is separate. Existing open/answered/delivered event names may be retained as compatibility events but project to the six canonical states above.

## 5. Tasks
- [ ] Core: `AgentPrompt` rules, `PromptClassifier` (pure; destructive patterns list; 100 % branch), priority rules; tests.
- [ ] Migration `0008`; `PromptRepository` extensions (open by session, by priority).
- [ ] Transport strategies (4) + registry; `ManualTerminalTransport` with explicit manual-only state.
- [ ] Use cases: `OpenPrompt`, `AnswerPrompt` (with fallback), `ExpirePrompts` (persisted deadlines), `CancelPromptsForSession` (on stop/crash).
- [ ] Auto-answer policy v1 (config + rule engine + audit + override).
- [ ] REST/WS surface; DTOs in sdk.
- [ ] Attention UI: queue, cards per kind, plan card with editor, keyboard, deep links, notifications, empty state, EN/AR.
- [ ] Correlated acknowledgement wiring in the pipeline; persist outbox before send and ack after receipt.
- [ ] E2E with FakeProvider scenarios: `hello-prompt`, `question-multi`, `plan-approval` through both transports.
- [ ] Manual TCs on Claude + Codex (+ agy).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M1-11-01 | unit | classifier: `rm -rf`, `git push --force`, path outside worktree → risk high / priority 2 | as specified |
| UT-M1-11-02 | unit | state machine including rejection of expired/cancelled requests | valid transitions only |
| AT-M1-11-03 | application | AnswerPrompt when primary transport fails | fallback only after proven pre-send failure; uncertain delivery is not retried |
| AT-M1-11-04 | application | duplicate PromptDraft externalId | single prompt |
| AT-M1-11-05 | application | auto-answer readOnly on: `Read` tool prompt | auto allowed, `prompt.auto_answered{rule}`; destructive → left open |
| E2E-M1-11-06 | e2e | fake `plan-approval`: edit & resend | agent receives edited text; card → delivered → acknowledged |
| E2E-M1-11-07 | e2e | keyboard-only answer of 3 queued prompts | all answered; focus order correct |
| IT-M1-11-08 | integration | restart daemon with open prompt (fake) | prompt still open; deadline re-armed; answer works |

### 6.2 Manual test cases (real CLIs)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-11-01 | Claude permission | 1. Claude session: ask to write a file 2. Attention card 3. Allow | card shows tool+path; states open→answered→delivered→acknowledged; file written | ⬜ |
| TC-M1-11-02 | Claude deny | 1. ask to run a shell command 2. Deny with reason | Claude reports denial with the reason text; card acknowledged | ⬜ |
| TC-M1-11-03 | Codex approval | 1. Codex managed: ask to run tests 2. Approve | RPC approval delivered; usage event after turn | ⬜ |
| TC-M1-11-04 | Plan approve/edit | 1. Claude plan mode 2. Edit plan text, resend | Claude continues with edited plan (or receives it as follow-up, per transport); plan version stored | ⬜ |
| TC-M1-11-05 | Expiry + fallback | 1. trigger a permission; wait past deadline 2. answer from Attention | Expired answer rejected; show native manual interaction or request a new prompt with a new generation | ⬜ |
| TC-M1-11-06 | Priority ordering | 1. create a question (fake) and a destructive permission (Claude `rm`) | destructive card first; badges correct | ⬜ |
| TC-M1-11-07 | Auto-answer | 1. enable readOnly auto-approve 2. Claude reads a file | no card; Events shows `prompt.auto_answered`; Attention "auto" history entry | ⬜ |
| TC-M1-11-08 | Session stop cancels | 1. open prompt 2. Stop session | card → cancelled; no dangling deadline | ⬜ |
| TC-M1-11-09 | Restart smoke | 1. open Claude permission 2. `kill -9` daemon, restart 3. Allow | Captured prompt retained; revalidate provider request; lost response becomes delivery_uncertain unless reconnection is verified | ⬜ |

### 6.3 Review regression scenarios
- [ ] Unrelated next message and terminal echo never acknowledge an answer.
- [ ] Expiry, session replacement and role revocation reject queued answers.
- [ ] Crash after send before ack remains delivery_uncertain; no blind fallback or replay.

## 7. Acceptance criteria
- [ ] All six prompt kinds modelled; four transports implemented (elicitation stubbed).
- [ ] Round-trips verified for declared Claude/Codex modes; unsupported modes disabled and manual paths labelled.
- [ ] Attention queue with priorities, keyboard, deep links, notifications, EN/AR.
- [ ] Auto-answer v1 conservative, audited, overridable.
- [ ] Restart smoke passes.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Missing correlation or provider acknowledgement keeps delivery uncertain; it never upgrades from terminal echo or an unrelated message.
- Edited plan resend semantics differ per CLI — document per adapter in manifest `promptProtocol.planApproval.editSupport`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
