# Step M1-03 — Worktree manager

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M0-04 (∥ with M1-01/02) |
| Estimated effort | 2 days |
| Packages touched | `apps/daemon/src/application/worktrees`, `apps/daemon/src/infrastructure/git`, `packages/core` (Worktree) |
| Risk | Medium |
| Owner | |

## 1. Goal
Every task/session gets its own git worktree and branch, created and removed by the daemon: `<repo>/.orchestra/worktrees/<taskId>` on branch `orch/<taskId>-<slug>` from a chosen base ref, with `.orchestra/` gitignored automatically, dirty-state checks, safe removal (never deletes uncommitted work without `force`), listing/reconciliation against `git worktree list`, and hooks for adapters that have native worktree support (`WorktreeHooks`). A scratch repo helper exists for tests and TCs.

## 2. Why
D2 (worktree per task — agents never trample each other), G3 (parallel implementers + reviewers), `03-architecture.md` runtime directories.

## 3. Scope
### In scope
- `WorktreeManager` use cases: `CreateWorktree`, `RemoveWorktree`, `ListWorktrees`, `ReconcileWorktrees`, `WorktreeStatus` (dirty, ahead/behind, diffstat vs base).
- `GitPort` (infrastructure: `simple-git` or direct `git` via `ProcessRunner`; prefer direct git for auditability) with: `worktree add/remove/list/prune`, `rev-parse`, `status --porcelain`, `diff --stat`, `branch`.
- Naming: branch `orch/<taskId>-<slug>`, dir `.orchestra/worktrees/<taskId>`; collision handling.
- `.gitignore` management: ensure `.orchestra/` entry (append once, idempotent) — or use `.git/info/exclude` to avoid touching tracked files (config; default: `info/exclude`).
- Per-worktree files written at creation: `.orchestra/task.json` (taskId, sessionId, base, created) for adapters/hooks.
- `WorktreeHooks` invocation (`onCreate/onRemove`, `nativeFlag`) — Claude `--worktree` compatibility noted, but the daemon-managed worktree is the default so all providers behave the same.
- Scratch repo script `orch dev scratch init` → `~/orchestra-scratch` with a tiny Node CLI project, tests, and an initial commit.
- Cleanup policy: remove worktrees of `done/cancelled` tasks after TTL (config, default 7 d) if clean; never auto-remove dirty ones.
### Out of scope (deferred)
- Port/DB-suffix injection → M3-07. Result collection (diffstat/summary) → M3-03 (basic diffstat exposed here). Multi-repo missions → later.

## 4. Design
### 4.1 Domain
`Worktree { id, repoPath, path, branch, baseRef, taskId?, sessionId?, createdAt, removedAt?, status }` (core). `WorktreeRef` VO.
### 4.2 Interfaces / contracts
```ts
export interface GitPort {
  worktreeAdd(repo: string, path: string, branch: string, base: string): Promise<Result<void, GitError>>;
  worktreeRemove(repo: string, path: string, force: boolean): Promise<Result<void, GitError>>;
  worktreeList(repo: string): Promise<Result<{ path: string; head: string; branch?: string }[], GitError>>;
  worktreePrune(repo: string): Promise<Result<void, GitError>>;
  status(path: string): Promise<Result<{ dirty: boolean; files: string[] }, GitError>>;
  diffStat(path: string, base: string): Promise<Result<{ files: number; insertions: number; deletions: number; raw: string }, GitError>>;
  revParse(repo: string, ref: string): Promise<Result<string, GitError>>;
}
export class CreateWorktree { execute(i: { repoPath: string; taskId: string; slug: string; baseRef?: string /* default: current HEAD */ }): Promise<Result<Worktree, DomainError>> }
export class RemoveWorktree { execute(i: { worktreeId: string; force?: boolean }): Promise<Result<void, DomainError>> }  // dirty && !force ⇒ WORKTREE_DIRTY
```
### 4.3 Data / schema changes
`worktrees` table from baseline (add `status` text, `last_checked_at` via migration `0004_worktrees_status.ts`).
### 4.4 Infrastructure
Git invoked with `-C <repo>`, `GIT_TERMINAL_PROMPT=0`, allowlisted env; outputs parsed from porcelain formats only. Locks: one mutex per repo path (worktree ops are not concurrent-safe).
### 4.5 API / UI surface
`GET /worktrees?repo=`, `POST /worktrees`, `DELETE /worktrees/:id?force=`, `GET /worktrees/:id/status`. Fleet/Terminals show worktree path + branch in pane headers (M1-09/10).
### 4.6 Flow
```
CreateWorktree → rev-parse base → mkdir .orchestra/worktrees → git worktree add <path> -b orch/<id>-<slug> <base> → write task.json → hooks.onCreate → persist
RemoveWorktree → status → (dirty && !force → error) → git worktree remove [--force] → hooks.onRemove → prune → persist removedAt
```

## 5. Tasks
- [ ] `GitPort` + implementation with porcelain parsers and tests against a temp repo.
- [ ] Use cases (4) + `WorktreeStatus` query; per-repo mutex.
- [ ] `.orchestra/` exclusion (info/exclude default; `.gitignore` mode option).
- [ ] `task.json` writer; `WorktreeHooks` invocation with FakeProvider hook spies.
- [ ] Migration `0004`; repository methods.
- [ ] HTTP routes + DTOs; audit.
- [ ] Reconcile: DB vs `git worktree list` on boot (mark missing as removed; adopt unknown `orch/*` worktrees).
- [ ] Cleanup policy job (daily) with dry-run log.
- [ ] `orch dev scratch init|reset` script.
- [ ] Integration tests: create 5 worktrees in parallel, each gets distinct branch/dir; remove dirty without force fails.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| IT-M1-03-01 | integration | create worktree from HEAD | dir exists, branch checked out, `task.json` present, DB row |
| IT-M1-03-02 | integration | create 5 in parallel | 5 distinct branches; no git lock errors (mutex) |
| IT-M1-03-03 | integration | remove dirty without force | `WORKTREE_DIRTY`; with force → removed |
| IT-M1-03-04 | integration | reconcile after `git worktree remove` done outside | DB row marked removed |
| UT-M1-03-05 | unit | branch/dir naming: slug sanitisation, collisions | valid git ref names; suffix on collision |
| IT-M1-03-06 | integration | `.orchestra/` excluded | `git status` in repo shows nothing for `.orchestra/` |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-03-01 | Scratch repo | 1. `orch dev scratch init` 2. `cd ~/orchestra-scratch && npm test` | repo with 1 commit; tests pass | ⬜ |
| TC-M1-03-02 | Create via API | 1. `POST /worktrees {repoPath, taskId:'t1', slug:'hello'}` 2. `git -C ~/orchestra-scratch worktree list` | new worktree on `orch/t1-hello` | ⬜ |
| TC-M1-03-03 | Dirty protection | 1. edit a file in the worktree 2. `DELETE /worktrees/<id>` | 409 `WORKTREE_DIRTY`; with `?force=true` removed | ⬜ |
| TC-M1-03-04 | Status | 1. commit a change in the worktree 2. `GET /worktrees/<id>/status` | diffstat vs base shows the change; `dirty:false` | ⬜ |
| TC-M1-03-05 | No repo pollution | 1. after all above `git status` in scratch root | clean; `.orchestra/` not listed | ⬜ |
| TC-M1-03-06 | External deletion | 1. `rm -rf` a worktree dir 2. `POST /hosts/me/reconcile` | row marked removed; `git worktree prune` ran | ⬜ |

## 7. Acceptance criteria
- [ ] Worktree create/remove/list/status/reconcile via use cases + API.
- [ ] Dirty protection and per-repo locking proven by tests.
- [ ] `.orchestra/` never shows in `git status`.
- [ ] Scratch repo tooling available for all M1 TCs.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Repos with submodules/LFS: worktree add may need extra steps — document as unsupported in M1, flag in `WorktreeStatus`.
- Claude `--worktree` creates its own layout; M1-05 decides whether to pass `nativeFlag` or run inside ours (default ours).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
