# Step M8-08 — Instruction fragments, auto-answer & notifications editors

| Field | Value |
|---|---|
| Milestone | M8 — Customization & skills |
| Status | ⬜ Not started |
| Depends on | M8-01 |
| Estimated effort | 2 days |
| Packages touched | `packages/core`, `packages/sdk`, `packages/catalog`, `packages/providers/*`, `apps/daemon`, `apps/web`, `packages/ui`, `apps/cli` |
| Risk | High |
| Owner | |

## 1. Goal
After this step the three remaining "how does my fleet behave" surfaces are editable data. **Instruction fragments** — ordered, scoped snippets — compose into each provider's native instruction file (`CLAUDE.md`, `AGENTS.md`, whatever `manifest.paths.instructionFile` names) and are written into every task worktree at creation inside a marked managed block that never reaches a `TaskResult` diff. **Auto-answer rules** extend M1-11's conservative v1 into an editable, ordered rule list (auto-approve read-only tools and tests, auto-deny destructive commands, escalate infra to admin and `merge:main` to the lead, timeout → notify → pause) where every automatic decision is audited with the rule id and can be overridden while the prompt is still open. **Notification channels** (desktop, Web Push, HMAC-signed webhook) and **update channels** (stable/beta per artifact) get editors with a test-send and a preview.

## 2. Why
- **D7 / source plan §16** — instruction fragments, auto-answer rules, notification channels and update channels are the last four items on the settings-and-customization list. After this step nothing in the §16 list is code.
- **D14 / G1 / G4** — a prompt nobody sees blocks an agent. Auto-answer is how the boring 80 % stops interrupting, and escalation is how the dangerous 20 % reaches the right person fast. Neither is safe without an audit trail.
- **C10** — an auto-approved permission is a spend-and-act decision made without a human. Every one of them gets a `prompt.auto_answered` event **and** an `audit.*` row naming the rule (milestone exit criterion 9).
- **G3 / C1** — instruction fragments are the documented fallback for providers with no skills directory (M8-04 `excluded:no-skills-location`): the same guidance, delivered through the vendor's own documented instruction file.
- **C2** — a webhook is the only outbound channel Orchestra gains here. It goes through the allowlisted egress module, is HMAC-signed, and is user-configured; nothing is sent to a vendor endpoint.
- **C13 / G5** — composed instruction files must not leak secrets into a repo or into a commit; the managed block is reverted before result collection and excluded from git.

## 3. Scope
### In scope
- `instructions` settings section: ordered fragments with `id`, `title`, `body`, `appliesTo {providers[], taskTypes[], platforms[], roles[]}`, `order`, `enabled`; scopes org → workspace → user → task.
- Pure `InstructionComposer`: fragment selection, ordering, deduplication, size budget, managed-block rendering with a content hash.
- `InstructionWriter` per provider driven by `manifest.paths.instructionFile`; written at worktree creation (hooks the M1-03 `CreateWorktree` path, next to M8-04's skill install), reverted before M3-03 result collection, excluded via `.git/info/exclude`.
- `autoAnswer` settings section: ordered rules with a matcher and an action, replacing M1-11's three config booleans while preserving their behaviour as the shipped default rule set.
- `AutoAnswerEngine` (pure): prompt + rules → decision (`approve | deny | escalate | ask` ) + matched rule id + reason; deterministic, first-match-wins, with an explicit default rule.
- Timeout policy per rule: `notify` then `pause` (session paused rather than a guessed answer), extending M1-11's `ExpirePrompts`.
- `notifications` settings section: channels (`desktop`, `push`, `webhook`) with per-channel event filters, quiet hours, coalescing window; test-send per channel.
- `updates` settings section: channel (`stable | beta`) per artifact family (app/daemon, provider plugins, manifests, catalog, skill packs), consumed by M6-03 / M6-05 / M7-02.
- Editors for all four under Settings, plus an **auto-answer simulator** that replays recorded prompt fixtures through the rule list.
- CLI: `orch instructions preview|render`, `orch autoanswer test`, `orch notify test <channel>`.
### Out of scope (deferred to …)
- Approval gates and 4-eyes (a *second human*, not an automatic decision) → deferred to M9-04.
- RBAC for "who is admin" in the escalate action → deferred to M9-01; until then `escalate` raises the prompt's priority and tags it, targeting the single local user.
- Web Push delivery mechanics (subscriptions, VAPID, service worker) → owned by M7-03; this step configures *which events* go to that channel and tests it.
- Desktop notification delivery → owned by M7-01 (Tauri); same relationship.
- The update *mechanism* (signed fetch, rollback, staged rollout) → M6-03 / M7-02; this step only selects the channel per artifact.
- Per-provider instruction-file *dialects* beyond plain Markdown — the composer writes Markdown into whatever path the manifest names; anything smarter needs an ADR.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
Three pure services in `packages/core`: `InstructionComposer` (`src/instructions/`), `AutoAnswerEngine` (`src/prompts/auto-answer/`), `NotificationRouter` (`src/notifications/`).

**InstructionComposer rules**
- Selection: a fragment applies when every declared `appliesTo` facet matches (empty facet = matches all). Scope precedence resolves same-`id` fragments (task > user > workspace > org), exactly as M8-01.
- Ordering: `order` asc, then scope precedence (lower scope first, so org guidance leads and user guidance follows and can contradict it in context), then id asc. Deterministic.
- Size budget: composed managed block ≤ `instructions.maxBytes` (default 8 KiB). Over budget ⇒ fragments are dropped from the end, and the block ends with an explicit note naming the dropped fragment ids (`W_INSTRUCTIONS_TRUNCATED`) — silently truncating an agent's instructions is worse than saying so.
- Managed block format, always exactly this shape:
  ```
  <!-- orchestra:begin v1 hash=<sha256-12> do-not-edit -->
  …composed fragments…
  <!-- orchestra:end -->
  ```
  Anything outside the markers is the user's own file and is preserved byte-for-byte. A pre-existing block with a different hash is replaced; a *modified* block (hash mismatch against its own content) is replaced and the modification is reported in Health (someone or something edited it).
- Secret-shaped literals in a fragment ⇒ `E_SECRET_IN_FRAGMENT` at load time (C13).
- Revert rule: before result collection (M3-03), the managed block is removed and the file restored to its pre-composition bytes; if the file did not exist before, it is deleted. Asserted by IT-M8-08-03.

**AutoAnswerEngine rules**
- Input: `AgentPrompt` (kind, risk, payload: tool, command, files, plan) + the resolved rule list + context (task type, provider, worktree path).
- First match wins, in list order; the last rule is always the implicit `{ match: {}, action: 'ask' }` — an unmatched prompt reaches a human, never an automatic answer.
- Matchers are declarative only: `kind`, `tool` (glob), `command` (anchored regex, compiled with a 50 ms budget and a size cap — a catastrophic-backtracking pattern is rejected at save time), `pathScope` (`inside-worktree | outside-worktree | any`), `risk`, `taskTypes`, `providers`.
- Actions: `approve`, `deny` (with a reason string sent to the agent), `escalate` (raise priority, tag `admin` or `lead`, keep open), `ask` (leave for a human).
- **Hard floor, enforced in core and not overridable by any rule**: a prompt classified `risk: high` by M1-11's `PromptClassifier` can never be `approve`d automatically; a rule attempting it is rejected at save time (`E_UNSAFE_AUTO_APPROVE`) and, if one somehow reaches evaluation, the engine downgrades it to `escalate` and records `reason: 'high-risk-floor'`. Auto-*deny* of a high-risk prompt is always allowed.
- A rule's decision is only advisory until `AnswerPrompt` (M1-11) delivers it through the existing transport — this step adds no new answer path.
- Determinism: same prompt + same rules ⇒ same decision and same matched rule id.

**NotificationRouter rules**
- Event → channels by filter; coalescing within `coalesceWindowMs` per `(channel, correlation key)` so ten task events in a mission become one notification (UX budget "notifications coalesced and deep-linked").
- Quiet hours suppress everything except prompts whose priority is `1` (login/error) and escalations.
- Every notification carries a deep link (`/attention/:promptId`, `/missions/:id`, …).

### 4.2 Interfaces / contracts
```ts
// packages/core/src/instructions/types.ts
export interface InstructionFragment {
  id: string; title: string; body: string; order: number; enabled?: boolean;
  appliesTo?: { providers?: readonly ProviderId[]; taskTypes?: readonly TaskTypeId[];
                platforms?: readonly string[]; roles?: readonly RoleName[] };
  scope: 'org' | 'workspace' | 'user' | 'task';  file?: string;
}
export interface ComposeContext { provider: ProviderId; taskTypeId?: TaskTypeId; platform?: string;
  role?: RoleName; instructionFile: string; maxBytes: number }
export interface ComposedInstructions {
  block: string; hash: string; usedFragmentIds: readonly string[];
  droppedFragmentIds: readonly string[]; bytes: number; warnings: readonly string[];
}
export class InstructionComposer {
  compose(fragments: readonly InstructionFragment[], ctx: ComposeContext): ComposedInstructions;   // pure
  static readonly BEGIN = '<!-- orchestra:begin';
  static readonly END = '<!-- orchestra:end -->';
}

// packages/core/src/prompts/auto-answer/types.ts
export interface AutoAnswerRule {
  id: string; label: string; enabled?: boolean;
  match: { kind?: PromptKind; tool?: string; command?: string; pathScope?: 'inside-worktree' | 'outside-worktree' | 'any';
           risk?: RiskLevel; taskTypes?: readonly TaskTypeId[]; providers?: readonly ProviderId[] };
  action: { type: 'approve' } | { type: 'deny'; reason: string }
        | { type: 'escalate'; to: 'admin' | 'lead'; reason?: string } | { type: 'ask' };
  timeout?: { afterMs: number; then: 'notify' | 'notify-then-pause' };
}
export interface AutoAnswerDecision {
  action: AutoAnswerRule['action']['type']; ruleId: string; reason: string;
  downgradedFrom?: 'approve';                    // set when the high-risk floor intervened
}
export class AutoAnswerEngine {
  constructor(private readonly rules: readonly AutoAnswerRule[]) {}
  decide(p: AgentPrompt, ctx: { taskTypeId?: TaskTypeId; provider: ProviderId; worktreePath?: string }):
    AutoAnswerDecision;                          // pure, total, first-match-wins, default 'ask'
  static validate(rules: readonly AutoAnswerRule[]):
    Result<void, readonly { code: 'E_UNSAFE_AUTO_APPROVE' | 'E_BAD_REGEX' | 'E_DUPLICATE_RULE_ID'; ruleId: string; detail: string }[]>;
}

// packages/core/src/notifications/types.ts
export type ChannelId = 'desktop' | 'push' | 'webhook';
export interface ChannelConfig {
  id: ChannelId; enabled: boolean;
  events: readonly string[];                     // event type globs, e.g. ['prompt.opened', 'mission.*']
  minPriority?: 1 | 2 | 3 | 4 | 5;
  webhook?: { url: string; secretRef: string };  // secretRef → env/keychain key name, NEVER the secret (C13)
}
export interface NotificationSettings { channels: readonly ChannelConfig[];
  quietHours?: { from: string; to: string; tz: string }; coalesceWindowMs: number }
export class NotificationRouter {
  route(ev: DomainEvent, cfg: NotificationSettings, now: Instant):
    readonly { channel: ChannelId; coalesceKey: string; deepLink: string }[];   // pure
}
```

```yaml
# any layer — the four sections this step registers
instructions:
  maxBytes: 8192
  fragments:
    - id: flutter-analyze
      title: Always run flutter analyze
      order: 10
      appliesTo: { platforms: [flutter] }
      body: "Before finishing, run `flutter analyze` and fix every warning you introduced."

autoAnswer:
  rules:
    - { id: readonly-tools, label: Read-only tools, match: { kind: permission, tool: "Read|Grep|Glob", pathScope: inside-worktree, risk: low }, action: { type: approve } }
    - { id: tests,          label: Test commands,   match: { kind: permission, command: "^(pnpm|npm|yarn) (test|run test)\\b" }, action: { type: approve } }
    - { id: destructive,    label: Destructive,     match: { kind: permission, risk: high }, action: { type: deny, reason: "Destructive commands require a human." } }
    - { id: infra,          label: Infra,           match: { kind: permission, taskTypes: [infra, release] }, action: { type: escalate, to: admin } }
    - { id: merge-main,     label: Merge to main,   match: { kind: confirm, command: "merge.*\\bmain\\b" }, action: { type: escalate, to: lead },
        timeout: { afterMs: 600000, then: notify-then-pause } }

notifications:
  coalesceWindowMs: 30000
  quietHours: { from: "22:00", to: "07:30", tz: "Africa/Cairo" }
  channels:
    - { id: desktop, enabled: true,  events: ["prompt.opened", "mission.completed"], minPriority: 3 }
    - { id: webhook, enabled: false, events: ["mission.*"], webhook: { url: "https://example.internal/hook", secretRef: "ORCH_WEBHOOK_SECRET" } }

updates: { app: stable, providerPlugins: stable, manifests: stable, catalog: beta, skillPacks: stable }
```

### 4.3 Data / schema changes
- No new tables for instructions or auto-answer: fragments and rules live in settings layers (M8-01), decisions live in `events` and `audit_log`.
- Migration `m8_08_worktree_instructions`: `worktrees.instructions_json TEXT NULL` — `{provider, file, hash, usedFragmentIds, droppedFragmentIds, preexisting: boolean, backupRef}` so the revert is exact and auditable.
- Migration `m8_08_prompt_rule`: `agent_prompts.auto_rule_id TEXT NULL`, `agent_prompts.auto_decision TEXT NULL`, `agent_prompts.escalated_to TEXT NULL`, `agent_prompts.paused_at TEXT NULL`.
- New table `notification_deliveries`: `id, channel, event_type, correlation_json, deep_link, coalesced_count, status ('sent'|'failed'|'suppressed'), error, created_at` — needed so a webhook failure is visible instead of silent.
- Events: `instructions.composed {taskId, provider, file, hash, used[], dropped[]}`, `instructions.reverted {taskId, file}`, `notification.sent|failed|suppressed {channel, eventType, reason?}`, plus `prompt.auto_answered` (already in `04 §3`) extended with `{ruleId, action, downgradedFrom?}`.
- `audit_log` rows for every auto-answer decision (`action: 'prompt.auto_answered'`, `actor: {kind:'policy', id: ruleId}`), for webhook config changes, and for update-channel changes (switching to `beta` changes what code runs).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- `InstructionWriter` (`apps/daemon/src/infrastructure/instructions/`): resolves `manifest.paths.instructionFile` for the session's provider *(verify each provider's documented instruction filename at step start — `CLAUDE.md` and `AGENTS.md` are the known shapes)*; reads any pre-existing file into a backup under `~/.orchestra/instruction-backups/<taskId>/`; writes the composed block (append if the file exists, create otherwise); adds the filename to the worktree's `.git/info/exclude` (M1-03 already owns that file) so it can never enter a diff or a commit.
- Ordering at session start: `CreateWorktree` → skills install (M8-04) → instructions compose/write → `Launcher.preLaunchFiles()` → `SessionSupervisor.start()`. Instructions are written **before** launch because the CLI reads them at start.
- Revert: `CollectTaskResult` (M3-03) calls `RevertInstructions` *before* computing the diff; a failure to revert marks the task result with a warning rather than silently shipping the block.
- Auto-answer integration: `OpenPrompt` (M1-11) calls `AutoAnswerEngine.decide()`; `approve`/`deny` route straight into the existing `AnswerPrompt` use case with `actor: {kind:'policy', id: ruleId}`; `escalate` sets priority and tag and leaves it open; timeouts extend M1-11's persisted deadline scheduler, and `notify-then-pause` stops the pane through `SessionSupervisor` (a documented pause, not a killed session) and emits a notification.
- Webhook delivery: through the **allowlisted egress module only** (C2), POST JSON with headers `X-Orchestra-Event`, `X-Orchestra-Delivery`, `X-Orchestra-Signature: sha256=<hmac>` over the raw body. The secret is read from env/keychain by `secretRef`; the settings file holds the *name*, never the value (C13, engineering standards). Timeout 5 s, 2 retries with backoff, failures recorded in `notification_deliveries` and surfaced in Health. No redirects followed; URL must be `https:` (or `http://127.0.0.1` for local testing).
- Update channels: `updates.*` is read by M6-03 (manifest registry), M6-05 (release watchers) and M7-02 (app updater). This step writes and validates the setting and warns on `beta` with the consequence spelled out; it changes no update mechanism.
- No tmux beyond the existing pause path; no child processes.

### 4.5 API / UI surface
- `POST /api/instructions/preview` — body `{ provider, taskTypeId?, platform?, repo? }` → `ComposedInstructions` (exact bytes that would be written, plus target path).
- `GET /api/worktrees/:id/instructions` → what was written for that task and whether it is still present.
- `POST /api/autoanswer/simulate` — body `{ promptFixtureIds?[] | prompts[] }` → per prompt `{ decision, ruleId, reason, downgradedFrom? }`.
- `POST /api/notifications/test` — body `{ channel }` → sends one synthetic notification; returns delivery status (webhook: HTTP status + signature header echoed, never the secret).
- `GET /api/notifications/deliveries?limit=` → recent deliveries with status and error.
- Settings writes reuse M8-02's `PUT /api/settings/layers/:layer`; no new write path.
- CLI: `orch instructions preview --provider claude --task-type feature-impl`, `orch instructions render --task <taskId>`, `orch autoanswer test [--fixtures]`, `orch notify test webhook`.
- UI `apps/web/src/features/settings/`:
  - `InstructionsEditor` — fragment list (drag to reorder, enable toggle, scope chip, `appliesTo` facet chips), Markdown body editor, and a **live composed preview** with a provider selector, the target filename from the manifest, a byte counter against `maxBytes` and an explicit *truncated* warning listing dropped fragments.
  - `AutoAnswerEditor` — ordered rule list (drag to reorder, first-match-wins made visible by numbering), rule form (matcher fields with a regex tester showing sample matches, action with reason text, timeout), a permanent banner stating the high-risk floor, and disabled `approve` for any matcher that selects `risk: high`.
  - `AutoAnswerSimulator` — pick recorded prompt fixtures (from `packages/providers/*/fixtures/` and `FakeProvider` scenarios) or paste a prompt; shows which rule matched, the decision and the reason, with the matched rule highlighted in the list.
  - `NotificationsEditor` — per-channel card (enabled, event filter with autocomplete over the event catalog, min priority), quiet hours, coalescing window, **Send test** per channel with the delivery result inline; webhook card shows the `secretRef` name and a "not stored here" note.
  - `UpdateChannelsEditor` — per-artifact `stable | beta` with a consequence line ("beta manifests are applied hot and can change how a CLI is driven") and an audit note.
  - States: `loading`, `clean/dirty/invalid/saving/conflict` (shared `EditorShell` from M8-02), `preview-truncated`, `test-sending`, `test-failed`, `channel-unavailable` (desktop before M7-01, push before M7-03 — shown as *available in M7* rather than broken).
- Accessibility: rule order is numbered text; the high-risk floor is text; delivery status is icon + word; regex tester output is a list, not colour highlighting alone; EN/AR and RTL.

### 4.6 Flow / sequence
```
task start
  CreateWorktree (M1-03)
   ├─▶ InstallSkills (M8-04)
   ├─▶ InstructionComposer.compose(fragments, {provider, taskType, platform, instructionFile, maxBytes})
   │     ─▶ backup pre-existing file ─▶ write managed block ─▶ .git/info/exclude entry
   │     ─▶ worktrees.instructions_json ─▶ instructions.composed
   └─▶ Launcher.preLaunchFiles ─▶ SessionSupervisor.start ─▶ agent reads CLAUDE.md / AGENTS.md natively

agent stops and asks ─▶ OpenPrompt (M1-11) ─▶ PromptClassifier ─▶ AgentPrompt{kind, risk}
   └─▶ AutoAnswerEngine.decide(prompt, ctx)  (first match wins; default 'ask')
        ├─ approve|deny ─▶ high-risk floor check ─▶ AnswerPrompt(actor={kind:'policy', id:ruleId})
        │                  ─▶ prompt.auto_answered{ruleId, action} + audit_log ─▶ agent continues
        ├─ escalate      ─▶ priority raised + tag(admin|lead) ─▶ stays open ─▶ Attention (top) ─▶ notification
        └─ ask           ─▶ Attention as today
   timeout (rule) ─▶ notify ─▶ [notify-then-pause] SessionSupervisor.pause(pane) ─▶ prompt stays open

domain event ─▶ NotificationRouter.route(ev, cfg, now)
   ─▶ quiet hours? (priority 1 and escalations exempt) ─▶ coalesce by key within window
   ─▶ desktop (M7-01) | push (M7-03) | webhook (egress module, HMAC-signed, 2 retries)
   ─▶ notification_deliveries row ─▶ notification.sent|failed|suppressed ─▶ Health

task finishes ─▶ RevertInstructions (before M3-03 diff) ─▶ restore backup / delete created file
   ─▶ instructions.reverted ─▶ CollectTaskResult ─▶ diff contains no instruction block
```

## 5. Tasks
- [ ] `InstructionFragment` VO + `InstructionComposer` (selection, ordering, size budget with named drops, managed-block render + hash); 100 % branch coverage.
- [ ] Register `instructions`, `autoAnswer`, `notifications`, `updates` settings sections against M8-01 (schemas, task-overridability for `instructions` and `autoAnswer`, JSON Schema export for the editors).
- [ ] `InstructionWriter` + `RevertInstructions` use cases: manifest path resolution, backup, append/create, `.git/info/exclude`, exact revert, warning on revert failure; migration `m8_08_worktree_instructions`.
- [ ] Hook compose/write into the M1-03 → session-start path after skills install and before `preLaunchFiles`; hook revert into M3-03 before diff computation.
- [ ] `AutoAnswerEngine` (pure, first-match-wins, default `ask`) + `validate()` (unsafe auto-approve, bad/catastrophic regex, duplicate ids); high-risk floor enforced in core with `downgradedFrom` reporting.
- [ ] Replace M1-11's config booleans with a shipped default rule set that reproduces v1 behaviour exactly; regression test against M1-11's AT-M1-11-05.
- [ ] Extend `OpenPrompt` / `AnswerPrompt` / `ExpirePrompts` for rule-driven decisions, escalation tagging, and `notify-then-pause`; migration `m8_08_prompt_rule`; audit row per auto-decision.
- [ ] `NotificationRouter` (filters, min priority, quiet hours, coalescing, deep links) + `notification_deliveries` migration.
- [ ] `WebhookChannel` in the allowlisted egress module: HMAC-SHA256 signing, `secretRef` from env/keychain, https-only, no redirects, 5 s timeout, 2 retries, delivery records; egress test updated (C2). Desktop and push channels are thin bindings to M7-01 / M7-03 with an *unavailable until M7* state.
- [ ] `updates` section validation + consequence warnings; wire reads in M6-03 / M6-05 / M7-02 (no mechanism change).
- [ ] Controllers: instructions preview/render, autoanswer simulate, notifications test/deliveries + OpenAPI.
- [ ] `apps/web`: `InstructionsEditor` (with live composed preview and byte counter), `AutoAnswerEditor` (ordered rules, regex tester, disabled unsafe approve), `AutoAnswerSimulator`, `NotificationsEditor` (test-send), `UpdateChannelsEditor`.
- [ ] CLI `orch instructions preview|render`, `orch autoanswer test`, `orch notify test <channel>`.
- [ ] Docs: "Instruction fragments", "Auto-answer rules (and what can never be automatic)", "Notification and update channels".

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M8-08-01 | unit | compose with fragments from four scopes, mixed `appliesTo` | only matching fragments included, ordered by `order` then scope then id; deterministic across runs; hash stable |
| UT-M8-08-02 | unit | fragments exceeding `maxBytes` | trailing fragments dropped, `droppedFragmentIds` populated, the block ends with an explicit note; never a silent truncation |
| UT-M8-08-03 | unit | compose over a file with user content and a stale managed block | user content outside the markers preserved byte-for-byte; the stale block replaced; a hand-modified block reported |
| UT-M8-08-04 | unit | rule list where a rule approves `risk: high` | `validate()` returns `E_UNSAFE_AUTO_APPROVE`; if evaluated anyway, `decide()` returns `escalate` with `downgradedFrom: 'approve'` |
| UT-M8-08-05 | unit | first-match-wins over 6 rules; prompt matching none | the earlier rule's id returned; unmatched prompt ⇒ `ask` via the implicit default rule |
| UT-M8-08-06 | unit | catastrophic-backtracking regex and a duplicate rule id | `E_BAD_REGEX` / `E_DUPLICATE_RULE_ID` at save time; evaluation budget never exceeded |
| UT-M8-08-07 | unit | router: 10 task events in the window / quiet hours with a priority-1 prompt / suppressed low-priority event | one coalesced notification with count / delivered despite quiet hours / `suppressed` with reason |
| AT-M8-08-01 | application | auto-approve of a read-only tool prompt | `prompt.auto_answered {ruleId}` **and** an `audit_log` row with `actor.kind = 'policy'`; agent continues through the existing transport |
| AT-M8-08-02 | application | escalate rule on an infra prompt | prompt stays open with raised priority and `escalated_to='admin'`; a notification is routed; no answer delivered |
| AT-M8-08-03 | application | `notify-then-pause` timeout | notification sent, pane paused via the supervisor, prompt still open and answerable; resuming works |
| IT-M8-08-01 | integration | task start with two matching fragments | `CLAUDE.md` (per manifest) exists in the worktree with the managed block; `.git/info/exclude` contains it; `worktrees.instructions_json` records the hash |
| IT-M8-08-02 | integration | pre-existing `AGENTS.md` with user content | user bytes preserved; block appended; after revert the file is byte-identical to the original |
| IT-M8-08-03 | integration | full task → result collection | the `TaskResult` diff contains no instruction file or block; `instructions.reverted` emitted before the diff was computed |
| IT-M8-08-04 | integration | webhook test send | HTTPS POST through the egress module with a valid HMAC signature; the secret value never appears in logs, events or the settings file; failure recorded with the HTTP status |
| IT-M8-08-05 | integration | M1-11 parity | with the shipped default rules, M1-11's auto-answer tests (read-only approve, destructive left/denied) still pass unchanged |
| E2E-M8-08-01 | e2e | auto-answer simulator over recorded fixtures | each fixture shows the matched rule, decision and reason; reordering rules changes the outcome as first-match-wins predicts |
| E2E-M8-08-02 | e2e | instructions live preview | selecting a provider shows the exact target filename and bytes; exceeding the budget shows the truncation warning with the dropped ids; axe-clean dark + RTL |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M8-08-01 | Fragment reaches the agent | 1. Settings › Instructions, add a workspace fragment "Always run `flutter analyze` before finishing" with `appliesTo.platforms: [flutter]` 2. Start a task on the Flutter scratch repo 3. `cat .orchestra/worktrees/<task>/CLAUDE.md` | The managed block is present with the fragment between the markers and a hash in the begin marker; the preview in the editor matched the file byte-for-byte | ⬜ |
| TC-M8-08-02 | No leakage into results | 1. Finish that task 2. Open Review → the task diff 3. `git log -p` on the branch | The diff and the commits contain no `CLAUDE.md` and no managed block; `instructions.reverted` appears in History before the result | ⬜ |
| TC-M8-08-03 | Mixed auto-answer run (exit criterion 9) | 1. Run the `FakeProvider` scenario `prompts-mixed` 2. Watch Attention 3. Open History | Read-only permission auto-approved (no card); `rm -rf` auto-denied with the reason reaching the agent; infra command escalated to Attention with admin priority; three `prompt.auto_answered` / `audit` rows each naming the rule id | ⬜ |
| TC-M8-08-04 | Override while open | 1. Configure `merge:main` to escalate to lead with a 10-minute `notify-then-pause` 2. Trigger it, wait for the timeout 3. Answer from Attention | Notification fires; the pane pauses rather than guessing an answer; answering from Attention resumes the agent and the prompt is marked answered by the user, not the policy | ⬜ |
| TC-M8-08-05 | Webhook channel | 1. Export `ORCH_WEBHOOK_SECRET`, configure a webhook channel to a local listener 2. Send test 3. Complete a mission | The listener receives an HMAC-signed JSON payload with a deep link; signature verifies with the env secret; the settings file contains only `secretRef`; deliveries are listed with status | ⬜ |
| TC-M8-08-06 | Negative: unsafe rule | 1. Try to add a rule that auto-approves `risk: high` 2. Try a matcher with the regex `(a+)+$` | Save refused with `E_UNSAFE_AUTO_APPROVE` and the reason; the `approve` action is disabled in the form for that matcher; the regex is refused as `E_BAD_REGEX` | ⬜ |
| TC-M8-08-07 | Negative: conflicting layers and invalid YAML | 1. Put an `autoAnswer.rules` list in `org.yaml` and a `rules!append` in `user.yaml` 2. Then break the YAML in `user.yaml` | Append semantics apply with org rules first (M8-01), visible in the numbered list with scope chips; after the break, the previous rule set stays in effect, the banner names file and line, and no prompt is auto-answered by a half-parsed rule | ⬜ |
| TC-M8-08-08 | Negative: oversized instructions | 1. Add fragments totalling > 8 KiB for one provider 2. Open the preview and start a task | Preview shows the truncation warning listing dropped fragment ids; the written block matches the preview exactly and ends with the same note; no silent loss | ⬜ |
| TC-M8-08-09 | Update channel | 1. Set `updates.catalog: beta` 2. Read the consequence text and History | The consequence is stated before saving; an `audit_log` row records the change; M6-03/M6-05 read the new channel on their next run (no mechanism change in this step) | ⬜ |
| TC-M8-08-10 | Reload / resilience | 1. With rules and fragments configured, `kill -9` the daemon mid-task 2. Restart 3. Trigger a read-only prompt and finish the task | Rules and fragments identical after the restart; the worktree's managed block is still present and still excluded from git; the auto-answer works; revert on completion still produces a clean diff | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Composed instruction files are written into every new worktree at the manifest-declared path, with a hashed managed block that preserves any pre-existing user content (IT-M8-08-01/02, TC-M8-08-01).
- [ ] Composed instructions never appear in a `TaskResult` diff or a commit, and are reverted exactly before result collection (IT-M8-08-03, TC-M8-08-02) — milestone exit criterion 8.
- [ ] Over-budget composition drops fragments explicitly and names them, in the preview and in the written file (UT-M8-08-02, TC-M8-08-08).
- [ ] Auto-answer rules are ordered and first-match-wins with an implicit `ask` default (no unmatched prompt is ever auto-answered), and a high-risk prompt can never be auto-approved — rejected at save time, downgraded to escalate at evaluation (UT-M8-08-04/05, TC-M8-08-06).
- [ ] Every auto-decision writes `prompt.auto_answered` with the rule id **and** an `audit_log` row with `actor.kind = 'policy'` (AT-M8-08-01, TC-M8-08-03) — milestone exit criterion 9.
- [ ] M1-11's v1 behaviour is reproduced exactly by the shipped default rule set; its tests pass unchanged (IT-M8-08-05).
- [ ] Webhooks are HTTPS-only, HMAC-signed, sent through the allowlisted egress module, with the secret referenced by name and never stored in settings, logs or events (IT-M8-08-04, TC-M8-08-05, C2/C13).
- [ ] Notifications coalesce, respect quiet hours with the priority-1 exemption, deep-link, and record every delivery attempt with status.
- [ ] All four editors are keyboard-operable and axe-clean in dark/light and RTL; rule order and decisions are text, not colour.
- [ ] All TC-M8-08-* pass; no new ESLint / dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- **Writing into the user's repo is the riskiest mechanic in M8.** A failed revert leaves a managed block in a branch that becomes a PR. Mitigations: `.git/info/exclude`, exact byte backups, revert *before* the diff is computed, a warning on the `TaskResult` when revert fails, and IT-M8-08-03 as the gate. Consider, during implementation, whether any provider supports a *local* (gitignored) instruction file variant — if one does, prefer it for that provider and record the decision *(verify against that provider's docs at step start)*.
- **Instruction filenames and semantics are vendor facts.** `CLAUDE.md` and `AGENTS.md` are the shapes we know; everything comes from `manifest.paths.instructionFile` and must be *(verified against each provider's docs at step start)*. A provider whose manifest omits it gets no instruction file and relies on skills (M8-04) instead — and a provider with neither is a Doctor finding, not a silent no-op.
- **Auto-answer is where a misconfiguration becomes a destroyed repo.** The high-risk floor is the backstop, but `PromptClassifier`'s risk assessment (M1-11) is heuristic — a destructive command it misclassifies as low risk could be auto-approved by a broad rule. Mitigations: default rules match narrowly (explicit tool names, anchored command regexes, `pathScope: inside-worktree`), the simulator exists so rules are tested against real fixtures before they run, and every decision is auditable after the fact. Widening the shipped defaults requires evidence from the simulator.
- **Escalation has no one to escalate to until M9-01.** `to: 'admin' | 'lead'` currently raises priority and tags; in single-user mode both land on the same person. Documented in the editor so the setting is not mistaken for a permission boundary.
- **`notify-then-pause` pauses a paying session.** If the user is asleep, a paused pane holds a worktree and a concurrency slot. Mitigation: pause is per rule and off by default; Fleet shows paused panes distinctly; M4's concurrency accounting must count a paused pane as occupied — verify during implementation.
- **Webhook egress is a new outbound surface.** HTTPS-only, no redirect following, HMAC signing and a delivery log are the controls; the `no-vendor-endpoints` ESLint rule and the M0-08 egress test must be extended to cover the new module, not exempted from it.
- **Four sections in one step** is a lot of surface for 2 days. If effort overruns, the honest split is instructions + auto-answer first (they carry the exit criteria) and notification/update channel editors second; record the split in the progress log rather than shipping four half-editors.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
