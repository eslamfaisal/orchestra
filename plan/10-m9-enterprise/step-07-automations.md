# Step M9-07 — Automations

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M3-02 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/core` (`src/automations/`), `packages/catalog` (`schemas/automation.schema.ts`), `apps/daemon` (`src/application/automations`, `src/infrastructure/automations/{scheduler,watchers}`, `src/infrastructure/persistence`, `src/interface/http`, `src/interface/ws`), `apps/web` (Settings → Automations, run history), `apps/cli` (`orch automation`) |
| Risk | Medium (a misfiring trigger can start an unbounded number of missions) |
| Owner | |

## 1. Goal
Missions can start without a human click. An **Automation** binds a trigger — a cron schedule, an incoming git push webhook, a file-watch pattern, or the completion of another mission — to a playbook, a repo and a budget, and each firing creates an `automation_run` that either starts a mission through the existing `PlanMission` use case or is recorded as `skipped` with a reason (deduplicated, concurrency-capped, budget-exhausted, gate-rejected). Every run is visible in Settings → Automations with its trigger payload, the mission it created, and its outcome; `orch automation run <id>` fires one by hand. Automations run **as their owner**, so M9-01 permissions, M9-04 approval gates and M4-04 budgets all apply exactly as if that user had clicked the button.

## 2. Why
- Source plan §20 P5 lists "automations (scheduled/triggered missions)" as part of the enterprise phase, and M3-02 explicitly deferred "scheduled / triggered missions" to M9-07.
- G2/G4: idle quota is wasted quota. A nightly "dependency bump + test" or "triage new issues" mission uses cheap windows that would otherwise expire, which is exactly the "≥ 80 % of each paid window used productively" target.
- D3: the trigger is deterministic plane work — a cron expression and a dedupe key, not an LLM decision. The Lead still does the decomposition, unchanged.
- C10: an automation spends quota without a human in the loop at firing time, so it must be owned, permissioned, budgeted and audited. That is only possible after M9-01 (owner), M4-04 (budgets) and M9-04 (gates).
- C2: the git webhook is *inbound*, not egress, so it introduces no new outbound host — but it is the first unauthenticated-by-default inbound surface besides `/hooks/*`, so it needs its own shared-secret verification.
- G6 / M6-05: release watchers already prove the "something happened → do something" pattern for the platform itself; automations generalise it to the user's work.

## 3. Scope
### In scope
- `Automation` aggregate + `AutomationRun`, with `automations` and `automation_runs` tables.
- Triggers: `cron` (with timezone), `git_push` (inbound webhook), `file_watch` (path globs in a repo), `mission_completed` (chaining), `manual`.
- Pure rules: cron next-fire computation boundary (delegated to a library, wrapped), dedupe key derivation, concurrency policy, catch-up policy after downtime.
- `AutomationScheduler` (durable, restart-safe) and `WatcherRegistry` (DI strategy map keyed by trigger kind).
- Inbound webhook endpoint with per-automation shared secret (HMAC), replay protection and payload size caps.
- Ownership + permissions: `automation.manage` (M9-01 matrix), runs execute with the owner's `Actor`; a deactivated owner disables the automation.
- Budget integration (M4-04): per-automation budget and a hard "never exceed the owner's reserve" rule.
- Gate integration (M9-04): a gated task inside an automated mission behaves normally — the gate opens and waits; the run is `waiting`, not failed.
- Run history UI, run detail (trigger payload, decision, mission link, budget consumed), enable/disable, dry-run.
- `orch automation list|show|create|enable|disable|run|runs` with `--json`.
- Half-day integration task: re-check every automation path against the M9-01 guards and M9-04 gates once those land (called out in the milestone README's Lane C note).
### Out of scope (deferred to …)
- Triggers from vendor/CI systems (GitHub Actions status, Jira transitions) — deferred to M10 backlog; the webhook is generic enough that a thin adapter can be added later.
- A visual workflow builder / multi-step automation DAGs — not planned for 1.0; the playbook (M3-01) is the DAG.
- Outbound notifications on run completion beyond the existing M8-08 channels — reuse, no new work.
- Automations that act on their own (auto-merge on green) — the mission's own gates and M3-06 policy decide merging; automations only *start* missions.
- Distributed scheduling / multiple daemons sharing a schedule — the daemon is single-instance (M9-06); a second instance is prevented by the M0-04 lock.
- Secrets for the webhook stored encrypted — M9-09 decides column encryption; the secret is stored hashed for verification where the algorithm allows, otherwise flagged.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Automation { id, name, ownerUserId, enabled, trigger, action, budget?, concurrency, dedupe, createdAt, updatedAt, lastRunAt?, nextFireAt? }`.
- `AutomationTrigger` (discriminated union):
  - `{ kind: 'cron', expression, timezone, catchUp: 'skip' | 'once' }`
  - `{ kind: 'git_push', repoPath, branches: string[] (globs), pathsChanged?: string[] (globs), secretRef }`
  - `{ kind: 'file_watch', repoPath, globs: string[], debounceMs }`
  - `{ kind: 'mission_completed', playbookId?, onlyOutcome: ('done' | 'failed')[] }`
  - `{ kind: 'manual' }`
- `AutomationAction = { kind: 'plan_mission', playbookId, repoPath, baseRef?, titleTemplate, intentTemplate, lead?: { provider, model } }` — templates render `{{trigger.*}}` values (commit sha, message, matched file, iso date) through a whitelisted, non-executing renderer.
- `AutomationRun { id, automationId, triggeredAt, triggerKind, triggerPayloadJson, dedupeKey, state, missionId?, skipReason?, error?, finishedAt?, budgetUsedJson? }`.
- `RunState = 'pending' → 'running' → 'succeeded' | 'failed'` and the terminal shortcuts `'skipped'` (dedupe / concurrency / disabled / budget) and `'waiting'` (a gate is open inside the created mission; resolves to succeeded/failed when the mission finishes).
- Pure rules (`packages/core/src/automations/rules.ts`, 100 % branch):
  - `deriveDedupeKey(trigger, payload) → string` — cron: `${automationId}:${scheduledFireIso}`; git_push: `${automationId}:${afterSha}`; file_watch: `${automationId}:${sortedPaths.hash}:${debounceWindowStart}`; mission_completed: `${automationId}:${sourceMissionId}`. A run whose key already exists ⇒ `skipped(reason:'duplicate')`.
  - `admitRun(automation, activeRuns, now) → Result<void, AutomationError>` — `disabled` ⇒ `Skipped('disabled')`; `activeRuns >= concurrency.max` ⇒ per `concurrency.onBusy`: `'skip'` (default), `'queue'` (bounded queue of 10), `'cancel_oldest'`.
  - `shouldFireGitPush(trigger, payload) → boolean` — branch glob match **and** (no `pathsChanged` or at least one changed path matches).
  - `catchUpPlan(trigger, lastFireAt, now) → Iso8601[]` — `'skip'` returns only the next fire; `'once'` returns a single immediate fire when at least one scheduled time was missed. **Never** replays every missed occurrence (a daemon down for a week must not start 168 missions).
  - Rule: an automation whose owner is deactivated is treated as `disabled` and every fire is `skipped(reason:'owner_inactive')`.
  - Rule: budget is evaluated before the mission is created; `Skipped('budget_exhausted')` is a normal outcome, not an error.

### 4.2 Interfaces / contracts
```ts
// packages/catalog/schemas/automation.schema.ts (Zod; the file/DB format)
export interface AutomationSpec {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  budget?: MissionBudgetPolicy;                       // M4-04 type, reused verbatim
  concurrency: { max: number; onBusy: 'skip' | 'queue' | 'cancel_oldest' };
  dedupe: { windowMinutes: number };                  // 0 = key-only dedupe, no time window
}

// packages/core/src/automations/ports.ts
export interface AutomationRepository {
  save(a: Automation): Promise<Result<void, RepoError>>;
  get(id: string): Promise<Result<Automation, AutomationError>>;
  list(f?: { ownerUserId?: string; enabled?: boolean; kind?: AutomationTrigger['kind'] }): Promise<Result<Automation[], RepoError>>;
  dueBefore(ts: Iso8601): Promise<Result<Automation[], RepoError>>;
  setNextFire(id: string, at: Iso8601 | null): Promise<Result<void, RepoError>>;
}
export interface AutomationRunRepository {
  create(r: AutomationRun): Promise<Result<AutomationRun, AutomationError>>;   // unique(automation_id, dedupe_key) ⇒ DuplicateRun
  update(r: AutomationRun): Promise<Result<void, RepoError>>;
  listByAutomation(id: string, page: Page): Promise<Result<AutomationRun[], RepoError>>;
  activeCount(automationId: string): Promise<Result<number, RepoError>>;
}
export interface TriggerWatcher {                     // DI strategy map keyed by trigger kind — no switch
  readonly kind: AutomationTrigger['kind'];
  start(a: Automation, emit: (payload: unknown) => void): Promise<Result<void, AutomationError>>;
  stop(automationId: string): Promise<Result<void, AutomationError>>;
}
export type AutomationError =
  | { code: 'DuplicateRun'; dedupeKey: string }
  | { code: 'ConcurrencyLimit'; active: number; max: number }
  | { code: 'AutomationDisabled' }
  | { code: 'OwnerInactive'; ownerUserId: string }
  | { code: 'BudgetExhausted'; detail: string }
  | { code: 'BadCronExpression'; expression: string }
  | { code: 'WebhookSignatureInvalid' }
  | { code: 'AutomationNotFound'; id: string }
  | { code: 'TemplateInvalid'; field: string; detail: string };

// apps/daemon/src/application/automations/ — one use case per class
export class CreateAutomation  { execute(spec: AutomationSpec, actor: Actor): Promise<Result<Automation, AutomationError>>; }
export class UpdateAutomation  { execute(id: string, spec: AutomationSpec, actor: Actor): Promise<Result<Automation, AutomationError>>; }
export class SetAutomationEnabled { execute(id: string, enabled: boolean, actor: Actor): Promise<Result<Automation, AutomationError>>; }
export class FireAutomation    { execute(i: { automationId: string; payload: unknown; scheduledFor?: Iso8601; dryRun?: boolean }): Promise<Result<AutomationRun, AutomationError>>; }
export class CompleteAutomationRun { execute(i: { runId: string; missionOutcome: 'done'|'failed'|'cancelled' }): Promise<Result<void, AutomationError>>; }
export class ListAutomationRuns { execute(id: string, page: Page, actor: Actor): Promise<Result<AutomationRun[], AutomationError>>; }
```

### 4.3 Data / schema changes
Migration `0096_automations` (new tables — **not** in `04-domain-model.md` §4, flag for update):
- `automations (id text pk, name text, owner_user_id text not null, enabled integer not null default 1, trigger_kind text not null, trigger_json text not null, action_json text not null, budget_json text null, concurrency_json text not null, dedupe_json text not null, webhook_secret_hash text null, created_at text, updated_at text, last_run_at text null, next_fire_at text null)`; indices `(enabled, next_fire_at)`, `(trigger_kind)`, `(owner_user_id)`.
- `automation_runs (id text pk, automation_id text not null, triggered_at text not null, trigger_kind text, trigger_payload_json text, dedupe_key text not null, state text not null, mission_id text null, skip_reason text null, error text null, finished_at text null, budget_used_json text null, unique(automation_id, dedupe_key))`; indices `(automation_id, triggered_at desc)`, `(state)`, `(mission_id)`.
- `missions`: add `automation_run_id text null` so a mission can be traced back to its trigger (and the Missions screen can show "started by automation X").
- New events (new `automation.*` namespace, extension of `04-domain-model.md` §3): `automation.created`, `automation.updated`, `automation.enabled_changed`, `automation.fired`, `automation.run_skipped`, `automation.run_started`, `automation.run_finished`, `automation.webhook_rejected`.
- Config:

| Key | Type | Default | Notes |
|---|---|---|---|
| `features.automations` | boolean | `false` | on by default in team mode once the step's acceptance passes |
| `automations.maxEnabled` | number | `50` | guardrail |
| `automations.webhook.path` | string | `/automations/webhook/:id` | |
| `automations.webhook.maxBodyBytes` | number | `1048576` | 1 MB |
| `automations.webhook.toleranceSeconds` | number | `300` | replay window for the timestamp header |
| `automations.fileWatch.maxWatchedPaths` | number | `20000` | refuses a glob that would exceed it |
| `automations.defaultTimezone` | string | host tz | cron timezone default |
| `automations.schedulerTickMs` | number | `15000` | |

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Scheduler:** a single in-process `AutomationScheduler` ticks every `schedulerTickMs`, reads `automations.dueBefore(now)`, and calls `FireAutomation` with `scheduledFor` set to the *scheduled* time (not `now`) so the dedupe key is stable across a late tick. `next_fire_at` is persisted, so a restart re-arms exactly once (same pattern as M1-11 prompt deadlines and M9-04 gate deadlines). Cron parsing and next-fire computation use a maintained library wrapped behind `CronPort` (so the pure rules stay library-free); DST is handled by computing in the automation's timezone — a skipped hour yields no fire, a repeated hour yields one fire (dedupe key makes the second a duplicate).
- **Git push webhook:** `POST /automations/webhook/:id` with headers `X-Orch-Timestamp` and `X-Orch-Signature: sha256=<hex>` over `timestamp + '.' + rawBody`, verified against the automation's secret in constant time; timestamp outside `toleranceSeconds` ⇒ 401 `WebhookSignatureInvalid`. The body is parsed by a small `PushPayload` Zod schema with fields Orchestra actually uses (`ref`, `before`, `after`, `commits[].{id,message,added,modified,removed}`); anything else is ignored. Unknown/rejected requests are rate-limited per id and emit `automation.webhook_rejected` (audited). This endpoint joins `/hooks/*` in M9-01's public-route allowlist file **with its own authentication**, and that entry must be reviewed in the architecture test.
- **File watcher:** `chokidar` (or `fs.watch` with a debounce wrapper) over `repoPath` restricted to the configured globs, ignoring `.git/`, `node_modules/`, and `.orchestra/worktrees/` (critical — watching worktrees would make every agent's own edits trigger the automation, an obvious feedback loop). Debounced per `debounceMs`, batched into one payload with the changed path list. A glob whose expansion exceeds `maxWatchedPaths` is refused at save time with a readable error.
- **Mission chaining:** `mission_completed` subscribes to the `mission.completed` / `mission.failed` events on the existing in-process `EventBus` (M0-05). Chain depth is capped at 3 by carrying `chainDepth` in the run payload; exceeding it ⇒ `skipped('chain_depth')`, which is the guard against two automations triggering each other forever.
- **Execution identity:** `FireAutomation` resolves the owner's `Actor` (kind `system`, carrying the owner's `userId` and roles — the shape M9-01 defined for policy/system actors) and calls `CreateMission` + `StartPlanning` through the normal use cases, so every M9-01 guard, M9-04 gate and M4-04 budget check runs unchanged. There is no privileged path.
- No tmux changes. No new outbound egress (the webhook is inbound); notifications reuse M8-08 channels.

### 4.5 API / UI surface
| Route | Permission | Behaviour |
|---|---|---|
| `GET /automations` | `automation.manage` (Members see their own via scope `own`) | list with next fire and last run |
| `POST /automations` | `automation.manage` | Zod-validated `AutomationSpec`; returns the webhook secret **once** for `git_push` |
| `PATCH /automations/:id` | `automation.manage` | full-spec replace; `Idempotency-Key` honoured |
| `POST /automations/:id/enable` · `/disable` | `automation.manage` | audited |
| `POST /automations/:id/run` `{ dryRun? }` | `automation.manage` | manual fire; dry-run renders templates and reports the decision without creating a mission |
| `GET /automations/:id/runs?cursor` | `automation.manage` | paged run history |
| `POST /automations/webhook/:id` | HMAC only (public route, own auth) | 202 accepted / 401 signature / 409 duplicate |

- WS topic `automations` (deltas: run created, state changed), filtered by M9-01's `VisibilityFilter`.
- Web — **Settings → Automations**: a list (name, trigger summary, owner, enabled toggle, next fire, last run chip) and a create/edit drawer with per-trigger forms (cron expression with a live "next 5 fires in <tz>" preview and a plain-language description; git_push with the webhook URL, the one-time secret and a "copy as GitHub webhook config" snippet; file_watch with a glob tester showing how many paths match; mission_completed with a playbook picker), the playbook/repo/budget section reusing M8-02's controls, and a **Dry run** button. A **Runs** tab shows the history table (time, trigger summary, state chip, mission link, budget used, skip reason) with a detail drawer containing the raw trigger payload (redacted through the M5-01 redactor).
- Missions screen (M3-08) and the mission header show "Started by automation <name>" with a link.
- CLI: `orch automation list|show <id>|create -f spec.yaml|enable <id>|disable <id>|run <id> [--dry-run]|runs <id>`, all `--json`.

### 4.6 Flow / sequence
```
cron tick (every 15 s)
  → dueBefore(now) → for each: FireAutomation(automationId, payload{scheduledFor})
       deriveDedupeKey → runs.create (unique) ⇒ DuplicateRun ⇒ run 'skipped(duplicate)' (recorded, not an error)
       admitRun: disabled / owner_inactive / concurrency ⇒ 'skipped(reason)'
       budget check (M4-04 ledger against the owner's reserves) ⇒ 'skipped(budget_exhausted)'
       render title/intent templates (whitelisted vars only) ⇒ TemplateInvalid ⇒ run 'failed'
       CreateMission + StartPlanning with Actor{kind:'system', userId: owner}
           → M9-01 guards run → M9-04 gates may open inside the mission ⇒ run state 'waiting'
       run 'running', mission_id set, setNextFire(next occurrence)
  → mission.completed|failed → CompleteAutomationRun → run 'succeeded'|'failed', budget_used recorded

POST /automations/webhook/:id  (git push)
  → size cap → timestamp tolerance → constant-time HMAC → Zod PushPayload
  → shouldFireGitPush(trigger, payload) false ⇒ 202 {fired:false, reason:'no_branch_match'} (no run row)
  → true ⇒ FireAutomation(dedupeKey = automationId:afterSha) ⇒ duplicate delivery ⇒ 409 + run 'skipped(duplicate)'
  → invalid signature ⇒ 401 + automation.webhook_rejected + audit(outcome='denied') + per-id rate limit

file_watch
  → chokidar events (ignoring .git, node_modules, .orchestra/worktrees) → debounce(debounceMs)
  → batch payload {paths[]} → FireAutomation (dedupe by path-set hash + window)
```

## 5. Tasks
- [ ] `packages/core/src/automations/`: types, `RunState` machine, `deriveDedupeKey`, `admitRun`, `shouldFireGitPush`, `catchUpPlan`; table-driven tests to 100 % branch coverage.
- [ ] `packages/catalog/schemas/automation.schema.ts` + example specs in `examples/automations/` (nightly deps bump, push-triggered test-fix, docs watcher).
- [ ] Migration `0096_automations` (both tables, `missions.automation_run_id`, indices, unique dedupe constraint); Kysely + in-memory repositories + shared contract spec.
- [ ] Use cases `CreateAutomation`, `UpdateAutomation`, `SetAutomationEnabled`, `FireAutomation`, `CompleteAutomationRun`, `ListAutomationRuns`.
- [ ] `CronPort` wrapper + `AutomationScheduler` with persisted `next_fire_at`, restart re-arm, DST handling, `catchUp` policy.
- [ ] `TriggerWatcher` strategy map: `GitPushWebhookWatcher`, `FileWatchWatcher` (chokidar, ignore list, path-count guard), `MissionCompletedWatcher` (EventBus subscription, chain-depth cap), `ManualWatcher`.
- [ ] Webhook endpoint: HMAC verification (constant time), timestamp tolerance, body size cap, Zod payload, per-id rate limit, `automation.webhook_rejected` audit; add to the M9-01 public-route allowlist with a review note.
- [ ] Template renderer with a whitelist of `{{trigger.*}}` variables and no code execution; `TemplateInvalid` at save time, not at fire time.
- [ ] Budget integration with M4-04 (`estimatedCost` + reserves) and ownership/permission integration with M9-01; gate-aware `waiting` state with M9-04.
- [ ] HTTP routes + WS `automations` topic with visibility filtering; audit every create/update/enable/disable/fire/skip.
- [ ] Web: Settings → Automations list, create/edit drawer with per-trigger forms and previews, dry-run, Runs tab with payload drawer; Missions "started by" attribution; EN/AR.
- [ ] CLI `orch automation …` with `--json` and documented exit codes.
- [ ] Integration half-day: re-run the M9-01 architecture test (every mutating handler guarded) and verify an automated mission containing a gated task behaves correctly end to end.
- [ ] Docs `docs/deployment/automations.md`: trigger reference, webhook setup for GitHub/GitLab (secret, content type, events), dedupe semantics, catch-up behaviour, cost warnings.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-07-01 | unit | `deriveDedupeKey` for all five trigger kinds, including two pushes with the same `after` sha and two cron fires in a repeated DST hour | stable keys; duplicates collide as designed; 100 % branches |
| UT-M9-07-02 | unit | `admitRun` across disabled / owner inactive / at-limit with each `onBusy` value | exact skip reasons; `queue` bounded at 10 |
| UT-M9-07-03 | unit | `catchUpPlan` after 7 days of downtime with `catchUp: 'once'` and `'skip'` | one fire and zero fires respectively — never 168 |
| UT-M9-07-04 | unit | `shouldFireGitPush` over branch globs × changed-path globs | matches spec including the "no pathsChanged ⇒ any path" case |
| AT-M9-07-01 | application | `FireAutomation` when the owner is a Viewer (no `task.delegate`) | mission creation denied by the M9-01 guard; run `failed` with the permission name; audit `outcome: denied` |
| AT-M9-07-02 | application | `FireAutomation` with an exhausted owner reserve (M4-04) | run `skipped(budget_exhausted)`; no mission created; no quota spent |
| IT-M9-07-01 | integration | webhook: valid signature, tampered body, stale timestamp, replayed delivery | 202 / 401 / 401 / 409 with a `skipped(duplicate)` run; three `automation.webhook_rejected`-or-duplicate records |
| IT-M9-07-02 | integration | cron automation with a 1-minute expression, daemon restarted mid-interval | exactly one run per scheduled minute across the restart — no double fire, no missed fire |
| IT-M9-07-03 | integration | file_watch on a repo while a FakeProvider agent edits files inside `.orchestra/worktrees/` | zero runs triggered by agent edits (ignore list holds); an edit to a watched source path does trigger one debounced run |
| IT-M9-07-04 | integration | automated mission whose first task hits an M9-04 gate | run state `waiting`; after approval it becomes `running` then `succeeded`; after rejection `failed` with the gate reason |
| E2E-M9-07-01 | e2e | Playwright: create a cron automation via the UI, dry-run it, wait for a real fire, inspect the run detail and the created mission | dry-run creates no mission; the real fire links a mission; the run detail shows the rendered title and the trigger payload |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-07-01 | Scheduled mission | 1. Team mode; as carol (Admin) open Settings → Automations → New. 2. Cron `*/2 * * * *`, timezone `Africa/Cairo`, playbook `bugfix`, repo `~/orchestra-scratch`, budget 1 window-hour. 3. Check the "next 5 fires" preview. 4. Wait 4 minutes. | The preview matches the expression in the chosen timezone; two runs appear; each creates a mission visible in Missions with "Started by automation"; the second is not a duplicate. | ⬜ |
| TC-M9-07-02 | Git push trigger with dedupe | 1. Create a `git_push` automation for branch `main`, copy the webhook URL and secret. 2. Configure the scratch repo's remote to POST there (or replay a captured payload twice with `curl` and a correct signature). 3. Push a commit. 4. Re-deliver the identical payload. | The first delivery creates a run and a mission; the re-delivery returns 409 and shows `skipped · duplicate` with the `dedupe_key` (the commit sha) visible in the run detail. | ⬜ |
| TC-M9-07-03 | Negative: bad webhook signature and stale replay | 1. POST the payload with a wrong signature. 2. POST with a valid signature but a timestamp 20 minutes old. 3. POST 30 bad requests in a minute. | 401 in both cases with distinct messages; no run rows created; `automation.webhook_rejected` events and audit rows with `outcome: denied` exist; the burst is rate-limited without affecting valid deliveries to other automations. | ⬜ |
| TC-M9-07-04 | Negative: automation owned by an under-privileged user | 1. Create an automation owned by bob (Viewer) — as Admin, set `ownerUserId: bob`. 2. Fire it manually. 3. Deactivate bob and fire again. | First fire: run `failed` with `FORBIDDEN: task.delegate` and an audit row; no quota spent. After deactivation: run `skipped(owner_inactive)` and the automation shows a warning banner in the list. | ⬜ |
| TC-M9-07-05 | Budget guardrail | 1. Set the automation budget to a value below one task's estimate, or exhaust the owner's reserve. 2. Fire manually. 3. Restore the budget and fire again. | First fire: `skipped · budget exhausted` with the ledger's reason string; no mission, no session, no quota used. Second fire: runs normally. | ⬜ |
| TC-M9-07-06 | Resilience: restart and downtime catch-up | 1. Cron every minute, `catchUp: 'once'`. 2. Stop the daemon for 20 minutes. 3. Start it again and watch for 3 minutes. | Exactly one catch-up run (not 20), then the normal cadence resumes; `next_fire_at` is correct in the DB; no duplicate runs for the same scheduled minute; `orch audit verify` still ok. | ⬜ |
| TC-M9-07-07 | File watch does not self-trigger | 1. Create a `file_watch` automation on `src/**/*.ts` in the scratch repo. 2. Start a normal agent session that edits files inside `.orchestra/worktrees/<taskId>/src/`. 3. Then edit `src/index.ts` in the main checkout by hand. | The agent's edits trigger nothing (worktrees ignored); the manual edit triggers exactly one debounced run listing the changed path. | ⬜ |
| TC-M9-07-08 | Concurrency cap | 1. Set `concurrency: { max: 1, onBusy: 'skip' }` on a cron automation whose mission takes longer than the interval. 2. Let it fire three times. | Only one mission runs at a time; the other two runs are `skipped · concurrency` with `active: 1, max: 1` in the detail; no orphan missions. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All five trigger kinds work, each with a dedupe key, a concurrency policy and a run record — including `skipped` outcomes, which are recorded rather than silently dropped.
- [ ] Dedupe, admission and catch-up are pure rules with 100 % branch coverage; a week of downtime produces at most one catch-up run.
- [ ] Automations execute as their owner: M9-01 permissions, M9-04 gates and M4-04 budgets apply with no privileged bypass (AT-M9-07-01/02, IT-M9-07-04, TC-M9-07-04/05).
- [ ] The webhook verifies an HMAC signature in constant time, enforces a timestamp window and a body cap, rate-limits abuse, and audits every rejection.
- [ ] The scheduler survives restarts with no double fire and no missed fire (IT-M9-07-02, TC-M9-07-06).
- [ ] File watching never observes `.orchestra/worktrees/`, so agents cannot trigger their own automation (IT-M9-07-03, TC-M9-07-07).
- [ ] Run history shows the trigger payload (redacted), the decision, the mission link and the budget used; dry-run creates nothing.
- [ ] All TC-M9-07-* pass and are recorded.
- [ ] No new lint/arch violations, including the M9-01 architecture test with the webhook route reviewed in the public-route allowlist.
- [ ] `docs/deployment/automations.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Cost runaway is the headline risk.** A five-minute cron on an expensive playbook can consume a week's quota overnight. Budgets, concurrency caps and `maxEnabled` bound it, but the first real use should be watched; consider a mandatory budget on every automation (currently optional) (verify after the first week of use).
- Feedback loops: `mission_completed` chaining plus a `file_watch` on the same repo can oscillate. The chain-depth cap (3) and the worktree ignore list cover the known paths, but an automation that commits to a watched branch and triggers a `git_push` automation is still possible — document it and consider a loop detector in M10.
- The webhook is the first inbound surface with its own auth scheme. Sharing the `/hooks/*` allowlist entry is convenient and dangerous; it must be a *separate* allowlist entry with its own review note, or the architecture test's value drops.
- Storing the webhook secret: a hash is enough to verify HMAC only if the scheme is a MAC over a key we must keep in plaintext — in practice the secret must be recoverable, so `webhook_secret_hash` is a misnomer and the column will hold an encrypted value pending M9-09's decision (verify and rename before implementing; do not ship a plaintext secret column).
- Cron/DST correctness depends on the wrapped library; the "skipped hour yields no fire, repeated hour yields one fire" claim must be proven by UT-M9-07-01 against the chosen library, not assumed (verify).
- `automations` and `automation_runs` are not in `04-domain-model.md` §4 and the `automation.*` event namespace is not in §3 — the domain model doc needs an update (not done here), consistent with the M9-01/02/04 flags.
- `file_watch` on a large monorepo can exhaust inotify watches on Linux (and behaves differently on macOS FSEvents). `maxWatchedPaths` guards the config, but the OS limit may still bite in the container (M9-06) — document the `fs.inotify.max_user_watches` requirement (verify).
- The ROADMAP places M9-07 as depending only on M3-02, yet the design above depends on M9-01, M9-04 and M4-04 for its safety properties. Lane C in the milestone README already schedules the integration pass; the ROADMAP dependency column is arguably understated (inconsistency, not fixed here).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
