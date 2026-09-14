# Step M3-05 — Review & Merge UI

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-04 |
| Estimated effort | 3 days |
| Packages touched | `apps/web` (screens/review), `packages/ui`, `apps/daemon` (application/reviews, application/merge, infrastructure/git, interface/http, interface/ws) |
| Risk | Medium |
| Owner | |

## 1. Goal
The **Review** screen (IA position 7, `12-ux-principles.md`) becomes real: a queue of tasks awaiting a decision, and for each one a diff viewer of `base..head`, the agent review rounds with their findings anchored to lines, the test status from `TaskResult`, and the human's own tools — write an inline comment, preview exactly what will be sent, and route it to the **author agent** as a follow-up; or **Approve**; or **Request changes** (which starts a new round); or **Merge**, with the merge button enabled only when the policy gate for that task is satisfied. Nothing here invents a new backend contract: it renders `TaskResult` (M3-03) and `Review`/`ReviewFinding` (M3-04) and adds one new use case, `MergeTask`, which fast-forwards or squash-merges the task branch into the mission integration branch.

## 2. Why
- Source plan §9 lists the Review & Merge module as **P0**: without it, cross-vendor review produces findings nobody can act on and branches nobody merges.
- G1 (see, control and talk to every agent in one place): the human's review comment is just another message to an agent, delivered through the same official channel as every other one (D14, `PaneController`).
- C10 (every spend/keys action previewed, permissioned, audited) and UX principle 5 (zero-surprise control): a comment sent to an agent spends quota and sends keystrokes, so it is previewed verbatim before sending and audited after.
- UX principle 4 (truth labelling): the merge button states *why* it is disabled (gate, failing tests, open blocker findings) instead of being silently greyed out.
- G5: every human decision here is an event linked to the task, mission and session, so Timeline (M5-04) can replay a review.

## 3. Scope
### In scope
- `Review` screen: queue (left), diff viewer (centre), findings + actions (right).
- Diff rendering from a new `GET /tasks/:id/diff` endpoint (unified diff text + parsed file list); viewer built on `diff2html` if its bundle fits the budget, else the in-house `DiffView` component in `packages/ui`.
- Finding anchoring: agent findings and human comments pinned to `file:line` in the diff gutter; unanchored findings listed above the diff.
- Comment composer with **preview-before-send** modal showing the exact message text and the target session/pane.
- Actions: *Approve*, *Request changes* (starts round N+1 via M3-04), *Send comments to author*, *Merge*, *Retry task*, *Open in terminal*.
- `MergeTask` use case: squash or fast-forward the task branch into the mission integration branch, conflict detection, `merged_at` on the task, `task.merged` event.
- Gate evaluation surface: `GET /tasks/:id/merge-eligibility` returning `{ allowed, blockers[] }`.
- Keyboard: `j/k` file navigation, `n/p` finding navigation, `a` approve, `r` request changes, `⌘Enter` send comment; ⌘K actions.
### Out of scope (deferred to …)
- Creating a PR / MR on GitHub or GitLab — deferred to M3-06 (the button is rendered disabled with "ships in M3-06").
- Merging the *integration branch* into `main` — deferred to M3-06 (policy-gated) and M9-04 (4-eyes).
- Mission DAG visualisation and per-task cancel/retry from a mission view — deferred to M3-08.
- Side-by-side diff mode, word-level intra-line diff, and diff search — deferred to M5-04 (Timeline reuses the viewer) unless they fall out for free.
- RBAC on who may approve/merge — deferred to M9-01 (single-user no-op guards until then).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `MergeEligibility` (pure rule, `packages/core/src/review/merge-rules.ts`):
  ```
  allowed = verdict ∈ {approved, approved_with_nits}
          ∧ no unresolved finding with severity ∈ {blocker, major}
          ∧ tests.passed ≠ false
          ∧ gateSatisfied(step.gate, actor)
          ∧ task.state ∈ {approved}
  ```
  Returns `{ allowed: boolean, blockers: MergeBlocker[] }` where `MergeBlocker = { code: 'NotApproved'|'OpenFindings'|'TestsFailed'|'GateNotSatisfied'|'BranchStale'|'MergeConflict', detail }`. 100 % branch coverage; the UI renders `blockers` verbatim.
- `HumanComment` is persisted as a `ReviewFinding` with `authorKind: 'human'`, `severity` chosen by the user (default `major`), and `sent_to_author = 0` until delivered — one table, one lifecycle, no parallel comment model.
- Gate semantics (from M3-01/M3-02): `none` ⇒ satisfied; `lead` ⇒ satisfied when the Lead called `collect(decision: accept)`; `human` ⇒ satisfied by this screen's Approve; `4-eyes` ⇒ treated as `human` with a warning badge until M9-04.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/application/reviews/dto.ts  (HTTP, Zod-validated at the edge)
export interface TaskDiffResponse {
  taskId: string; baseSha: string; headSha: string; branch: string;
  files: { path: string; oldPath?: string; status: 'added'|'modified'|'deleted'|'renamed'|'binary';
           insertions: number; deletions: number; patch?: string; truncated: boolean }[];
  totalBytes: number; truncated: boolean;          // > diff.maxBytes ⇒ per-file lazy fetch
}
export interface MergeEligibilityResponse { allowed: boolean; blockers: MergeBlocker[]; gate: Gate; strategy: MergeStrategy; }
export type MergeStrategy = 'squash' | 'ff-only' | 'merge-commit';

// apps/daemon/src/application/merge/ports.ts
export interface MergePort {
  canFastForward(repoPath: string, target: string, source: string): Promise<Result<boolean, GitError>>;
  merge(args: { repoPath: string; target: string; source: string; strategy: MergeStrategy; message: string }):
    Promise<Result<{ sha: string }, GitError | { code: 'MergeConflict'; files: string[] }>>;
}
export interface CommentPreview { sessionId: string; provider: ProviderId; paneId: string; message: string; transport: 'follow-up-message'; estimatedChars: number; }

// apps/web/src/screens/review/types.ts
export interface ReviewQueueItem { taskId: string; missionId?: string; title: string; taskType: TaskType;
  author: { provider: ProviderId; model: ModelId }; rounds: number; verdict: ReviewVerdict | null;
  tests: 'passed'|'failed'|'none'; openFindings: number; degraded: boolean; waitingOn: 'human'|'agent'|'gate'; }
```

### 4.3 Data / schema changes
- `review_findings` + migration `m3_05_findings_human`: `author_kind TEXT NOT NULL DEFAULT 'agent'` (`agent|human`), `author_user_id TEXT`, `anchor_side TEXT` (`old|new`), `anchor_sha TEXT` (so a comment stays attached to the revision it was written on), `sent_at TEXT`.
- `tasks` + migration `m3_05_tasks_merge`: `merged_at TEXT`, `merge_sha TEXT`, `merge_strategy TEXT`.
- Events: **new** `task.merge_blocked` (with blockers), `review.comment_added`, `review.comment_sent`; existing `task.merged` (catalog) now carries `{ strategy, sha, target }`.
- No new tables. Human comments live in `review_findings`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Diff generation: `git diff --patch --find-renames <baseSha>..<headSha>` executed in the repo (not the worktree — the worktree may already be removed). Cap `diff.maxBytes` (default 2 MB) for the bulk response; beyond it the file list is returned without patches and `GET /tasks/:id/diff/file?path=` fetches one file at a time.
- Merge: `git -C <repo> merge --squash` into a temporary checkout of the integration branch, or `merge --ff-only` when `canFastForward`. Never operates on the user's working checkout: the daemon uses a dedicated `.orchestra/integration/` worktree so the user's `git status` is never disturbed.
- Conflict: the merge is aborted (`git merge --abort`), `MergeConflict{files}` is returned, and the UI offers *Send conflict list to author* (a follow-up message) — the daemon never resolves conflicts itself.
- Comment delivery reuses `FollowUpSender` (M3-04) → `PaneController.sendCommand`. No new transport.

### 4.5 API / UI surface
- `GET /review/queue?state=` → `ReviewQueueItem[]` (sorted: human-blocked first, then oldest).
- `GET /tasks/:id/diff`, `GET /tasks/:id/diff/file?path=`.
- `GET /tasks/:id/merge-eligibility` → `MergeEligibilityResponse`.
- `POST /tasks/:id/comments` `{ file?, line?, side?, severity?, category?, message }` → finding row (`author_kind: human`).
- `POST /tasks/:id/comments/preview` `{ findingIds[], note? }` → `CommentPreview` (no side effects).
- `POST /tasks/:id/comments/send` `{ findingIds[], note?, previewHash }` → delivers; rejects with `409 PreviewStale` if the composed message differs from the previewed one (C10 integrity).
- `POST /tasks/:id/approve` `{ note? }`, `POST /tasks/:id/request-changes` `{ findingIds[], note? }` (starts round N+1 via M3-04), `POST /tasks/:id/merge` `{ strategy? }` (`Idempotency-Key` honoured).
- WS: `review.queue` (deltas), `task.<id>` (findings, verdict, merge state).
- **UI components** (`apps/web/src/screens/review/`, primitives into `packages/ui`):
  | Component | States |
  |---|---|
  | `ReviewQueue` | loading · empty ("no tasks awaiting review") · list · filtered |
  | `DiffView` | loading · empty (no changes) · loaded · truncated (per-file lazy) · binary file placeholder · error |
  | `FindingGutter` / `FindingCard` | agent finding (provider badge + severity) · human comment · resolved (struck) · unanchored |
  | `TestStatusBar` | passed · failed (tail expandable) · not configured · timed out |
  | `RoundTimeline` | round chips 1..N with verdict + reviewer badge + degraded badge |
  | `CommentComposer` | idle · typing · preview modal · sending · sent · send failed (ack timeout → retry) |
  | `MergePanel` | allowed · blocked (blockers listed with codes) · merging · merged (sha + copy) · conflict (file list + "send to author") · PR button disabled "ships in M3-06" |
- Empty/failure copy follows UX principle 4: every disabled control states its reason.

### 4.6 Flow / sequence
```
Review screen ─ GET /review/queue ─▶ items (WS deltas keep it live)
select task ─ GET /tasks/:id (result) + /reviews + /diff + /merge-eligibility
human writes a comment on file:line ─▶ POST /tasks/:id/comments ─▶ review_findings(author_kind=human, sent_to_author=0)
human clicks "Send to author"
   ├─ POST …/comments/preview ─▶ CommentPreview {message, sessionId, provider}  ─▶ modal shows verbatim text
   └─ confirm ─▶ POST …/comments/send {previewHash} ─▶ FollowUpSender ─▶ ack
         ├─ ack     ─▶ findings.sent_at ─▶ review.comment_sent ─▶ audit_log(actor=user)
         └─ timeout ─▶ toast + retry; author session gone ⇒ offer Request changes (RetryTask path, M3-04)
human clicks Approve  ─▶ POST /tasks/:id/approve ─▶ gate(human) satisfied ─▶ merge-eligibility re-evaluated
human clicks Request changes ─▶ M3-04 round N+1 (author re-runs) ─▶ queue item moves to waitingOn=agent
human clicks Merge ─▶ MergeTask
   ├─ MergeEligibility.allowed? no ⇒ 409 + task.merge_blocked (UI lists blockers)
   ├─ MergePort.merge(integrationBranch ← taskBranch, strategy)
   │     ├─ ok        ─▶ tasks.merged_at/merge_sha ─▶ task.merged ─▶ queue item leaves the list
   │     └─ conflict  ─▶ abort ─▶ MergePanel conflict state ─▶ optional follow-up to author
   └─ all mission tasks merged ─▶ mission state → merging (M3-06 opens the PR)
```

## 5. Tasks
- [ ] `MergeEligibility` rule + `MergeBlocker` union in `packages/core/src/review/merge-rules.ts` (100 % branch tests).
- [ ] Migrations `m3_05_findings_human`, `m3_05_tasks_merge`; repository methods for human comments.
- [ ] `GET /tasks/:id/diff` + per-file endpoint with byte caps, rename detection and binary handling.
- [ ] `MergePort` (simple-git) using a dedicated `.orchestra/integration/` worktree; conflict abort path.
- [ ] Use cases `AddReviewComment`, `PreviewComments`, `SendCommentsToAuthor`, `ApproveTask`, `RequestChanges`, `MergeTask` (one class each).
- [ ] `previewHash` integrity check between preview and send (C10).
- [ ] HTTP `ReviewController` + DTOs + OpenAPI; WS `review.queue` topic.
- [ ] Decide `diff2html` vs in-house `DiffView` against the M0-07 bundle budget; record the choice in the log (ADR only if it adds a runtime dep > 100 KB gz).
- [ ] `DiffView` + `FindingGutter` + `FindingCard` in `packages/ui` with RTL-safe layout (logical properties) and WCAG AA contrast on added/removed rows (not colour alone — use +/− glyphs).
- [ ] `ReviewQueue`, `TestStatusBar`, `RoundTimeline`, `CommentComposer` (with preview modal), `MergePanel`.
- [ ] Keyboard map + ⌘K actions ("Approve task", "Request changes", "Merge task", "Open author terminal").
- [ ] Deep link `/review/:taskId` (used by Attention items and later by notifications, M7-03).
- [ ] Playwright E2E against FakeProvider fixtures for the full queue → comment → send → approve → merge path.
- [ ] Perf check: 1 500-line diff renders within the M0-07 interaction budget; virtualise rows if not.
- [ ] Docs: Review screen section in `docs/`; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-05-01 | unit | `MergeEligibility` over the blocker matrix (verdict × findings × tests × gate) | exactly the expected blocker codes; 100 % branch |
| UT-M3-05-02 | unit | unified-diff parser: renames, binary, deleted file, CRLF, no-newline-at-EOF | correct `status`, no throw, `Result.err` on malformed hunks |
| UT-M3-05-03 | unit | comment anchoring when the diff changes between rounds | comment keeps `anchor_sha`; UI marks it "on an earlier revision" |
| AT-M3-05-01 | application | `SendCommentsToAuthor` with a stale `previewHash` | `Err(PreviewStale)`, nothing sent, no audit row for a send |
| AT-M3-05-02 | application | `MergeTask` when a blocker finding is unresolved | `Err` with `OpenFindings`, `task.merge_blocked` emitted, branch untouched |
| AT-M3-05-03 | application | `MergeTask` twice with the same `Idempotency-Key` | one merge commit; second returns the first result |
| IT-M3-05-01 | integration | squash merge of a task branch into the integration branch on the scratch repo | integration branch head has one new commit with the generated message; user's working checkout `git status` unchanged |
| IT-M3-05-02 | integration | conflicting task branches merged in sequence | second merge returns `MergeConflict{files}`; repo left clean (`git merge --abort` verified); no partial state |
| E2E-M3-05-01 | e2e (Playwright) | queue → select → comment → preview → send → approve → merge (FakeProvider) | every state renders; preview text equals the delivered message; merged task leaves the queue |
| E2E-M3-05-02 | e2e (Playwright) | merge button blocked state | button disabled with all blocker reasons listed as text (asserted by accessible name, not colour) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-05-01 | Review a real Codex task reviewed by Claude | 1. Run a mission through M3-04 2. Open **Review** | Queue lists the task with author/reviewer badges, round chip, test status; diff renders within 1 s for a < 300-line change | ⬜ |
| TC-M3-05-02 | Agent findings anchored in the gutter | 1. Select the task 2. Scroll the diff | Each agent finding with `file:line` appears in the gutter at that line with severity + reviewer provider badge; unanchored findings listed above the diff | ⬜ |
| TC-M3-05-03 | Comment preview matches what is sent | 1. Add a comment on a line 2. Click *Send to author* 3. Compare the modal text with the author pane in Terminals | The pane receives exactly the previewed text (including the `file:line` prefix); `audit_log` row with `actor.kind = user`; finding shows `sent` | ⬜ |
| TC-M3-05-04 | Preview integrity (negative) | 1. Open the preview 2. In a second tab add another comment 3. Confirm send in the first tab | `409 PreviewStale`; nothing is sent; UI asks to re-preview | ⬜ |
| TC-M3-05-05 | Request changes starts round 2 | 1. Click *Request changes* with two findings selected | Task returns to `running`; author receives the findings; Review queue shows `waitingOn: agent`; round chip 2 appears when the review restarts | ⬜ |
| TC-M3-05-06 | Merge blocked (negative) | 1. Open a task with a `blocker` finding unresolved | Merge button disabled; blockers listed as text (`OpenFindings: 1 blocker`); attempting the API call returns 409 and emits `task.merge_blocked` | ⬜ |
| TC-M3-05-07 | Merge happy path | 1. Resolve findings, Approve 2. Merge (squash) | Integration branch gains one commit; `tasks.merge_sha` set; task leaves the queue; your own `git status` in the repo is clean and unchanged | ⬜ |
| TC-M3-05-08 | Merge conflict (negative) | 1. Force two task branches touching the same lines 2. Merge both | Second merge shows the conflict file list; repo not left mid-merge; *Send conflict list to author* delivers a follow-up message | ⬜ |
| TC-M3-05-09 | Large diff | 1. Run a task that touches 200 files | File list renders; patches load lazily per file; no tab freeze; memory stays within the M0-07 budget | ⬜ |
| TC-M3-05-10 | Restart while reviewing (resilience) | 1. Add two comments 2. `kill -9` the daemon 3. Restart and reopen the task | Comments still present and still unsent; sending after restart works and is audited once | ⬜ |
| TC-M3-05-11 | RTL + keyboard | 1. Switch UI to Arabic 2. Navigate with `j/k`, `n/p`, approve with `a` | Layout mirrors correctly (gutter on the correct side), diff text stays LTR, all shortcuts work, focus ring visible | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] A human can go from "task finished" to "merged into the mission branch" without leaving the Review screen (TC-M3-05-01, -07).
- [ ] Every message sent to an agent from this screen is previewed verbatim, hash-checked, delivered through `PaneController`, and audited (TC-M3-05-03, -04).
- [ ] The merge button is never enabled when `MergeEligibility.allowed` is false, and always states its blockers as text (E2E-M3-05-02, TC-M3-05-06).
- [ ] Merges never touch the user's working checkout and never leave the repo mid-merge (IT-M3-05-01, -02).
- [ ] Human comments and agent findings share one table and one lifecycle; both appear in the gutter.
- [ ] Diff viewer meets the M0-07 interaction budget on a 1 500-line diff and degrades gracefully above `diff.maxBytes` (TC-M3-05-09).
- [ ] RTL and keyboard-only operation verified (TC-M3-05-11); status conveyed by shape + text, never colour alone.
- [ ] All TC-M3-05-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations; `apps/web` still imports only `packages/ui` and `packages/sdk` types.

## 8. Risks / open questions
- `diff2html` adds a runtime dependency and its own CSS; if it breaks the bundle budget or RTL, the in-house `DiffView` is the fallback. Decide in the first hour of the step and record it, not at the end.
- Comment anchoring across rounds is genuinely hard: after the author pushes a new commit, line numbers move. The chosen semantics (pin to `anchor_sha`, mark stale) is the cheap correct answer; a re-anchoring heuristic is deliberately not attempted here.
- `FollowUpSender` ack semantics depend on each provider's `PaneController` implementation (M1-05..07); an ack timeout must not lose the comment — it stays unsent and retryable. (verify ack event names against each provider's manifest at step start)
- Squash vs merge-commit default: squash keeps the integration branch readable, but loses per-agent commit attribution that M5 replay might want. Default `squash`, configurable `merge.strategy`; revisit in M5-04.
- Where a task has no mission (Quick Delegate, M2-06), there is no integration branch — the merge target falls back to the task's `baseRef` and the panel says so.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
