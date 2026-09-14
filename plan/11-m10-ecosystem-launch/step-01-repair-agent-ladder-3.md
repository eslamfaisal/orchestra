# Step M10-01 — Repair Agent (ladder 3)

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M6-04, M3-04, M3-06, M1-12, M6-03 |
| Estimated effort | 4 days |
| Packages touched | `packages/core`, `packages/sdk`, `apps/daemon`, `apps/web`, `apps/cli`, `tools/`, `CODEOWNERS` |
| Risk | High |
| Owner | |

## 1. Goal
A `RepairCase` that ladder steps 1–2 could not close can be handed to the Repair Agent from the Health screen or `orch repair propose <caseId>`. The agent runs as an ordinary Orchestra task (taskType `bugfix`, most restrictive sandbox profile) inside a git worktree of the Orchestra source repository, receives the failing fixture(s), the CLI's `--help` output, cached release notes, the adapter's contract tests and the current manifest, and produces a **proposal**: a patch confined to `packages/providers/<id>/{src,manifest.json,fixtures}` plus the contract-suite result from that worktree. The user sees diff, guard verdict, suite result and budget usage in Health and either opens a PR (`gh`, user's own credentials) or — for manifest/fixture-only patches — applies locally after explicit approval. Nothing is ever applied without a human decision.

## 2. Why
- **D6** — the platform maintains itself; ladder 3 is the last automated rung before `needs_human` (source plan §10.3).
- **G6** — vendor changes become actionable items *with a candidate fix attached*, not just alerts.
- **D5** — providers are plugins with manifest + fixtures + contract tests, so a repair has a bounded, machine-verifiable target.
- **C12** — path-based guard + CODEOWNERS: the agent cannot modify auth probes, ToS/compliance rules, `BinaryRegistry` allowlist, ESLint rules, `SECURITY.md`. Also **C1/C8** (only official binaries, documented flags — the agent is itself a normal session), **C9** (CI uses `FakeProvider` repair scenarios only), **C10** (every apply previewed, permissioned, audited).
- **R13** ("Repair Agent modifies something it must not") mitigated by deny list, semantic manifest guard, assisted-only.
- Closes the open decision in `DECISIONS.md` "Repair Agent trust boundary": **assisted-only**. PR is the default output; local apply is allowed only for manifest + fixture changes, after guard pass + suite green + explicit approval (+ 4-eyes in team mode, M9-04). Record as `ADR-015 Repair Agent trust boundary`.

## 3. Scope
### In scope
- `RepairProposal` entity; `RepairCase` transitions `assisted → proposed → approved → applied → fixed` and `→ needs_human`.
- `RepairGuard` (path deny/allow lists + manifest semantic guard) and `RepairBudget` (tokens, wall clock, iterations).
- Input assembly (`RepairInputs`) and `REPAIR.md` brief written into the worktree.
- Provisioning a worktree of the Orchestra source repo pinned to the running daemon version.
- Running the repair as a task through the existing pipeline (assignment engine with `bugfix` constraints, SessionSupervisor, Terminals, Attention).
- Contract-suite execution inside the worktree; result capture.
- Publish as PR via `gh` (reuses M3-06) or local apply of manifest/fixtures via M6-03 override + rollback.
- Health UI proposal panel, `orch repair` commands, audit events, `FakeProvider` repair scenarios.
### Out of scope (deferred to …)
- Autonomous apply of any kind — never (ADR-015).
- Local apply of adapter **source** changes (needs build + release) — PR only; deferred indefinitely.
- Repairs outside `packages/providers/*` (core/daemon bugs) → `needs_human` (post-1.0).
- Repairs of third-party registry plugins → `needs_human` with link to the plugin repo (post-1.0; registry M10-03 exposes `repository`).
- Propagating the fix to other users → M10-02 (drift loop) + M10-03 (registry).
- More than `maxIterations` agent rounds → post-1.0.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- **`RepairProposal`** (child of `RepairCase`): `{id, caseId, sessionId, worktreeId, branch, baseCommit, filesTouched[], diffStat, patchRef, guard: GuardVerdict, suite: SuiteResult|null, budgetUsed, state, decidedBy?, decidedAt?, prUrl?}`.
  States: `running → collected → (approvable | blocked) → approved(pr|local) → published | applied → fixed`, or `→ rejected`, or `→ failed(reason)`.
- **`RepairGuard`** (pure domain service, `packages/core/src/rules/repair-guard.ts`): `evaluate(files, manifestDiff) → GuardVerdict`. Deny wins over allow; anything not in allow is a violation.
- **`RepairBudget`** VO: `{maxTokens: 400_000, maxWallClockMs: 45 min, maxIterations: 2}` defaults from config `repair.budget`; breach → `budget_exceeded`, case → `needs_human`.
- **Rule `approvable`**: `guard.allowed && suite?.passed === true && !budgetExceeded && filesTouched.length > 0`.
- **Rule `localApplyEligible`**: `approvable && filesTouched.every(f => f matches manifest.json | fixtures/**)`.
- **Rule `reviewerConstraint`**: the provider assigned to run the repair must differ from the drifted provider when at least one other healthy provider exists (cross-vendor, G3); otherwise flagged `sameVendorRepair` in the proposal.

**Guardrail list (C12, enforced by `RepairGuard`; config lives in a guarded path):**
| # | Deny (glob, repo-relative) | Why |
|---|---|---|
| G1 | `packages/providers/*/src/auth*`, `**/auth-probe*` | C3 — auth probes |
| G2 | `packages/core/src/rules/compliance/**`, `packages/core/src/rules/repair-guard*` | ToS/compliance rules, the guard itself |
| G3 | `apps/daemon/src/infrastructure/binaries/**` | `BinaryRegistry` allowlist (C1) |
| G4 | `tools/eslint-rules/**`, `eslint.config.*`, `.eslintrc*`, `.dependency-cruiser.cjs` | ESLint/arch controls (C2, C7) |
| G5 | `SECURITY.md`, `CODEOWNERS`, `.github/**`, `LICENSE*` | governance & CI |
| G6 | `packages/sdk/src/contract/**` | contract tests may not be weakened |
| G7 | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, any `**/package.json` | no dependency changes |
| G8 | manifest semantic: `tos.*`, `provider`, `updateSources.*` unchanged; `headless.flags` may only add flags present in captured `--help` | C8, C11 |
| Allow | `packages/providers/<id>/src/**` (minus G1), `packages/providers/<id>/manifest.json`, `packages/providers/<id>/fixtures/<cliVersion>/**`, `packages/providers/<id>/README.md` | the repair target |

### 4.2 Interfaces / contracts
```ts
// packages/core/src/maintenance/repair-proposal.ts
export type ProposalState = 'running' | 'collected' | 'approvable' | 'blocked' | 'approved' | 'published' | 'applied' | 'fixed' | 'rejected' | 'failed';
export interface GuardVerdict { allowed: boolean; violations: { path: string; rule: 'G1'|'G2'|'G3'|'G4'|'G5'|'G6'|'G7'|'G8'; detail?: string }[] }
export interface SuiteResult { passed: boolean; total: number; failed: string[]; durationMs: number; reportRef: string }
export interface RepairBudget { maxTokens: number; maxWallClockMs: number; maxIterations: number }
export interface RepairInputs {
  caseId: string; provider: ProviderId; cliVersion: string;
  failingFixtures: { path: string; error: string }[];   // from RepairCase.evidence
  helpOutput: string;                                   // Doctor probe capture (`<cli> --help`, quota-free)
  releaseNotes: { source: string; excerpt: string }[];  // M6-05 watcher cache only; no live fetch here
  contractSpecs: string[];                              // read-only paths
  manifestPath: string; manifest: CapabilityManifest;
}

// packages/core/src/rules/repair-guard.ts (pure, 100 % branch)
export function evaluateRepairGuard(files: string[], manifestDiff: JsonPatchOp[], cfg: RepairGuardConfig): GuardVerdict;

// apps/daemon/src/application/maintenance/*  (one use case per class, Result everywhere)
export class ProposeRepair { execute(cmd: { caseId: string; actor: Actor }): Promise<Result<RepairProposal, ProposeRepairError>> }
export class CollectRepairProposal { execute(cmd: { proposalId: string }): Promise<Result<RepairProposal, CollectError>> }  // on session end
export class RunRepairContractSuite { execute(cmd: { proposalId: string }): Promise<Result<SuiteResult, SuiteError>> }
export class ApproveRepairProposal { execute(cmd: { proposalId: string; mode: 'pr'|'local'; actor: Actor; idempotencyKey: string }): Promise<Result<RepairProposal, ApproveError>> }
export class RejectRepairProposal { execute(cmd: { proposalId: string; reason: string; actor: Actor }): Promise<Result<void, RejectError>> }
export type ProposeRepairError = { code: 'CaseNotAssistable' } | { code: 'SourceRepoUnavailable' } | { code: 'NoHealthyProvider' } | { code: 'BudgetInvalid' };
export type ApproveError = { code: 'NotApprovable'; verdict: GuardVerdict } | { code: 'LocalApplyIneligible'; files: string[] } | { code: 'FourEyesRequired' } | { code: 'PrPublishFailed'; stderr: string };

// ports (apps/daemon/src/application/ports)
export interface SourceRepoPort { ensureClone(ref: string): Promise<Result<string, RepoError>>; addWorktree(caseId: string, branch: string): Promise<Result<WorktreeRef, RepoError>>; diff(wt: WorktreeRef): Promise<Result<{ files: string[]; patch: string; stat: DiffStat }, RepoError>>; removeWorktree(wt: WorktreeRef): Promise<void> }
export interface ContractSuiteRunner { run(wt: WorktreeRef, provider: ProviderId, timeoutMs: number): Promise<Result<SuiteResult, SuiteError>> }
export interface ManifestOverrideApplier { apply(provider: ProviderId, manifest: CapabilityManifest, fixtures: FileWrite[], source: { proposalId: string }): Promise<Result<void, ApplyError>>; rollback(provider: ProviderId): Promise<Result<void, ApplyError>> }  // M6-03
```

### 4.3 Data / schema changes
- New table `repair_proposals`: `id, case_id, session_id, worktree_id, branch, base_commit, files_json, diff_stat_json, patch_ref, guard_json, suite_json, budget_used_json, state, decided_by, decided_at, pr_url, created_at`. Migration `NNN_repair_proposals`; Postgres-compatible types only.
- `repair_cases.patch_ref` (exists) now points at the accepted proposal's patch file.
- Events (`doctor.*`): `repair_proposed`, `repair_collected`, `repair_guard_violation`, `repair_suite_finished`, `repair_budget_exceeded`, `repair_approved`, `repair_pr_opened`, `repair_applied`, `repair_rolled_back`, `repair_rejected`. Every one carries `patchSha256` and `actor`. `audit.*` rows for approve/reject/apply.
- Files: `~/.orchestra/repair/src/` (clone), `~/.orchestra/repair/worktrees/<caseId>/`, `~/.orchestra/repair/<caseId>/{REPAIR.md,proposal.patch,suite.json,help.txt}`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Source repo**: config `repair.sourceRepo: { remote: 'https://github.com/<org>/orchestra.git', ref: 'v<daemonVersion>' , path?: string }`. Clone/fetch is allowed egress (GitHub, C2). Worktree branch `repair/<provider>/<cliVersion>/<caseId>`. `pnpm install --frozen-lockfile --prefer-offline` (registry egress, allowed). Failure → `SourceRepoUnavailable`, case → `needs_human`.
- **Session**: launched through `SessionSupervisor` exactly like a Quick Delegate (M1-12) with `HeadlessSpec` or interactive per provider; cwd = repair worktree; instruction file per `manifest.paths.instructionFile` is `REPAIR.md`. Sandbox = the provider's most restrictive `sandboxProfiles` entry (as listed in its manifest) plus an auto-answer policy (M8-08 rules) that denies any tool call whose path is outside the worktree and denies shell commands not in `['pnpm test', 'pnpm vitest', 'pnpm --filter', 'git diff', 'git status', '<cli> --help', '<cli> --version']`. Anything else becomes an `AgentPrompt` in Attention — the human decides.
- **Network**: the agent's own vendor connection is its official channel (unchanged). The daemon performs only: git fetch (GitHub), pnpm (registry), `gh pr create` (GitHub, user credentials). `--help` output and release notes come from Doctor/M6-05 caches; no live vendor fetch in this step.
- **Contract suite**: `pnpm --filter ./packages/providers/<id> exec vitest run --reporter=json --outputFile=<case>/suite.json`, timeout `repair.suiteTimeoutMs` (default 10 min), child env allowlist only.
- **Patch**: `git diff <base>..HEAD` → `proposal.patch`; sha256 into events; guard evaluated on `git diff --name-only` plus a JSON-patch of `manifest.json`.
- **Local apply**: manifest + fixtures copied to `~/.orchestra/manifests-cache/<provider>/override-<proposalId>/`; `ManifestOverrideApplier` hot-reloads (M6-03) and keeps last-known-good; Doctor re-runs the drift check; if still failing → automatic rollback + case `needs_human`.

### 4.5 API / UI surface
- `POST /repair-cases/:id/propose` → 202 `{proposalId}` · `GET /repair-cases/:id/proposal` · `POST /repair-proposals/:id/approve {mode}` (`Idempotency-Key` required) · `POST /repair-proposals/:id/reject {reason}` · `GET /repair-proposals/:id/patch` (text/x-diff). RBAC (M9-01): approve = Lead/Admin; 4-eyes when policy demands.
- WS topic `repair` mirrors `doctor.repair_*` events.
- CLI: `orch repair propose <caseId>` · `orch repair show <caseId> [--patch]` · `orch repair approve <proposalId> --pr | --local` · `orch repair reject <proposalId> --reason "…"` · all with `--json`.
- Web (Health → case → "Proposal" tab): inputs summary, live link to the repair session's Terminal, files touched with guard badge per file, suite result, budget meter, diff viewer (reuses M3-05 diff component), buttons **Open PR** / **Apply locally** (disabled with reason when not eligible) / **Reject**. Apply shows a preview modal listing exact files and "rollback available".

### 4.6 Flow / sequence
```
RepairCase(state=assisted)  ──user: propose──▶ ProposeRepair
  1 assemble RepairInputs (fixtures, help.txt, notes cache, contract spec paths, manifest)
  2 SourceRepoPort.ensureClone(v<daemon>) → addWorktree(caseId) → write REPAIR.md + inputs/
  3 AssignmentEngine.assign({taskType:'bugfix', constraints:{excludeProvider?: <drifted>, sandbox:'strict'}})
  4 SessionSupervisor.start(headless/interactive) → session visible in Terminals; prompts → Attention
  5 on session.stopped → CollectRepairProposal: diff, guard, RunRepairContractSuite
  6 state = approvable | blocked (guard/suite/budget); event + WS + notification
  7 user: approve --pr  → PrPublisher (M3-06): push branch, `gh pr create --title "M10 repair(<provider>): …"` → published
     user: approve --local → ManifestOverrideApplier.apply → Doctor recheck → fixed | rollback→needs_human
     user: reject → rejected; worktree removed after `repair.keepWorktreeDays`
```

## 5. Tasks
- [ ] Core: `RepairProposal` entity, states, `approvable`/`localApplyEligible` rules, `RepairBudget` VO, unit tests (100 % branch).
- [ ] Core: `evaluateRepairGuard` with G1–G8 config schema (Zod) and default config file at `packages/core/src/rules/repair-guard.config.json`; add both paths to CODEOWNERS.
- [ ] Daemon: migration `repair_proposals`, repository (in-memory + SQLite), event payload schemas.
- [ ] Daemon: `SourceRepoPort` implementation (`infrastructure/repair/git-source-repo.ts`): clone/fetch pinned tag, worktree add/remove, diff/name-only, patch file.
- [ ] Daemon: `RepairInputAssembler` (help capture from Doctor cache, M6-05 notes cache, fixtures from case evidence, manifest) + `REPAIR.md` template.
- [ ] Daemon: `ProposeRepair` use case wired to assignment engine (`bugfix`, exclude drifted provider, strict sandbox) and SessionSupervisor; budget tracker consuming M4-01 usage events + wall clock.
- [ ] Daemon: auto-answer policy fragment for repair sessions (deny outside worktree, shell allowlist) via M8-08 rules; unknown → Attention prompt.
- [ ] Daemon: `CollectRepairProposal` + `RunRepairContractSuite` (vitest JSON reporter, timeout, env allowlist).
- [ ] Daemon: `ApproveRepairProposal` (pr via M3-06 `PrPublisher`; local via `ManifestOverrideApplier` + Doctor recheck + rollback), `RejectRepairProposal`, idempotency keys, RBAC + 4-eyes hook.
- [ ] Daemon: HTTP routes + WS topic + OpenAPI; audit interceptor coverage for approve/reject/apply.
- [ ] CLI: `orch repair propose|show|approve|reject` with `--json`.
- [ ] Web: Health proposal tab (files + guard badges, suite, budget, diff viewer, actions with disabled reasons, apply preview modal).
- [ ] SDK/FakeProvider: scenarios `repair-fixes-manifest.yaml`, `repair-touches-guarded-path.yaml`, `repair-exceeds-budget.yaml`, `repair-suite-fails.yaml`.
- [ ] Docs: ADR-015 (trust boundary), Health docs section, `SECURITY.md` paragraph on ladder 3; update `DECISIONS.md` open decision row.
- [ ] Run TC table on a real injected drift (M6 fixture drift injection) with a real provider as repairer.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M10-01-01 | unit | `evaluateRepairGuard` against every G1–G8 rule and allow paths (table-driven, 100 % branch) | violations reported with rule id; allow-only set passes |
| UT-M10-01-02 | unit | manifest semantic guard: change to `tos.url`, `provider`, `updateSources`, flag not in `--help` | `G8` violation with detail |
| UT-M10-01-03 | unit | `RepairProposal` state machine + `approvable`/`localApplyEligible` rules incl. budget breach | illegal transitions → `Err(InvalidTransition)` |
| AT-M10-01-01 | application | `ProposeRepair` with FakeProvider scenario `repair-fixes-manifest` | proposal `approvable`; suite passed; files ⊆ allow |
| AT-M10-01-02 | application | scenario `repair-touches-guarded-path` (edits `SECURITY.md`) | state `blocked`, `doctor.repair_guard_violation` emitted, approve → `NotApprovable` |
| AT-M10-01-03 | application | scenario `repair-exceeds-budget` | session stopped, `repair_budget_exceeded`, case `needs_human` |
| AT-M10-01-04 | application | approve `--local` on proposal touching `src/` | `LocalApplyIneligible` with file list |
| AT-M10-01-05 | application | approve twice with same `Idempotency-Key` | second call returns first result, one PR/apply |
| IT-M10-01-01 | integration | `GitSourceRepo`: clone pinned tag, add worktree, diff, remove (real git, scratch remote) | branch name pattern, patch file sha matches event |
| IT-M10-01-02 | integration | `ContractSuiteRunner` runs provider suite in a worktree with a deliberately broken fixture | `passed=false`, failing spec ids listed, timeout honoured |
| IT-M10-01-03 | integration | local apply → Doctor recheck fails → automatic rollback | manifest cache restored, `repair_rolled_back` emitted |
| IT-M10-01-04 | integration | egress test: repair flow with fake `gh` on PATH | only GitHub/registry hosts contacted; no vendor endpoints |
| E2E-M10-01-01 | e2e | Health → propose → proposal tab → Open PR (fake `gh`) | PR url shown; case `fixed` after suite green |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-01-01 | Repair proposes a manifest fix for injected drift | 1. Inject fixture drift for `codex` (M6 procedure: rename a hook event in fixture copy) so ladder 1–2 fail. 2. Health → case → **Propose repair**. 3. Watch the session in Terminals. 4. Wait for `collected`. | Session runs in `~/.orchestra/repair/worktrees/<caseId>`, repairer provider ≠ codex, proposal shows files under `packages/providers/codex/…` only, suite green, state `approvable` | ⬜ |
| TC-M10-01-02 | Open PR | 1. From TC-01 click **Open PR**. 2. `gh pr view <url>`. | PR on user's fork/branch `repair/codex/<ver>/<caseId>`, title prefixed `repair(codex)`, body contains inputs summary + suite result; audit row present | ⬜ |
| TC-M10-01-03 | Local apply of manifest-only proposal with rollback | 1. Propose on a case whose fix is manifest-only. 2. **Apply locally** → confirm preview. 3. Break the override file by hand. 4. Trigger `orch doctor`. | Apply hot-reloads within 10 s and case → `fixed`; after step 3–4 Doctor detects failure, rolls back to last-known-good, case `needs_human`, `repair_rolled_back` in Health | ⬜ |
| TC-M10-01-04 | Guarded path violation (negative) | 1. Run `FakeProvider` scenario `repair-touches-guarded-path` via `orch repair propose` on a fake case. 2. Open proposal. | State `blocked`; `SECURITY.md` listed with rule `G5`; **Open PR** and **Apply** disabled with reason "guard violation"; `orch repair approve` returns `NotApprovable` | ⬜ |
| TC-M10-01-05 | Budget exceeded (negative) | 1. Set `repair.budget.maxWallClockMs=60000`. 2. Propose on a real case with a slow provider. | Session stopped at ~60 s, proposal `failed(budget_exceeded)`, case `needs_human`, Attention item created | ⬜ |
| TC-M10-01-06 | Agent asks for out-of-scope permission | 1. Propose repair. 2. When the agent requests a shell command outside the allowlist, observe Attention. 3. Deny. | Prompt appears in Attention with the exact command; deny is delivered; agent continues or stops; no command executed outside allowlist (check recording) | ⬜ |
| TC-M10-01-07 | Contract suite fails (negative) | 1. Use scenario `repair-suite-fails`. | State `blocked`, failing spec ids shown, approve disabled | ⬜ |
| TC-M10-01-08 | Source repo unavailable | 1. Set `repair.sourceRepo.remote` to an unreachable URL. 2. Propose. | `SourceRepoUnavailable` shown; case `needs_human`; no worktree left behind | ⬜ |
| TC-M10-01-09 | Reject and cleanup | 1. Propose, then **Reject** with reason. 2. Wait `repair.keepWorktreeDays=0`. | State `rejected`, reason in audit, worktree removed on next Doctor run | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] On an injected drift that ladder 1–2 cannot fix, `Propose repair` yields an `approvable` proposal whose suite is green in the worktree, in ≤ `maxWallClockMs`.
- [ ] No code path applies a patch without an `ApproveRepairProposal` call carrying a human/4-eyes actor; verified by grep-free architecture test (only that use case calls `ManifestOverrideApplier.apply`/`PrPublisher`).
- [ ] Every G1–G8 rule has a passing unit test; `RepairGuard` config path is in CODEOWNERS.
- [ ] Every proposal and decision produces `doctor.repair_*` + `audit.*` events with `patchSha256`.
- [ ] Egress test: repair flow contacts only GitHub and the package registry.
- [ ] `repair-guard`, `repair-proposal` modules at 100 % branch coverage; others ≥ 80 %.
- [ ] ADR-015 accepted and linked from `DECISIONS.md`; open decision row closed.
- [ ] All TC-M10-01-01…09 pass and are recorded.
- [ ] No new lint / dependency-cruiser / arch violations.

## 8. Risks / open questions
- Agent quality: a repair may "fix" a fixture by editing it to match wrong behaviour. Mitigation: fixtures for the *old* CLI version are read-only in the guard; only `fixtures/<newCliVersion>/**` may be added (add rule to G-list at implementation: `fixtures/<cliVersion≠case.cliVersion>/**` denied).
- Which shell commands each provider's sandbox actually blocks differs (Codex `workspace-write` vs Claude permission modes vs agy `request-review`) — mapping to "strict" must be confirmed per manifest (verify against each provider's docs at step start).
- Installed builds (Tauri) have no source checkout; clone size and pnpm install time may exceed budget on first run — pre-warm clone at install of the daemon? (decide at implementation; default: lazy clone with progress in Health).
- Repairing a provider with the same provider (only one healthy) is allowed but flagged; consider blocking in team mode via policy.
- `gh` availability and auth state must be probed (M3-06 already handles `gh auth status`).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
