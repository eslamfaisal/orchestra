# Step M3-06 — PR integration

| Field | Value |
|---|---|
| Milestone | M3 — Missions, review & merge |
| Status | ⬜ Not started |
| Depends on | M3-05 |
| Estimated effort | 2 days |
| Packages touched | `apps/daemon` (application/forge, infrastructure/forge, infrastructure/git, interface/http), `packages/core` (forge value objects), `apps/web` (screens/review, screens/missions), `apps/cli` |
| Risk | Medium |
| Owner | |

## 1. Goal
A finished mission (or a single approved task) turns into a real pull request with one click. The daemon pushes the branch and shells out to the user's **own already-authenticated** forge CLI — `gh pr create` for GitHub, `glab mr create` for GitLab — with a PR body generated from the `TaskResult`s and `Review`s: what changed, diffstat, test status, which model wrote it, which vendor reviewed it, findings resolved per round, and the cost estimate. The PR URL is stored on the task/mission, shown in Review and Missions, and opened in the browser. Merging the PR is done by the human or, when policy allows, by the Lead through the same CLI. Orchestra stores no tokens and calls no forge API directly.

## 2. Why
- Source plan §9: "one-click PR via the user's own GitHub/GitLab credentials, merge by Lead or human per policy" is part of the P0 Review & Merge module; a mission that ends at a local branch is not a delivered feature.
- C2: forge access is on the allowed-egress list *only* through the user's own credentials. Shelling out to `gh`/`glab` means Orchestra never holds a token, never sees one, and inherits whatever SSO/2FA the user already set up.
- C3: no credential store is read; the forge CLI's own auth is the single source of truth, probed with `gh auth status` / `glab auth status`, which return status text, not tokens.
- C10: creating a PR is a publishing action — it is previewed (body + target + title) before it runs, and audited after.
- G3: the PR body is where cross-vendor review becomes *visible to other humans* — "written by Codex GPT-5.x, reviewed by Claude Opus, 2 rounds, 3 findings resolved" is the artifact that proves G3 outside Orchestra.
- G5: `pr_url` on the task/mission closes the record chain from intent → plan → task → review → merge → PR.

## 3. Scope
### In scope
- `ForgePort` + two adapters (`GhForgeAdapter`, `GlabForgeAdapter`) as DI-registered strategies keyed by detected forge.
- Forge detection from `git remote get-url origin` (github.com / gitlab.com / self-hosted host match from config) + binary presence + `auth status` probe.
- `PrBodyComposer`: deterministic markdown from `TaskResult[]` + `Review[]` + `RoutingDecision[]` + mission plan link.
- Use cases `OpenPullRequest`, `UpdatePullRequest`, `MergePullRequest`, `ProbeForgeAuth`.
- Push of the integration (or task) branch to `origin` with an explicit confirm.
- Persisting `pr_url`, `pr_number`, `pr_state` on `tasks` and `missions`; `forge.*` events.
- UI: PR panel in Review (enabled now), PR row in Missions, "Open PR" in ⌘K; `orch pr open <missionId>`.
- Policy `merge.allowLeadMerge` (default `false`) and `merge.requireGreenChecks` (default `true`).
### Out of scope (deferred to …)
- Reading PR review comments back into Orchestra findings — deferred to M9-07 (watchers) / a later ecosystem step.
- CI status polling beyond one `gh pr checks` / `glab ci status` call at merge time — deferred to M9-07.
- Bitbucket / Gitea / other forges — deferred to M10-03 (a forge is a plugin shape, same as a provider).
- 4-eyes approval before merging a PR — deferred to M9-04.
- Auto-merge queues, stacked PRs, draft→ready automation — not planned for v1.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `ForgeRef { kind: 'github' | 'gitlab'; host: string; owner: string; repo: string }` parsed from the remote URL (ssh + https forms).
- `PullRequest { url, number, state: 'open'|'merged'|'closed'|'draft', target: string, source: string, createdAt, mergedAt? }`.
- Rule `canOpenPr(mission|task) → Result<void, PrBlocker>`: all in-scope tasks merged into the integration branch; no unresolved `blocker` finding; branch pushed or pushable; forge auth present. `PrBlocker` codes: `NotAllTasksMerged`, `OpenBlockerFindings`, `ForgeUnauthenticated`, `NoRemote`, `UnsupportedForge`, `BranchBehindTarget`.
- Rule `canMergePr(pr, policy, actor) → Result<void, PrBlocker>`: `actor = 'lead'` requires `merge.allowLeadMerge`; `merge.requireGreenChecks` requires the last checks probe to be `pass`; `pr.state === 'open'`. 100 % branch coverage on both rules.

### 4.2 Interfaces / contracts
```ts
// packages/core/src/forge/ports.ts
export interface ForgePort {
  readonly kind: 'github' | 'gitlab';
  readonly binary: 'gh' | 'glab';
  authStatus(ctx: HostContext): Promise<Result<{ loggedIn: boolean; host: string; accountLabel?: string }, ForgeError>>;
  createPr(args: CreatePrArgs): Promise<Result<PullRequest, ForgeError>>;
  updatePr(args: { ref: ForgeRef; number: number; title?: string; body?: string }): Promise<Result<PullRequest, ForgeError>>;
  viewPr(args: { ref: ForgeRef; number: number }): Promise<Result<PullRequest, ForgeError>>;
  checks(args: { ref: ForgeRef; number: number }): Promise<Result<'pass'|'fail'|'pending'|'none', ForgeError>>;
  mergePr(args: { ref: ForgeRef; number: number; strategy: 'squash'|'merge'|'rebase' }): Promise<Result<PullRequest, ForgeError>>;
}
export interface CreatePrArgs { ref: ForgeRef; title: string; body: string; head: string; base: string; draft: boolean; }
export type ForgeError =
  | { code: 'ForgeBinaryMissing'; binary: string }
  | { code: 'ForgeUnauthenticated'; host: string; hint: string }   // hint = "run `gh auth login`"
  | { code: 'ForgeCommandFailed'; argv: string[]; exitCode: number; stderrTail: string }
  | { code: 'PrAlreadyExists'; url: string; number: number }
  | { code: 'ForgeUnsupported'; host: string };

// apps/daemon/src/application/forge/pr-body.ts
export interface PrBodyInput {
  mission?: { id: string; title: string; intent: string; planVersion: number; playbookId: string };
  tasks: { id: string; title: string; taskType: TaskType; author: { provider: ProviderId; model: ModelId };
           result: TaskResult; reviews: Review[]; routingReasons: string[] }[];
  budgetUsed?: { costEstimateUsd?: number; confidence: 'official' | 'estimate' };
  orchestraVersion: string;
}
export interface PrPreview { title: string; body: string; base: string; head: string; ref: ForgeRef; draft: boolean; argvPreview: string[]; bodyHash: string; }
```
`argvPreview` is the **exact** argv that will be executed (binary + documented flags only), shown in the confirm dialog — the same discipline as the provider launcher contract test (C8 in spirit).

### 4.3 Data / schema changes
- `tasks` + migration `m3_06_tasks_pr`: `pr_url TEXT`, `pr_number INT`, `pr_state TEXT`, `pr_updated_at TEXT`.
- `missions` + migration `m3_06_missions_pr`: `pr_url TEXT`, `pr_number INT`, `pr_state TEXT`, `pushed_at TEXT`, `forge_kind TEXT`, `forge_host TEXT`.
- Events: **new** `forge.pr_opened`, `forge.pr_updated`, `forge.pr_merged`, `forge.auth_missing`, `forge.command_failed`. `audit_log` rows for every `createPr`/`mergePr` with the full argv (no secrets can appear — argv contains no tokens by construction).
- No table for credentials. Ever.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Binary allowlist**: `gh` and `glab` are added to the `BinaryRegistry` allowlist (M1-04) with version probes (`gh --version`, `glab --version`). Unknown binaries are refused, same mechanism as vendor CLIs (C1 pattern reused).
- Child process rules (`09-engineering-standards.md`): explicit env allowlist (`PATH`, `HOME`, `LANG`, `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR` if set). The daemon's full env is never inherited, so a stray `GH_TOKEN` in the daemon environment is not silently forwarded; if the user *has* one in their shell config, the forge CLI reads it itself — Orchestra neither sets nor reads it.
- Body is passed via `--body-file <tmpfile>` (0600, in `~/.orchestra/tmp/`, deleted after) — never as a shell argument, so no quoting/injection surface.
- Push: `git -C <repo> push --set-upstream origin <branch>` from the `.orchestra/integration/` worktree; explicit user confirm in the same dialog as the PR preview; `--force` is never used.
- Egress: the only network traffic is the forge CLI's own; the daemon makes no HTTP call to github.com/gitlab.com. The M0-08 egress test asserts this (daemon-originated connections to forge hosts = 0).
- Idempotency: before `createPr`, run the forge CLI's "view for this head branch" query; an existing PR returns `PrAlreadyExists{url}` and the use case updates instead of duplicating.

### 4.5 API / UI surface
- `GET /forge/status` → `{ kind, host, binary, version, loggedIn, accountLabel }` or the blocker.
- `POST /missions/:id/pr/preview` / `POST /tasks/:id/pr/preview` → `PrPreview` (no side effects).
- `POST /missions/:id/pr` `{ bodyHash, draft?, push: true }` → creates (409 `PreviewStale` on hash mismatch; `Idempotency-Key` honoured).
- `POST /missions/:id/pr/merge` `{ strategy }` → merge by human; the same use case is reachable from MCP `collect`-adjacent tooling only when `merge.allowLeadMerge` is true.
- `GET /missions/:id/pr` → cached `PullRequest` + last checks result.
- CLI: `orch pr status`, `orch pr open <missionId> [--draft]`, `orch pr merge <missionId> --strategy squash`.
- UI: `MergePanel`'s PR button (M3-05) becomes live → opens `PrPreviewDialog` (title editable, body markdown preview with an "edit body" textarea, target branch select, draft toggle, argv line in a mono block, push warning). States: `forge unauthenticated` (with the exact command to run) · `preview` · `creating` · `created` (URL + copy + open) · `exists` (link to the existing PR) · `failed` (stderr tail + retry).
- Missions screen row (M3-08 consumes): PR badge with state.

### 4.6 Flow / sequence
```
boot / on repo registration ─▶ ProbeForgeAuth
   ├─ parse remote ─▶ ForgeRef  (no remote ⇒ NoRemote, PR button hidden with reason)
   ├─ BinaryRegistry: gh|glab present & allowlisted?  no ⇒ ForgeBinaryMissing (hint: install)
   └─ `gh auth status` ─▶ loggedIn? no ⇒ forge.auth_missing + Attention item "run `gh auth login`"
human clicks "Open PR" (Review or Missions)
   ├─ canOpenPr(mission) ─▶ blockers ⇒ dialog lists them, no command runs
   ├─ PrBodyComposer(tasks, reviews, routing) ─▶ PrPreview {title, body, argvPreview, bodyHash}
   └─ confirm ─▶ OpenPullRequest
         ├─ git push -u origin <integrationBranch>            (audited)
         ├─ ForgePort.createPr(--body-file …)                  (audited, argv recorded)
         │     ├─ ok               ─▶ missions.pr_url/number ─▶ forge.pr_opened ─▶ UI opens the URL
         │     └─ PrAlreadyExists  ─▶ UpdatePullRequest(body) ─▶ forge.pr_updated
         └─ ForgeCommandFailed ─▶ stderr tail surfaced verbatim ─▶ forge.command_failed
merge (human, or Lead when merge.allowLeadMerge)
   ├─ canMergePr(pr, policy, actor) ─▶ requireGreenChecks ⇒ ForgePort.checks() must be 'pass'
   └─ ForgePort.mergePr ─▶ missions.pr_state='merged' ─▶ forge.pr_merged ─▶ mission → done
```
PR body skeleton (deterministic, `PrBodyComposer`):
```
## <mission title>
<intent>
### Tasks
| Task | Type | Author | Reviewer(s) | Rounds | Tests | Files |
### Review summary
- resolved findings by severity; unresolved nits listed
### Verification
- test command, exit code, duration
### Provenance
Planned by <lead provider/model> · plan v<N> · playbook <id>@<version> · Orchestra <version>
Cost estimate: <usd> (estimate)
```

### 4.7 Review reconciliation contract (2026-09-15)
At PR merge time fetch the remote head/base, required check conclusions and current review state. Bind any merge call to expected head SHA through the hosting CLI/API documented precondition. Unsupported atomic preconditions disable automatic remote merge. Local evidence cannot substitute for required remote checks; unknown/pending checks block. A base movement requires integration validation or the hosting merge queue equivalent.

## 5. Tasks
- [ ] `ForgeRef` parser (ssh/https, self-hosted hosts from config) + `canOpenPr` / `canMergePr` rules in `packages/core/src/forge/` (100 % branch).
- [ ] `ForgePort` interface + `GhForgeAdapter` and `GlabForgeAdapter` (documented subcommands only), DI-registered by `kind`.
- [ ] Add `gh` / `glab` to the `BinaryRegistry` allowlist with version probes and range checks.
- [ ] `ProbeForgeAuth` use case + `GET /forge/status` + Attention item when unauthenticated.
- [ ] `PrBodyComposer` with golden-file tests (stable output for a fixed input).
- [ ] `--body-file` temp-file handling (0600, cleanup on success and failure).
- [ ] Use cases `OpenPullRequest`, `UpdatePullRequest`, `MergePullRequest` (one class each, `Result`, idempotent).
- [ ] Migrations `m3_06_tasks_pr`, `m3_06_missions_pr`; event types + Zod payload schemas.
- [ ] Push flow from the `.orchestra/integration/` worktree with explicit confirm; never `--force`.
- [ ] HTTP controller + DTOs + OpenAPI; `previewHash` staleness check.
- [ ] Web: `PrPreviewDialog` with all states; enable the PR button in `MergePanel`; PR badge component for Missions.
- [ ] CLI `orch pr status|open|merge` with `--json`.
- [ ] Policy keys `merge.allowLeadMerge`, `merge.requireGreenChecks`, `forge.hosts[]`, `forge.prDraftDefault`.
- [ ] Extend the M0-08 egress test: assert zero daemon-originated connections to `api.github.com` / `gitlab.com`.
- [ ] Docs: "PR integration & credentials" page stating explicitly that Orchestra stores no tokens; `PROGRESS.md`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M3-06-01 | unit | remote URL parsing: `git@github.com:o/r.git`, `https://gitlab.example.com/g/s/r`, `https://github.com/o/r`, a non-forge remote | correct `ForgeRef` ×3; `UnsupportedForge` for the fourth |
| UT-M3-06-02 | unit | `canOpenPr` with unmerged tasks / blocker findings / no remote / clean | one blocker code each; `Ok` for clean; 100 % branch |
| UT-M3-06-03 | unit | `canMergePr` for actor `lead` with flag off/on, checks `fail`/`pending`/`pass` | refuses except (`lead` on + `pass`) and human + `pass`; `requireGreenChecks: false` relaxes |
| UT-M3-06-04 | unit (golden) | `PrBodyComposer` on a fixed 3-task mission fixture | byte-identical to the golden file; contains author model, reviewer vendor, rounds, test status |
| AT-M3-06-01 | application | `OpenPullRequest` with a fake `ForgePort` returning `PrAlreadyExists` | falls through to `UpdatePullRequest`; one `forge.pr_updated`; no duplicate row |
| AT-M3-06-02 | application | `OpenPullRequest` twice with the same `Idempotency-Key` | second returns the first `PullRequest`; the fake port records one `createPr` call |
| AT-M3-06-03 | application | body passed to the port | always `--body-file`; the body never appears in argv; temp file deleted in both success and failure paths |
| AT-M3-06-04 | application | `ForgeUnauthenticated` from `authStatus` | no push, no create; Attention item emitted with the exact remediation command |
| CT-M3-06-01 | contract | argv builder for both adapters vs an allowlist of documented subcommands/flags | any undocumented flag fails the test |
| IT-M3-06-01 | integration | full flow against a **local bare repo** remote with a stubbed `gh` on `PATH` | branch pushed, stub receives the expected argv, `pr_url` persisted, event emitted |
| E2E-M3-06-01 | e2e (Playwright) | preview dialog → create → created state (stubbed forge binary) | argv line shown matches what the stub received; URL copyable; stale `bodyHash` yields 409 |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M3-06-01 | Forge status on a real repo | 1. `gh auth status` logged in 2. Open Review for a real GitHub repo | `GET /forge/status` shows `github`, host, `gh` version, `loggedIn: true`, account label; PR button enabled | ⬜ |
| TC-M3-06-02 | Open a real PR from a mission | 1. Complete a small mission on a real repo (a docs change) 2. Open PR preview 3. Confirm | Branch pushed; PR opens on github.com; body contains the task table with author model and reviewer vendor; `pr_url` stored; browser opens the PR | ⬜ |
| TC-M3-06-03 | Idempotent re-open | 1. Click *Open PR* again for the same mission | No second PR is created; the existing PR body is updated; UI shows the `exists` state with the same URL | ⬜ |
| TC-M3-06-04 | Not authenticated (negative) | 1. `gh auth logout` 2. Click *Open PR* | Dialog shows `ForgeUnauthenticated` with the literal command `gh auth login`; nothing is pushed; an Attention item appears; no token is requested by Orchestra anywhere | ⬜ |
| TC-M3-06-05 | Unmerged tasks (negative) | 1. Mission with one task still `in_review` 2. Click *Open PR* | Blocked with `NotAllTasksMerged` listing the task; no push, no command executed | ⬜ |
| TC-M3-06-06 | GitLab repo | 1. Point the scratch repo at a GitLab remote with `glab` logged in 2. Open an MR | `glab mr create` runs with the previewed argv; MR URL stored; Missions row shows the MR badge | ⬜ |
| TC-M3-06-07 | Lead merge refused by policy (negative) | 1. `merge.allowLeadMerge: false` 2. Ask the Lead to merge in Chat | The attempt is refused with a policy reason and audited; the PR stays open; the human can still merge | ⬜ |
| TC-M3-06-08 | Green-checks gate | 1. `merge.requireGreenChecks: true` 2. Merge while CI is pending | Merge refused with `checks: pending`; after CI passes, merge succeeds and `pr_state` becomes `merged`; mission reaches `done` | ⬜ |
| TC-M3-06-09 | No token leakage (compliance) | 1. Run the whole flow with daemon logs at debug 2. `grep -Ei 'token\|authorization\|ghp_\|glpat-' ~/.orchestra/logs/*` | Zero matches; `audit_log` argv rows contain no credential-shaped values; DB has no credential column | ⬜ |
| TC-M3-06-10 | Forge CLI failure (negative) | 1. Rename the remote to a repo you cannot push to 2. Open PR | `ForgeCommandFailed` with the stderr tail shown verbatim; retry offered; no partial state (no `pr_url` stored) | ⬜ |

### 6.3 Review regression scenarios
- [ ] Force-push between review and merge: reject stale head.
- [ ] Required checks missing/pending/failing: no merge.
- [ ] Remote base changes: revalidate integrated candidate.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] A mission on a real GitHub repo produces a real PR whose body states author model, reviewer vendor and round count (TC-M3-06-02).
- [ ] GitLab path proven at least once (TC-M3-06-06).
- [ ] Orchestra reads, stores and forwards **no** forge credentials; the egress test proves the daemon makes no direct forge API calls (TC-M3-06-09 + extended M0-08 test).
- [ ] `gh`/`glab` are allowlisted binaries with version probes; undocumented flags fail `CT-M3-06-01`.
- [ ] PR creation is idempotent and preview-hash-checked; re-clicking never creates a duplicate (TC-M3-06-03, AT-M3-06-02).
- [ ] Lead merging is impossible unless `merge.allowLeadMerge` is set, and every merge is audited (TC-M3-06-07).
- [ ] `canOpenPr` / `canMergePr` at 100 % branch coverage.
- [ ] All TC-M3-06-xx pass and are recorded.
- [ ] No new lint / dependency-cruiser violations; no `fetch` to a forge host anywhere in the codebase.

## 8. Risks / open questions
- `gh`/`glab` subcommand surfaces change between versions (e.g. flag renames on `pr create`). Pin a tested version range in the allowlist and let the Doctor (M6-01) treat an out-of-range forge CLI the same way it treats an out-of-range vendor CLI. (verify current `gh pr create` and `glab mr create` flags against their docs at step start)
- Self-hosted GitHub Enterprise / GitLab hosts need `forge.hosts[]` mapping; SSO-expired sessions surface as `ForgeUnauthenticated` — make sure the hint text comes from the CLI's own stderr rather than being invented.
- Some repos require signed commits or a PR template; the composed body may conflict with a repo `PULL_REQUEST_TEMPLATE.md`. Decision here: if a template exists, prepend Orchestra's provenance block and keep the template below it; verify on a real repo in TC-02.
- A monorepo mission touching many packages may exceed forge body limits (~65 k chars on GitHub); truncate the task table with a "full report in Orchestra" line and keep the provenance block intact.
- Reading PR comments back would close the loop nicely but pulls Orchestra into polling the forge API — deliberately deferred (M9-07 watchers) to keep C2 narrow.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
