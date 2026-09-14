# Step M4-05 — Lead handoff

| Field | Value |
|---|---|
| Milestone | M4 — Quota, budgets, resilience |
| Status | ⬜ Not started |
| Depends on | M4-04, M3-02 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `apps/daemon` (application/missions, application/quota, infrastructure/fs, infrastructure/git, interface/http, interface/mcp), `apps/web` (mission banner), `packages/sdk` (FakeProvider scenario) |
| Risk | High |
| Owner | |

## 1. Goal
After this step a mission does not die when its Lead's provider runs out. When the Lead provider goes into cooling (M4-03) or its Lead reserve is exhausted (M4-04) — or the user clicks *Hand off Lead* — the daemon **freezes** the mission (no new tasks start, running tasks keep going), writes a machine-generated `## Handoff` section into the mission's `PLAN.md` from the database (progress per task, open tasks with their dependencies, decisions taken, review findings still open, budget spent), picks a fallback provider through the assignment engine, launches a **new Lead session on that provider with the same `missionId`**, feeds it a handoff prompt pointing at `PLAN.md`, and unfreezes when the new Lead acknowledges. The whole episode is one audited `lead_handoffs` row and is visible in Attention and on the mission. Target: frozen → new Lead acknowledged in under 60 s.

## 2. Why
- **G4 (never blocked)** in its strongest form: `01-vision-scope.md` lists "Lead handoff on exhaustion" as the measurable target for G4, and `00-source-plan-v0.2.md` §11 names it explicitly. A mission's Lead is a single point of failure until this step exists.
- **D3 (two-tier orchestration)**: the Lead is replaceable because the *plan and state live in the daemon's database and in `PLAN.md`*, not inside one vendor's context window. This step proves that property.
- **D5 (every provider is a plugin)**: the fallback is chosen by the engine from capability + quota, not from a hard-coded "claude → codex" pair.
- **C5**: the handoff never retries on the exhausted provider; the old Lead session is stopped and its provider stays cooling. The handoff itself is not a retry and consumes no retry budget on the old provider (M4-03 R-C4 keys on tasks, not on Leads — asserted by a test).
- **R11 (bad decompositions)**: the handoff document is generated from the DB, never asked from the dying Lead, and the existing plan-approval gate (M3-02) still applies to any *new* plan version the second Lead produces.
- **G5 (total recall)**: the handoff is a `PlanVersion` + events + audit rows, so a replay (M5-04) shows exactly why the Lead changed.

## 3. Scope
### In scope
- Core: `LeadHandoff` domain service (`04-domain-model.md` §1 lists it) — pure decision "should this mission hand off, and why", plus the pure `HandoffDocument` composer (DB snapshot → markdown).
- Mission freeze/unfreeze: `mission.frozen` flag consumed by `MissionScheduler` (M3-02); running tasks untouched.
- Use cases `EvaluateLeadHealth`, `StartLeadHandoff`, `CompleteLeadHandoff`, `AbortLeadHandoff`, `ListLeadHandoffs`.
- `lead_handoffs` table; events `mission.lead_handoff_started`, `mission.lead_handoff_completed`, `mission.lead_handoff_failed`; audit rows for each.
- `PLAN.md` gains an appended `## Handoff — v<N> (<ISO ts>)` section written through `MissionFs` (M3-02); a new `PlanVersion` row records it (`source: 'plan_md'`, `authorKind: 'system'`, `decision: 'approved'` — it is a record, not a proposal).
- Fallback selection through `AssignmentEngine.decide({ taskType: 'decomposition', role: 'lead', excludeProviders: [old, …cooling] })` honouring the Lead reserve (M4-04 R-B2).
- New Lead launch via `StartSession` (M1-02/M3-02) with the same MCP delegation server registration and a handoff prompt; acknowledgement detection.
- Manual `POST /missions/:id/lead/handoff`; Attention item; mission banner.
- FakeProvider scenario `lead-exhausted.yaml`.
### Out of scope (deferred to …)
- Handing off a *task* agent mid-task (that is M4-03's reroute).
- Automatic re-planning by the new Lead — it may propose a new plan through the normal M3-02 `submit_plan` path with the human gate; nothing is auto-approved here.
- Handoff across hosts — deferred to M7-05.
- Handoff of a cloud/remote Lead session — deferred to M7-07.
- Choosing the fallback from learned outcomes rather than the current engine score — deferred to M8-06.
- 4-eyes approval for a handoff in team mode — deferred to M9-04.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
`packages/core/src/mission/handoff/{lead-handoff.ts, handoff-document.ts, handoff-rules.ts}`.

Rules (100 % branch coverage in `handoff-rules.spec.ts`):
- **R-H1 Triggers.** A handoff is warranted when the mission is in `planning`, `plan_review`, `executing` or `reviewing` **and** one of: (a) the Lead's provider is `cooling` with `coolingUntil − now > leadHandoff.minCoolingMinutes` (default 10); (b) the Lead reserve for that provider is `breached` (M4-04); (c) the Lead session ended with `QUOTA_EXHAUSTED`; (d) an explicit user request. A short cooling is waited out, not handed off.
- **R-H2 One at a time.** At most one active handoff per mission; a second trigger while `state ∈ {freezing, documenting, launching}` is recorded on the existing episode and changes nothing. Idempotent by `(missionId, triggeringSignalId)`.
- **R-H3 Never back to the exhausted provider.** The fallback must differ from the outgoing Lead's provider and must not be cooling. If the engine returns no candidate, the mission stays frozen with `reason: 'no-fallback'`, an Attention item is raised, and the daemon re-evaluates on the next `quota.cooling_ended` — it never falls back to the exhausted provider (C5).
- **R-H4 The document is generated, not requested.** `composeHandoff(snapshot)` is a pure function of the DB snapshot (mission, plan version, tasks + states + assignees, task results, open review findings, decisions/ADR links, budget status, open `AgentPrompt`s). The dying Lead is never asked to summarise itself; if it happens to be responsive its last messages are included verbatim only as a quoted "last Lead notes" block, clearly attributed.
- **R-H5 Append, never rewrite.** The `## Handoff` section is appended to `PLAN.md`; the `orchestra-plan` YAML block from the original plan is left byte-identical so M3-02's parser and `validatePlanAgainstPlaybook` keep working. The composer's output is deterministic given the snapshot (stable ordering, no timestamps other than the episode's).
- **R-H6 Freeze is not cancel.** Freezing sets `missions.frozen = 1`; `MissionScheduler` starts no new tasks; running sessions, panes, worktrees and branches are untouched; task results submitted during the freeze are accepted and appended to the document if it has not been written yet.
- **R-H7 Acknowledged means acknowledged.** The handoff completes only when the new Lead produces an ack: an MCP `status()` call carrying the `missionId`, or a `submit_plan`, or (fallback) the launcher's ready-ack from `PaneController` plus a first assistant message. Timeout `leadHandoff.ackTimeoutSeconds` (default 120) ⇒ `AbortLeadHandoff`, mission stays frozen, Attention item `mission.lead_handoff_failed` with *Retry with another provider* / *Take over manually*.
- **R-H8 Same mission, new session.** `missionId` never changes. `missions.lead_session_id` is repointed only on completion; the previous Lead session id is kept in `lead_handoffs.from_session_id` and remains linked in history (G5).
- **R-H9 Budget carries over.** The mission budget (M4-04) is not reset by a handoff; `mission_budget_usage` keeps accumulating. The handoff itself is charged to the new provider like any other session.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/mission/handoff/lead-handoff.ts
export type HandoffTrigger = 'cooling' | 'reserve_breached' | 'session_quota_exhausted' | 'manual';
export type HandoffState = 'freezing' | 'documenting' | 'launching' | 'completed' | 'failed' | 'aborted';

export interface LeadHandoff {
  id: string; missionId: string;
  trigger: HandoffTrigger; triggeringSignalId?: string;
  fromProvider: ProviderId; fromSessionId: string;
  toProvider?: ProviderId; toModel?: ModelId; toSessionId?: string;
  planVersionId?: string;                 // the PlanVersion recording the handoff document
  state: HandoffState; failureReason?: 'no-fallback' | 'ack-timeout' | 'launch-failed' | 'aborted-by-user';
  startedAt: string; completedAt?: string;
}

export interface HandoffSnapshot {
  mission: Mission; currentPlan: PlanVersion;
  tasks: ReadonlyArray<{ id: string; planTaskId?: string; title: string; taskType: TaskType; state: TaskState;
    provider?: ProviderId; model?: ModelId; branch?: string; dependsOn: string[]; blockedReason?: string }>;
  results: ReadonlyArray<{ taskId: string; summary: string; testsPassed?: boolean; diffStat?: string }>;
  openFindings: ReadonlyArray<{ taskId: string; severity: string; file?: string; message: string }>;
  openPrompts: ReadonlyArray<{ id: string; kind: string; title: string }>;
  budget: MissionBudgetStatus;
  lastLeadNotes?: string;                 // quoted, attributed, optional (R-H4)
}

/** Pure, deterministic (R-H4, R-H5). Returns the markdown section only — the caller appends it. */
export function composeHandoff(s: HandoffSnapshot, episode: { id: string; at: string; from: ProviderId; to: ProviderId; trigger: HandoffTrigger }): string;

/** Pure trigger evaluation (R-H1, R-H3). */
export function shouldHandOff(input: {
  mission: Mission; leadProvider: ProviderId; availability: ProviderAvailability;
  leadReserve: ReserveStatus | null; lastSessionError?: DomainError; params: HandoffParams; now: IsoTimestamp;
}): { handOff: boolean; trigger?: HandoffTrigger; reason: string };

export interface HandoffParams { minCoolingMinutes: number; ackTimeoutSeconds: number; enabled: boolean; preferredFallbacks?: ProviderId[]; }
```
```ts
// apps/daemon/src/application/missions/ports.ts (additions)
export interface LeadHandoffRepository {
  start(h: LeadHandoff): Promise<Result<'started' | 'duplicate', StorageError>>;   // idempotent by (missionId, triggeringSignalId)
  update(h: LeadHandoff): Promise<Result<void, StorageError>>;
  activeFor(missionId: string): Promise<Result<LeadHandoff | null, StorageError>>;
  listByMission(missionId: string): Promise<Result<LeadHandoff[], StorageError>>;
}
export interface HandoffSnapshotReader { read(missionId: string): Promise<Result<HandoffSnapshot, StorageError>>; }

export type HandoffError =
  | { code: 'HANDOFF_IN_PROGRESS'; missionId: string }
  | { code: 'NO_FALLBACK_PROVIDER'; missionId: string; excluded: ProviderId[] }
  | { code: 'ACK_TIMEOUT'; missionId: string; sessionId: string }
  | { code: 'MISSION_NOT_HANDOFFABLE'; missionId: string; state: MissionState };
```
The handoff prompt (composed by `LeadBriefComposer`, M3-02, new template `HANDOFF_PROMPT`): *"You are taking over mission `<id>` (`<title>`) from `<provider>`, which ran out of quota. Read `.orchestra/missions/<id>/PLAN.md`, especially the last `## Handoff` section: it lists completed tasks, in-flight tasks, open tasks and open review findings. Do **not** re-plan unless the plan is wrong — call `status()` first to confirm the current DAG, then continue with `delegate()` for the remaining tasks. If you believe the plan must change, call `submit_plan` and wait for human approval."*

### 4.3 Data / schema changes
Migration `<next>-m4-05-lead-handoff.ts` (additive):
- `lead_handoffs`: `id`, `mission_id`, `trigger`, `triggering_signal_id`, `from_provider`, `from_session_id`, `to_provider`, `to_model`, `to_session_id`, `plan_version_id`, `state`, `failure_reason`, `started_at`, `completed_at`; unique `(mission_id, triggering_signal_id)` where `triggering_signal_id IS NOT NULL`; index `(mission_id, started_at)`.
- `missions` + `frozen INTEGER NOT NULL DEFAULT 0`, `frozen_reason TEXT NULL`.
- `plan_versions.author_kind` (M3-02) accepts `'system'`; `source` stays `'plan_md'`.
- Events (new, in the `mission.*` namespace): `mission.lead_handoff_started`, `mission.lead_handoff_completed`, `mission.lead_handoff_failed`. Note the additions in `04-domain-model.md` §3 when the step closes. Audit rows via the existing interceptor for the manual endpoint and for the automatic episode (actor `policy`).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `MissionFs.appendPlanSection(mission, markdown)` (extends M3-02's `MissionFs`) writes `<repo>/.orchestra/missions/<missionId>/PLAN.md` atomically (write temp + `rename`) so a crash mid-write cannot truncate the plan. `PLAN.md` lives under `.orchestra/` which is gitignored (M3-02), so no commit is made and no branch is touched.
- Old Lead teardown: `StopSession` (M1-02) graceful stop; if the provider is cooling the pane may already be dead — the handoff tolerates both. The old pane's recording is flushed and kept (M5-01 when it lands).
- New Lead launch: `StartSession` with `role: 'lead'`, `cwd = repoPath` (main checkout, not a worktree — M3-02), `Launcher.preLaunchFiles` for the MCP delegation config (M2-05), interactive by default (`missions.leadMode`). The launch goes through the M4-03 `ProviderAdmission` guard, so a cooling fallback can never be selected even if the candidate list was stale.
- Ack detection: the MCP server (M2-05/M3-02) marks the handoff acknowledged on the first `status()`/`submit_plan` carrying the `missionId` from the new session; a timer armed at `ackTimeoutSeconds` (injected `Clock`) triggers `AbortLeadHandoff`. Both the timer and the freeze flag are re-armed/reloaded on boot.
- `EvaluateLeadHealth` subscribes to `quota.cooling_started`, `quota.reserve_breached`, `session.stopped` (with `QUOTA_EXHAUSTED`) and `session.crashed`, debounced 3 s per mission.
- No new egress; no vendor is queried to decide anything.

### 4.5 API / UI surface
- `POST /missions/:id/lead/handoff` `{ toProvider?, toModel?, reason? }` (`Idempotency-Key`, audited) → `202 { handoffId }`; `409 HANDOFF_IN_PROGRESS`; `409 MISSION_NOT_HANDOFFABLE`; `422 NO_FALLBACK_PROVIDER` with the excluded list.
- `GET /missions/:id/handoffs` → `LeadHandoff[]`.
- `POST /missions/:id/unfreeze` (audited) — manual escape hatch after a failed handoff ("I will drive the mission myself"): clears `frozen`, leaves `lead_session_id` null.
- WS topic `mission.<id>`: the three handoff events + `mission` freeze state.
- UI (`apps/web/src/screens/missions/`): mission banner states — *Lead handoff in progress — documenting / launching (<provider>)*, *Lead handed off: claude → codex*, *Handoff failed: no fallback provider — every capable provider is cooling until 14:20* with actions *Retry*, *Choose provider*, *Take over*. Status by icon **and** text (UX principle 2). Attention item `mission.lead_handoff` mirrors the same states with a deep link.
- The `## Handoff` section is rendered in the existing plan viewer (M3-02 plan card / mission detail) as part of `PLAN.md`.

### 4.6 Flow / sequence
```
quota.cooling_started(claude) | quota.reserve_breached(lead-claude) | session.stopped(QUOTA_EXHAUSTED)
  ─▶ EvaluateLeadHealth(missionId) [debounce 3 s]
      └─ shouldHandOff(...)  false ⇒ stop (short cooling is waited out)                        (R-H1)
         true ─▶ StartLeadHandoff
             ├─ LeadHandoffRepository.start (idempotent) ⇒ 'duplicate' ⇒ stop                  (R-H2)
             ├─ missions.frozen = 1, frozen_reason = 'lead-handoff'  ─▶ scheduler stops queuing (R-H6)
             ├─ mission.lead_handoff_started ─▶ /ws + Attention + banner
             ├─ state = documenting: HandoffSnapshotReader.read ─▶ composeHandoff (pure)        (R-H4)
             │     ─▶ MissionFs.appendPlanSection (atomic) ─▶ PlanVersion(system, approved)     (R-H5)
             ├─ state = launching: AssignmentEngine.decide({taskType:'decomposition', role:'lead',
             │     excludeProviders:[fromProvider, ...cooling]})                                (R-H3)
             │     no candidate ⇒ failureReason 'no-fallback', mission stays frozen,
             │                    re-evaluate on next quota.cooling_ended
             ├─ StopSession(old Lead)  (tolerates an already-dead pane)
             ├─ StartSession(new provider, role lead, MCP delegation) + HANDOFF_PROMPT
             └─ arm ack timer (ackTimeoutSeconds)
new Lead ── MCP status()/submit_plan{missionId} ─▶ CompleteLeadHandoff                          (R-H7)
             ├─ missions.lead_session_id = newSessionId; frozen = 0                             (R-H8)
             └─ mission.lead_handoff_completed ─▶ scheduler resumes queued tasks
ack timer fires ─▶ AbortLeadHandoff ─▶ state failed('ack-timeout'), mission stays frozen
             └─▶ Attention: Retry with another provider · Choose provider · Take over
```

## 5. Tasks
- [ ] `packages/core/src/mission/handoff/`: `LeadHandoff` types, `shouldHandOff`, `composeHandoff` implementing R-H1…R-H9; 100 % branch tests incl. a golden-markdown snapshot test for the document.
- [ ] Migration `m4_05_lead_handoff` (`lead_handoffs`, `missions.frozen`) + Kysely repository + in-memory double.
- [ ] `HandoffSnapshotReader` (joins missions, plan_versions, tasks, task_results, review_findings, agent_prompts, mission_budget_usage).
- [ ] `MissionFs.appendPlanSection` with atomic temp+rename; `PlanVersion` row with `authorKind: 'system'`.
- [ ] Use cases `EvaluateLeadHealth`, `StartLeadHandoff`, `CompleteLeadHandoff`, `AbortLeadHandoff`, `ListLeadHandoffs` (one class each, `Result`-returning).
- [ ] `MissionScheduler` (M3-02) respects `missions.frozen`; running tasks unaffected; queued tasks resume on unfreeze.
- [ ] Fallback selection through the engine with `excludeProviders`, Lead-reserve exemption (M4-04 R-B2) and the M4-03 admission guard; re-evaluation hook on `quota.cooling_ended`.
- [ ] `HANDOFF_PROMPT` template in `LeadBriefComposer`; delivery interactive (`PaneController.sendCommand`) and headless.
- [ ] Ack detection in the MCP server (`status`/`submit_plan` carrying `missionId` from the new session) + ack timer with boot re-arm.
- [ ] Events + audit rows; Attention item `mission.lead_handoff` (raise, update, resolve).
- [ ] HTTP: `POST /missions/:id/lead/handoff`, `GET /missions/:id/handoffs`, `POST /missions/:id/unfreeze`; DTOs + OpenAPI.
- [ ] Web: mission banner states + actions, handoff history list on the mission detail, `## Handoff` rendering in the plan viewer.
- [ ] FakeProvider scenario `lead-exhausted.yaml` (Lead plans → plan approved → two tasks delegated → Lead emits exhaustion with `resetAt` = +2 h).
- [ ] Config `leadHandoff.{enabled,minCoolingMinutes,ackTimeoutSeconds,preferredFallbacks}` behind `features.leadHandoff`.
- [ ] Docs: `apps/daemon/README` "Lead handoff" section; new events in `04-domain-model.md` §3; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M4-05-01 | unit | `shouldHandOff` for cooling 5 min / 45 min / reserve breached / session `QUOTA_EXHAUSTED` / mission `done` | `false` (wait it out) / `true 'cooling'` / `true 'reserve_breached'` / `true 'session_quota_exhausted'` / `false` (R-H1) |
| UT-M4-05-02 | unit | `composeHandoff` golden snapshot for a 6-task mission (2 done, 1 running, 2 open, 1 blocked, 1 open finding) | deterministic markdown: progress table, open tasks with `dependsOn`, decisions, open findings, budget line; identical across two runs (R-H4, R-H5) |
| UT-M4-05-03 | unit | `composeHandoff` with empty results / no findings / missing `lastLeadNotes` | no empty headings, no `undefined` in output, never throws |
| UT-M4-05-04 | unit | fallback selection excludes the outgoing provider and every cooling provider | outgoing provider never returned even when it scores highest (R-H3) |
| AT-M4-05-01 | application | two triggers (cooling + reserve breach) within 3 s for one mission | one `lead_handoffs` row, one `mission.lead_handoff_started`, second trigger recorded on the same episode (R-H2) |
| AT-M4-05-02 | application | handoff while 2 tasks are running and 3 are queued | frozen: no new task starts; the 2 running tasks complete and their results are accepted; on completion the 3 queued tasks start |
| AT-M4-05-03 | application | no capable fallback available | `failureReason: 'no-fallback'`, mission stays frozen, Attention item raised; on `quota.cooling_ended` the handoff is re-evaluated and completes |
| AT-M4-05-04 | application | new Lead never acks within `ackTimeoutSeconds` | `AbortLeadHandoff`; state `failed('ack-timeout')`; mission still frozen; the new session is stopped; retry offered |
| AT-M4-05-05 | application | handoff does not consume the task retry budget (C5 interaction) | `task_retries` unchanged; the outgoing provider stays cooling; no session is started on it |
| AT-M4-05-06 | application | budget carry-over | `mission_budget_usage` continues from its pre-handoff totals; a mission already `budget_paused` stays paused after the handoff (R-H9) |
| IT-M4-05-01 | integration | `PLAN.md` append with a crash injected between temp-write and rename | `PLAN.md` is either the old file or the fully appended one, never truncated; the `orchestra-plan` block still parses (R-H5) |
| IT-M4-05-02 | integration | `kill -9` during `launching`, then restart | episode state restored; ack timer re-armed; either completion or a clean `ack-timeout` failure, never a second new Lead |
| E2E-M4-05-01 | e2e (Playwright + FakeProvider) | `lead-exhausted.yaml` with `fake-b` available | within 60 s: banner walks documenting → launching → handed off; `PLAN.md` has one `## Handoff`; new Lead session on `fake-b` with the same `missionId`; `GET /missions/:id/handoffs` has one `completed` row |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M4-05-01 | FakeProvider Lead exhaustion → handoff | 1. Create a mission (playbook `bugfix`) with the Lead on `fake-lead`, scenario `lead-exhausted.yaml`. 2. Approve the plan. 3. Let the Lead emit exhaustion (`resetAt` = +2 h). 4. Watch the mission banner and `cat .orchestra/missions/<id>/PLAN.md`. | Within 60 s: banner "Lead handoff in progress" → "Lead handed off: fake-lead → fake-b"; `PLAN.md` gained one `## Handoff — v<N>` section listing done/running/open tasks; a new Lead session on `fake-b` runs with the **same** `missionId`; `GET /missions/:id/handoffs` shows one `completed` row; audit rows exist for start and completion. | ⬜ |
| TC-M4-05-02 | Handoff document is generated, not asked | 1. During TC-01, check the daemon log and the old Lead's pane. | No prompt is sent to the exhausted Lead asking it to summarise; the document's task table matches `GET /missions/:id` exactly; if a "last Lead notes" block appears it is quoted and attributed. | ⬜ |
| TC-M4-05-03 | Freeze does not kill running work | 1. Start a mission with 2 tasks running on other providers. 2. Trigger the Lead handoff manually (`POST /missions/:id/lead/handoff`). | Both running task panes keep working and their results are accepted; no new task starts while frozen; after completion the queued tasks start. No worktree or branch is removed. | ⬜ |
| TC-M4-05-04 | Negative: no fallback provider | 1. Disable every provider except the Lead's. 2. Trigger a handoff. | `422 NO_FALLBACK_PROVIDER` (manual) or `failureReason: 'no-fallback'` (automatic); mission stays frozen with a clear banner and the reset time; **no** attempt to restart the Lead on the exhausted provider; when another provider becomes available the handoff completes. | ⬜ |
| TC-M4-05-05 | Negative: new Lead never acknowledges | 1. Use a FakeProvider scenario that launches and stays silent. 2. Trigger a handoff and wait past `ackTimeoutSeconds`. | Banner "Handoff failed: no acknowledgement"; the silent session is stopped; mission stays frozen; *Retry with another provider* and *Take over* both work; no duplicate Lead sessions remain (check `sessions` and `tmux list-windows`). | ⬜ |
| TC-M4-05-06 | Restart mid-handoff | 1. `kill -9` the daemon while the banner reads "launching". 2. Restart. | The episode resumes: either the new Lead's ack completes it, or the re-armed timer fails it cleanly. Exactly one new Lead session exists; the mission is never silently unfrozen. | ⬜ |
| TC-M4-05-07 | Real providers, observed safely | 1. Run a small real mission with the Lead on Claude Code and Codex enabled. 2. **Do not provoke a limit** (C5). Instead set a Lead reserve (M4-04) high enough that the real window trips it, or replay a recorded fixture: `pnpm --filter @orchestra/daemon fixtures:replay claude exit/429.txt --session <lead-session-id>`. | The real signal produces the same episode: freeze, `## Handoff` written, a Codex Lead started with the same `missionId` and the handoff prompt, ack within the timeout, mission resumes. The old Claude session is stopped and Claude stays cooling. | ⬜ |
| TC-M4-05-08 | Continuity check by the new Lead | 1. After TC-01 or TC-07, read the new Lead's first actions in Chat. | It calls `status()` before delegating, does not re-create tasks that already exist, and does not submit a new plan unless the plan is genuinely wrong (in which case the human approval gate from M3-02 appears). | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] From trigger to a new acknowledged Lead takes < 60 s on FakeProvider (E2E-M4-05-01, TC-M4-05-01), measured from `mission.lead_handoff_started` to `mission.lead_handoff_completed`.
- [ ] `PLAN.md` gains exactly one `## Handoff` section per episode, appended atomically, with the original `orchestra-plan` block byte-identical and still parseable by M3-02.
- [ ] The handoff document is composed purely from the database snapshot; `composeHandoff` is deterministic (golden snapshot test) and never contains `undefined`/empty headings.
- [ ] The outgoing provider is never re-used for the new Lead and no session is started on a cooling provider; no task retry budget is consumed by a handoff (AT-M4-05-05).
- [ ] Freezing starts no new tasks and kills nothing; queued tasks resume only after completion or an explicit unfreeze.
- [ ] `missionId` is unchanged; `lead_handoffs` records `from_session_id` and `to_session_id`; history and replay link both sessions.
- [ ] Failure paths (`no-fallback`, `ack-timeout`, `launch-failed`) leave the mission frozen with an actionable Attention item and are recoverable without a restart.
- [ ] Handoff state survives `kill -9` mid-episode with exactly one new Lead session (TC-M4-05-06).
- [ ] All TC-M4-05-01…08 pass and are recorded with build hash and date.
- [ ] No new ESLint / dependency-cruiser violations; `packages/core` still imports nothing; new events documented in `04-domain-model.md` §3; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Context loss is real.** A markdown handoff carries facts, not the outgoing Lead's reasoning. The mitigation is scope: the new Lead continues an *approved* plan and must go through the human gate to change it (R11). Expect the second Lead to be slower on the first few turns; measure it in TC-M4-05-08 rather than assuming.
- Whether a vendor CLI surfaces "quota exhausted" distinctly from a generic error on Lead exit differs per provider (verify against Claude Code / Codex / Antigravity docs at step start). Where it does not, trigger (c) never fires and only (a)/(b) protect the mission.
- `minCoolingMinutes` (10) is a judgement call: hand off too eagerly and you pay the context-loss cost for nothing; too late and the mission stalls. It is config, and the default should be revisited after the first real handoff.
- Two missions sharing one Lead provider will both hand off to the same fallback and may exhaust it next. The engine's quota factor (M4-02) and reserves (M4-04) reduce this, but a cascade is possible; watch for it in M4-07's reroute KPI and consider staggering in a follow-up.
- Ack detection depends on the MCP shim (M2-05) being registered for the new session; if MCP registration fails the PTY ready-ack fallback (R-H7) is weaker evidence that the Lead actually read `PLAN.md`. TC-M4-05-08 is the human check on that.
- Appending to `PLAN.md` while the user has it open in an editor can produce a confusing merge on their side; the file lives under gitignored `.orchestra/` and is daemon-owned — say so in the docs.
- Interactive Leads only: a headless Lead (`missions.leadMode: headless`) has no pane to send a prompt to, so the handoff prompt goes in as the headless input. Verify both paths in AT tests before relying on headless missions.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
