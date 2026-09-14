# Step M3-04 — Cross-vendor review rule & rounds

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-03 |
| Estimated effort | 3 days |
| Packages touched | `packages/core` (review), `packages/catalog` (taxonomy review fields), `packages/sdk` (FakeProvider scenarios, output-schema fixtures), `apps/daemon` (application/reviews, infrastructure/git, interface/http, interface/mcp), `apps/web` |
| Risk | High |
| Owner | |

## 1. Goal
After this step **no mission task reaches merge without being reviewed by a different vendor's model**. When a task lands in `review_pending`, the daemon picks a reviewer with the `ReviewRule` domain service (`reviewer.provider ≠ author.provider`, two reviewers for `risk: high` and `security-audit`), launches a `code-review` task in a **read-only checkout of the author's branch**, and captures the reviewer's output as structured `ReviewFinding` rows (provider-native structured output where the CLI supports it, `REVIEW.md` otherwise). A verdict of `changes_requested` sends the findings back to the *author's* session as a follow-up message through `PaneController`, the author produces a new result, and a new round starts — up to `reviewRounds` from the playbook step, after which the task escalates to a human. Every round, reviewer choice and degradation is persisted and auditable.

## 2. Why
- G3 ("better output through diversity", cross-vendor review on 100 % of mission tasks) is *the* differentiating goal of the product; this step is where it becomes a machine-enforced constraint instead of a convention.
- D3: reviewer choice is a deterministic rule in the daemon (`ReviewRule` + `AssignmentEngine` constraint from `06-intelligence-layer.md §3`), not a Lead decision — an LLM asked to pick its own reviewer will not reliably pick a rival vendor.
- D7: `reviewRequired` / `two-reviewer` live in the task taxonomy (M2-01) and `reviewRounds` in the playbook (M3-01); the rule reads data, so review policy changes without a release.
- R12 (only one provider healthy): the degradation path — same vendor, different model — exists but requires an explicit policy flag and writes an audit record, so a degraded review is never invisible.
- R11 (Lead loops): `maxRounds` plus a human escalation bounds rework.
- C10: reviewer runs spend quota, so the reviewer choice and its reasons are shown before the round starts and recorded in `routing_decisions`.
- C7: findings come from structured output or a file on disk — never from parsing the reviewer's terminal bytes.

## 3. Scope
### In scope
- `ReviewRule` domain service + `Review` / `ReviewFinding` entities and the round state machine in `packages/core/src/review/`.
- Use cases: `RequestReview`, `StartReviewRound`, `SubmitReviewFindings`, `ApplyReviewVerdict`, `SendFindingsToAuthor`, `EscalateReview`.
- Reviewer execution as a `code-review` typed task in a read-only checkout (`git worktree add --detach` at the author head, marked read-only by convention + sandbox profile).
- Findings capture: provider structured output (`codex exec --output-schema`, `claude -p --output-format json`) with a `REVIEW.md` + fenced `orchestra-review` YAML fallback.
- Round loop: `changes_requested` → follow-up message to the author session → re-run → re-collect (M3-03) → next round.
- Two-reviewer mode for `risk: high` and `taskType: security-audit`; merged verdict rule.
- `reviews`, `review_findings` tables + migrations; `GET/POST` review endpoints; MCP `status()` exposes rounds.
- Degradation policy flag `review.allowSameVendorDegrade` with audit + UI badge.
### Out of scope (deferred to …)
- Diff viewer, inline human comments, approve/request-changes buttons — deferred to M3-05.
- PR creation and merge — deferred to M3-06.
- DAG/round visualisation — deferred to M3-08.
- 4-eyes human approval gates (second *human* approver) — deferred to M9-04.
- Feeding review findings into model scorecards — deferred to M8-06.
- Native provider review features (e.g. a CLI's own review command) as a transport — deferred to M10 (`nativeReview` capability flag is read but unused here).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `Review { id, taskId, round, reviewerProvider, reviewerModel, sessionId?, mode: 'primary'|'secondary', verdict, findings[], degraded: boolean, degradeReason?, startedAt, finishedAt }`.
- `ReviewFinding { id, reviewId, severity: 'blocker'|'major'|'minor'|'nit'|'praise', category: 'correctness'|'security'|'performance'|'architecture'|'style'|'tests', file?, line?, endLine?, message, suggestion?, resolved: boolean }`.
- `ReviewVerdict = 'approved' | 'approved_with_nits' | 'changes_requested' | 'rejected' | 'inconclusive'`.
- `ReviewRule` (pure, `packages/core/src/review/review-rule.ts`):
  - `requiredReviews(task, taxonomy, playbookStep) → { count: 0|1|2, reason }` — `0` when `reviewRequired: false` **and** `reviewRounds: 0`; `2` when taxonomy says `two-reviewer` or `risk: high`.
  - `eligibleReviewers(authorDecision, candidates, policy) → Result<Candidate[], ReviewError>` — filters `provider !== author.provider`; if empty and `policy.allowSameVendorDegrade`, returns same-provider candidates with `model !== author.model` flagged `degraded: true`; if still empty ⇒ `Err(NoEligibleReviewer)`.
  - `mergeVerdicts(reviews) → ReviewVerdict` — strictest wins: any `rejected` ⇒ `rejected`; any `changes_requested` ⇒ `changes_requested`; any `inconclusive` with the other approved ⇒ `changes_requested`; all approved (nits allowed) ⇒ `approved_with_nits` when any nit exists, else `approved`.
  - `nextRound(review, maxRounds) → 'rerun_author' | 'escalate_human' | 'done'`.
  - 100 % branch coverage on all four (M2-04 precedent).
- Round state machine (per task): `review_pending → in_review → changes_requested → running → review_pending …` / `→ approved` / `→ blocked(escalated)`; reuses the `Task` machine from `04-domain-model.md §2`.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/review/ports.ts
export interface ReviewRepository {
  add(r: Review): Promise<Result<void, RepoError>>;
  listByTask(taskId: string): Promise<Result<Review[], RepoError>>;
  addFindings(reviewId: string, f: ReviewFinding[]): Promise<Result<void, RepoError>>;
  setResolved(findingId: string, resolved: boolean): Promise<Result<void, RepoError>>;
}
export type ReviewError =
  | { code: 'NoEligibleReviewer'; authorProvider: ProviderId; healthy: ProviderId[] }
  | { code: 'ReviewRoundsExhausted'; taskId: string; rounds: number }
  | { code: 'FindingsUnparsable'; reviewId: string; source: FindingsSource; detail: string }
  | { code: 'AuthorSessionGone'; taskId: string }
  | { code: 'ReviewAlreadySubmitted'; reviewId: string };

// The schema the reviewer must produce (JSON schema derived from this Zod type)
// packages/catalog/schemas/review-output.schema.ts
export interface ReviewOutput {
  verdict: ReviewVerdict;
  summary: string;                                   // ≤ 1200 chars
  findings: {
    severity: 'blocker'|'major'|'minor'|'nit'|'praise';
    category: 'correctness'|'security'|'performance'|'architecture'|'style'|'tests';
    file?: string; line?: number; endLine?: number;
    message: string; suggestion?: string;
  }[];
  testsReviewed: boolean;
}
export type FindingsSource = 'output-schema' | 'output-json' | 'review-md' | 'none';

// apps/daemon/src/application/reviews/ports.ts
export interface FindingsExtractor {           // DI map keyed by ProviderId, default = MarkdownFindingsExtractor
  readonly source: FindingsSource;
  extract(input: { stdoutJson?: unknown; worktreePath: string; finalMessage?: string }): Result<ReviewOutput, ReviewError>;
}
export interface FollowUpSender {              // wraps PaneController (M1-05..07)
  send(sessionId: string, message: string): Promise<Result<Ack, AdapterError>>;
}
export interface ReadOnlyCheckoutPort {
  create(repoPath: string, headSha: string, taskId: string, round: number): Promise<Result<{ path: string }, GitError>>;
  remove(path: string): Promise<Result<void, GitError>>;
}
```
`FindingsExtractor` is a DI-registered strategy per provider (standards: strategies, not switches). Selection order per provider manifest: `headless.outputSchema === true` ⇒ `output-schema`; else `headless.outputFormat === 'json'` ⇒ `output-json`; else `review-md`. Every path validates with the same Zod schema, so a malformed structured output degrades to `review-md` before it degrades to `Err(FindingsUnparsable)`.

### 4.3 Data / schema changes
- `reviews` (schema v1: `id, task_id, round, reviewer_provider, reviewer_model, verdict, session_id`) + migration `m3_04_reviews_ext`: `mode TEXT` (`primary|secondary`), `degraded INT`, `degrade_reason TEXT`, `findings_source TEXT`, `summary TEXT`, `checkout_path TEXT`, `head_sha TEXT`, `started_at TEXT`, `finished_at TEXT`; unique `(task_id, round, mode)`.
- `review_findings` (`id, review_id, severity, file, line, message, resolved`) + migration `m3_04_findings_ext`: `category TEXT`, `end_line INT`, `suggestion TEXT`, `sent_to_author INT DEFAULT 0`, `created_at TEXT`.
- `tasks` + `review_rounds_used INT DEFAULT 0`, `escalated_reason TEXT`.
- Events: `task.review_requested`, `task.reviewed` (catalog) **+ new** `review.round_started`, `review.degraded`, `review.findings_sent`, `review.escalated`. Add the new types to `04-domain-model.md §3` when the step closes.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Read-only checkout**: `git worktree add --detach .orchestra/reviews/<taskId>-r<round> <headSha>` in the repo. The reviewer's session runs there with the provider's most restrictive sandbox profile that still allows reading and running tests (`manifest.sandboxProfiles`, e.g. Codex `read-only`). `chmod -R a-w` is **not** used (it breaks tooling); instead the checkout is detached, never pushed, and discarded after the round — any writes there are ignored by design and logged as `reviewerWroteFiles: true`.
- `REVIEW_TASK.md` written into the checkout: the author's goal + acceptance from `TaskSpec`, `git diff <baseSha>..<headSha>` (inline up to 400 KB, else a path to a diff file), the test report from M3-03, the required output contract, and the rule "review only; do not modify the author's branch".
- Headless launch preferred for reviewers (`Launcher.headless`), because structured output is a headless feature on both Claude Code and Codex; interactive review is a config fallback (`review.mode`).
- Findings extraction reads the launcher's captured stdout (already persisted by M1-08) — no new process handling.
- Follow-up to the author: if the author session is still alive, `FollowUpSender.send(authorSessionId, message)`; if it is gone, `RetryTask` (M3-03) starts a fresh author session on the **same** provider/model with the findings appended to `TASK.md` as a `## Review round N` section.

### 4.5 API / UI surface
- `GET /tasks/:id/reviews` → `[{ round, mode, reviewer, verdict, degraded, findings[] }]`.
- `POST /tasks/:id/reviews` `{ reviewerOverride?: {provider, model} }` → starts a round manually (preview shown first, C10). `Idempotency-Key` honoured.
- `POST /reviews/:id/verdict` `{ verdict, summary, findings[] }` — the ingestion endpoint for a *human* or a re-submitted agent review; Zod-validated at the edge.
- `POST /tasks/:id/review/send-to-author` `{ findingIds[] , note? }` → follow-up message (preview returned first; see M3-05 for the UI preview, C10).
- `POST /tasks/:id/review/escalate` `{ reason }`.
- WS: `task.<id>` gains `reviews` deltas; `review.<id>` for live findings.
- UI (minimal here, full screen in M3-05): Board card shows `round N/M` and a **degraded** badge with tooltip `same-vendor review (policy flag) — <reason>`; Attention gets an item when a task escalates to a human.

### 4.6 Flow / sequence
```
task.result_submitted(verdict=needs_review) ─▶ RequestReview
   ├─ ReviewRule.requiredReviews(task, taxonomy, step) ─▶ 0 ⇒ approved (skip)  | 1 | 2
   ├─ AssignmentEngine.decide(taskType='code-review', constraint: provider ≠ author.provider)
   │     └─ no candidate ⇒ policy.allowSameVendorDegrade ? degraded candidate + review.degraded : Err(NoEligibleReviewer) ⇒ escalate human
   └─ StartReviewRound ×count
         ├─ ReadOnlyCheckoutPort.create(headSha) ; write REVIEW_TASK.md
         ├─ StartSession(reviewer, headless, cwd=checkout) ─▶ review.round_started
         └─ session ends ─▶ FindingsExtractor[provider].extract() ─▶ Zod ─▶ SubmitReviewFindings
SubmitReviewFindings ─▶ reviews + review_findings rows ─▶ task.reviewed
   ▼ mergeVerdicts(all reviews of this round)
approved / approved_with_nits ─▶ task.state = approved  (gate + merge in M3-05/06)
changes_requested | rejected ─▶ nextRound(round, maxRounds)
   ├─ rerun_author  ─▶ SendFindingsToAuthor (PaneController follow-up | RetryTask) ─▶ task.state = running ─▶ (M3-03 collect) ─▶ round+1
   └─ escalate_human ─▶ review.escalated ─▶ AgentPrompt(kind='question') in Attention ─▶ human decides in Review UI (M3-05)
inconclusive / FindingsUnparsable ─▶ one retry of the same round with review-md fallback ─▶ still bad ⇒ escalate_human
```

## 5. Tasks
- [ ] `Review`, `ReviewFinding`, `ReviewVerdict` entities + round state machine in `packages/core/src/review/`.
- [ ] `ReviewRule` (`requiredReviews`, `eligibleReviewers`, `mergeVerdicts`, `nextRound`) with 100 % branch tests.
- [ ] `ReviewOutput` Zod schema in `packages/catalog/schemas/` + generated JSON schema artifact for `--output-schema` consumers.
- [ ] Migrations `m3_04_reviews_ext`, `m3_04_findings_ext`, `m3_04_tasks_rounds`; sqlite + in-memory repositories.
- [ ] `ReadOnlyCheckoutPort` (git worktree `--detach`) + cleanup on round end and on daemon boot (orphan sweep).
- [ ] `ReviewTaskComposer` writing `REVIEW_TASK.md` (diff inline/attached, acceptance, test report, output contract).
- [ ] `FindingsExtractor` strategies: `OutputSchemaExtractor`, `OutputJsonExtractor`, `MarkdownFindingsExtractor` (parses `REVIEW.md` + `orchestra-review` YAML block); DI map keyed by provider with manifest-driven selection.
- [ ] Use cases `RequestReview`, `StartReviewRound`, `SubmitReviewFindings`, `ApplyReviewVerdict`, `SendFindingsToAuthor`, `EscalateReview` (one class each, Result-returning).
- [ ] `FollowUpSender` over `PaneController` with ack-or-timeout; fallback to `RetryTask` with findings folded into `TASK.md`.
- [ ] Extend `AssignmentEngine` call sites with the cross-vendor constraint and the degrade flag; persist the reviewer `routing_decisions` row.
- [ ] HTTP `ReviewsController` + DTOs + OpenAPI; WS `review.<id>`; MCP `status()` includes rounds and verdicts.
- [ ] Web: round chip + degraded badge on Board cards; Attention item for escalations.
- [ ] FakeProvider scenarios: `review-approve.yaml`, `review-changes-requested.yaml`, `review-malformed-output.yaml`, `review-second-reviewer.yaml`.
- [ ] Config keys `review.maxRounds` (default from playbook, cap 3), `review.allowSameVendorDegrade` (default `false`), `review.mode` (`headless|interactive`), `review.diffInlineLimitBytes`.
- [ ] Docs: `docs/` review policy page; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-04-01 | unit | `eligibleReviewers` with author `claude`, candidates `[claude/opus, claude/sonnet]`, flag off / on | `Err(NoEligibleReviewer)` / one degraded candidate with `model ≠ author.model` |
| UT-M3-04-02 | unit | `mergeVerdicts` over all 25 pairs of two verdicts | strictest-wins table honoured; 100 % branch |
| UT-M3-04-03 | unit | `requiredReviews` for `security-audit`, `risk: high` feature-impl, `changelog` | 2 / 2 / 0 with reasons |
| UT-M3-04-04 | unit | `nextRound` at round < max, == max, rejected at round 1 | `rerun_author` / `escalate_human` / `escalate_human` |
| UT-M3-04-05 | unit | `MarkdownFindingsExtractor` on `REVIEW.md` with a valid block, a missing block, a block with an unknown severity | ok / `FindingsUnparsable` / `FindingsUnparsable` naming the field |
| AT-M3-04-01 | application | author `codex`, healthy `claude` + `agy` | reviewer provider ≠ `codex`; `routing_decisions` row persisted with reason `constraint:cross-vendor` |
| AT-M3-04-02 | application | round loop: `changes_requested` twice with `maxRounds: 2` | two author re-runs, then `escalate_human`; `review_rounds_used = 2`; no third reviewer session started |
| AT-M3-04-03 | application | two-reviewer task where reviewer A approves and B requests changes | merged verdict `changes_requested`; both reviews persisted with `mode` primary/secondary |
| AT-M3-04-04 | application | `SubmitReviewFindings` replayed for the same review id | `Err(ReviewAlreadySubmitted)`, no duplicate findings |
| AT-M3-04-05 | application | author session gone when findings are sent | falls back to `RetryTask`; findings appear as `## Review round 2` in the new `TASK.md` |
| CT-M3-04-01 | contract | `ReviewOutput` JSON schema validates every provider's recorded review fixture | all pass; schema version pinned with `fixturesVersion` |
| IT-M3-04-01 | integration | read-only checkout lifecycle on the scratch repo | `.orchestra/reviews/<taskId>-r1` created at `headSha`, removed after the round; author branch untouched (`git log` identical) |
| IT-M3-04-02 | integration | daemon restart mid-review round | round resumes or is restarted exactly once; no duplicate `reviews` row for `(task, round, mode)` |
| E2E-M3-04-01 | e2e (Playwright) | FakeProvider author + FakeProvider reviewer with different `providerId`s | Board shows `round 1/2` then `approved`; findings visible via API |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-04-01 | Cross-vendor review happens automatically | 1. Mission `bugfix` on the scratch repo 2. Let the `fix` task run on Codex 3. Wait for `review_pending` | A reviewer session starts on a **non-Codex** provider within 10 s; `reviews` row has `reviewer_provider != 'codex'`; the read-only checkout exists during the round | ⬜ |
| TC-M3-04-02 | Structured findings captured | 1. After TC-01's review ends 2. `GET /tasks/:id/reviews` | `findings_source` is `output-schema` or `output-json` for that provider; ≥ 1 finding with `file` and `line`; `verdict` is one of the five values | ⬜ |
| TC-M3-04-03 | Changes requested round-trip | 1. Seed a bug the reviewer will catch 2. Let the review run | Verdict `changes_requested`; the author pane receives a follow-up message containing the findings; the author edits and the task returns to `review_pending` as round 2 | ⬜ |
| TC-M3-04-04 | Round cap escalates (negative) | 1. Set `review.maxRounds: 1` 2. Force a second `changes_requested` | Task becomes `blocked` with `escalated_reason`; an Attention item appears; no further reviewer or author session starts | ⬜ |
| TC-M3-04-05 | Only one provider healthy, flag off (negative) | 1. Log out / disable all providers except Claude 2. Run a Claude-authored task to review | `NoEligibleReviewer` surfaced; task escalates to human; **no** same-vendor review runs; no session started | ⬜ |
| TC-M3-04-06 | Degradation with explicit flag | 1. Same as TC-05 with `review.allowSameVendorDegrade: true` | Review runs on a *different Claude model*; `reviews.degraded = 1` with reason; Board shows the degraded badge; `audit_log` has the `review.degraded` entry with actor `policy` | ⬜ |
| TC-M3-04-07 | Two-reviewer for security-audit | 1. Delegate a `security-audit` task 2. Wait | Two reviewer sessions on two different vendors; merged verdict follows strictest-wins; both rows present with `mode` primary/secondary | ⬜ |
| TC-M3-04-08 | Malformed reviewer output (negative) | 1. Ask a reviewer in Chat to answer in prose only, then re-run the round | First extraction fails, `REVIEW.md` fallback is attempted, and if still unparsable the round escalates with `FindingsUnparsable`; the raw output is kept as an artifact | ⬜ |
| TC-M3-04-09 | Restart during a review (resilience) | 1. Start a review round 2. `kill -9` the daemon 3. Restart | Exactly one review row for `(task, round, mode)`; the round either resumes or restarts cleanly; the orphan checkout is swept at boot | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `ReviewRule` has 100 % branch coverage; cross-vendor constraint proven on real CLIs (TC-M3-04-01).
- [ ] 100 % of mission tasks with `reviewRequired` get at least one review before they can reach `approved` (audit query: zero `task.state=approved` without a `reviews` row).
- [ ] Same-vendor review is impossible unless `review.allowSameVendorDegrade` is explicitly set, and every degraded review writes `review.degraded` to the audit log (TC-M3-04-05, TC-M3-04-06).
- [ ] Findings are structured rows (`review_findings`) on all supported providers, with a proven `REVIEW.md` fallback (TC-M3-04-02, TC-M3-04-08).
- [ ] The reviewer never modifies the author's branch (IT-M3-04-01 asserts identical `git log`/`git diff`).
- [ ] Rounds are bounded by the playbook/`review.maxRounds` and escalate to a human, never loop (TC-M3-04-04).
- [ ] Review ingestion is idempotent and restart-safe (AT-M3-04-04, TC-M3-04-09).
- [ ] All TC-M3-04-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations; no `switch (provider)` in `core`/`application` (extractors are a DI map).

## 8. Risks / open questions
- **Structured-output flags**: Codex `exec --output-schema` and Claude Code `-p --output-format json` are the assumed capture paths. Field names, nesting and whether a JSON schema can be enforced per run differ per version. (verify against Codex and Claude Code docs at step start — and pin a fixture per CLI version as the contract test input)
- Antigravity has no documented `--output-schema`; its reviewers use the `REVIEW.md` fallback. (verify against Antigravity docs at step start)
- R12 remains open in practice: a solo user with one healthy provider cannot get cross-vendor review. Escalation-to-human is the honest default; the degrade flag is opt-in and audited.
- A reviewer asked to run tests in the read-only checkout will re-run the author's suite — cost and time double. Decision here: reviewers **read** the M3-03 `TestReport` and only run tests when the taxonomy entry says `reviewRequired` with category `tests`; revisit after real runs.
- Inline diffs above `review.diffInlineLimitBytes` are passed as a file path; very large diffs may exceed the reviewer's context window — a chunking strategy (per-file review tasks) is a candidate follow-up step for M8.
- `praise` findings are captured but never block; keep them — they are training signal for M8-06 scorecards.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
