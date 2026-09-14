# Step M1-11 — Interaction Bridge v1 & Attention queue

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-05, M1-08 (M1-06/07 plug in as they land) |
| Estimated effort | 4 days |
| Packages touched | `packages/core` (AgentPrompt rules, PromptClassifier), `apps/daemon/src/application/prompts`, `apps/web` (Attention), `packages/ui` |
| Risk | High (R5) |
| Owner | |

## 1. Goal
Every agent stop-and-ask becomes a durable, prioritised `AgentPrompt` (permission · question · planApproval · confirm · login · error) with typed options, payload (tool/command/files/plan text), an `answerTransport`, deadline and fallback. The Attention screen is one queue across all sessions: cards with inline Allow/Deny/Answer/Approve/Edit-and-resend/Reject, keyboard-first, deep-linkable, with delivery acknowledgement states (answered → delivered → acknowledged) and a first conservative auto-answer policy (auto-approve read-only tools only when the user enables it; everything audited).

## 2. Why
D14 (typed durable prompts), G1/G4 (never blocked by a prompt you didn't see), C10 (previewed, permissioned, audited), R5 mitigation; source plan §9.1.

## 3. Scope
### In scope
- Core: `AgentPrompt` aggregate + state machine (from `04-domain-model.md`), `PromptClassifier` (PromptDraft → kind, priority, risk hints: destructive command patterns, file paths outside worktree, network, infra), `AnswerTransport` strategies (DI): `HookResponseTransport`, `AppServerRpcTransport`, `ElicitationTransport` (stub until M2-05), `SendKeysAckedTransport` (keystroke map from manifest/fixtures; ack = next telemetry event or output echo within timeout).
- Use cases: `OpenPrompt` (from pipeline draft; dedupe by externalId), `AnswerPrompt` (validate option/text against prompt; choose transport; deliver; on failure → fallback transport; state transitions; audit), `ExpirePrompts` (deadline → default answer per manifest, keep open with fallback), `CancelPromptsForSession`.
- Priority: `login/error` > `permission(destructive)` > `planApproval` > `permission` > `question` > `confirm`; per-session cap on open prompts (oldest auto-superseded when the CLI moved on).
- Attention UI: queue grouped by priority, card per kind (permission: tool + args diff-style; plan: rendered markdown with Approve/Edit & resend/Reject; question: options/free text), badges (session, provider, worktree), states (open/answering/delivered/ack), keyboard (`j/k`, `a` allow, `d` deny, `Enter` answer, `e` edit plan), deep link `/attention/:promptId`, sound/desktop notification toggle (browser Notification API), empty state.
- Auto-answer policy v1 (config `autoAnswer`): `readOnlyTools: off|on`, `denyDestructive: on`, `timeouts: notify-then-wait`; decisions logged as `prompt.auto_answered` with rule id; UI shows "auto" badge and lets the user override if still open.
- Plan cards v1: `planApproval` payload rendered; Edit & resend sends the edited plan as the answer text where the transport allows (Claude `ExitPlanMode` hook response "(verify)") else as a follow-up message via `PaneController.sendCommand`.
### Out of scope (deferred)
- Push to phone → M7-03. Policy editor + escalation rules → M8-08. Approval gates/4-eyes → M9-04. Re-derivation after restart → M5-05 (M1 stores prompts durably; smoke test only).

## 4. Design
### 4.1 Domain
```ts
export interface AgentPrompt { id; sessionId; kind; title; options: PromptOption[]; payload: PromptPayload; answerTransport; fallbackTransport?; state: 'open'|'answered'|'delivered'|'acknowledged'|'expired'|'cancelled'; priority: 1|2|3|4|5; risk: 'low'|'medium'|'high'; openedAt; deadlineAt?; answer?: PromptAnswer; answeredBy?: {kind:'user'|'policy'|'lead'; id}; externalId }
export type PromptPayload = { tool?: string; input?: unknown; command?: string; files?: string[]; plan?: string; question?: string; raw: unknown }
```
Rules: answering an `expired` prompt is allowed (re-delivery via fallback); `delivered` → `acknowledged` when the pipeline sees the agent continue (tool result / next message) or ack event.
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
user click Allow → AnswerPrompt → transport.deliver → prompt.answered → (ack) prompt.delivered → agent continues → prompt.acknowledged
deadline → ExpirePrompts → default reply through primary transport → prompt.expired → card stays with "answer via fallback" hint
```

## 5. Tasks
- [ ] Core: `AgentPrompt` rules, `PromptClassifier` (pure; destructive patterns list; 100 % branch), priority rules; tests.
- [ ] Migration `0008`; `PromptRepository` extensions (open by session, by priority).
- [ ] Transport strategies (4) + registry; `SendKeysAckedTransport` with manifest keystroke maps + ack detection.
- [ ] Use cases: `OpenPrompt`, `AnswerPrompt` (with fallback), `ExpirePrompts` (persisted deadlines), `CancelPromptsForSession` (on stop/crash).
- [ ] Auto-answer policy v1 (config + rule engine + audit + override).
- [ ] REST/WS surface; DTOs in sdk.
- [ ] Attention UI: queue, cards per kind, plan card with editor, keyboard, deep links, notifications, empty state, EN/AR.
- [ ] Acknowledge detection wiring in the pipeline (next event after delivery).
- [ ] E2E with FakeProvider scenarios: `hello-prompt`, `question-multi`, `plan-approval` through both transports.
- [ ] Manual TCs on Claude + Codex (+ agy).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M1-11-01 | unit | classifier: `rm -rf`, `git push --force`, path outside worktree → risk high / priority 2 | as specified |
| UT-M1-11-02 | unit | state machine incl. expired → answered via fallback | valid transitions only |
| AT-M1-11-03 | application | AnswerPrompt when primary transport fails | fallback used; events show both attempts |
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
| TC-M1-11-05 | Expiry + fallback | 1. trigger a permission; wait past deadline 2. answer from Attention | CLI shows native prompt at expiry; Attention answer sends keystrokes; agent proceeds | ⬜ |
| TC-M1-11-06 | Priority ordering | 1. create a question (fake) and a destructive permission (Claude `rm`) | destructive card first; badges correct | ⬜ |
| TC-M1-11-07 | Auto-answer | 1. enable readOnly auto-approve 2. Claude reads a file | no card; Events shows `prompt.auto_answered`; Attention "auto" history entry | ⬜ |
| TC-M1-11-08 | Session stop cancels | 1. open prompt 2. Stop session | card → cancelled; no dangling deadline | ⬜ |
| TC-M1-11-09 | Restart smoke | 1. open Claude permission 2. `kill -9` daemon, restart 3. Allow | prompt visible after restart; if the hook response was lost the fallback path delivers; agent proceeds | ⬜ |

## 7. Acceptance criteria
- [ ] All six prompt kinds modelled; four transports implemented (elicitation stubbed).
- [ ] Round-trips verified on Claude (hook) and Codex (RPC); fallback keystrokes verified on both.
- [ ] Attention queue with priorities, keyboard, deep links, notifications, EN/AR.
- [ ] Auto-answer v1 conservative, audited, overridable.
- [ ] Restart smoke passes.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Ack detection heuristics ("agent continued") can misfire; treat `acknowledged` as informational in M1, hard in M5-05.
- Edited plan resend semantics differ per CLI — document per adapter in manifest `promptProtocol.planApproval.editSupport`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
