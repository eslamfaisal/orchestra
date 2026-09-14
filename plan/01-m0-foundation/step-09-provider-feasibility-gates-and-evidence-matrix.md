# Step M0-09 — Provider feasibility gates & evidence matrix

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-03 |
| Estimated effort | 3 days |
| Packages touched | `packages/sdk`, provider fixtures, `docs/providers`, plan evidence matrix |
| Risk | High — external interfaces and account access |
| Owner | |

## 1. Goal
Prove the minimum usable Claude Code and Codex execution modes before their adapters are implemented. Produce dated, reproducible evidence for each provider/version/mode/operation. This is a human-run feasibility experiment in a disposable repository, not a finished adapter or runtime certification.

## 2. Why
The review identified assumptions in the shared contract that no provider fixture yet supports. A narrow SDK skeleton can precede the experiments; M1-05 and M1-06 cannot begin until their launch, interaction and lifecycle contracts are reconciled with real observations.

## 3. Scope
### In scope
- Pin installed CLI version, protocol/schema revision, OS and launch mode; reread official sources in foundation 14.
- Test launch, structured telemetry, cancellation, permissions, questions, plan approval, usage/rate-limit observations, exit identity and restart/adoption independently.
- Capture redacted fixtures and limitations; change SDK assumptions when the protocol contradicts them.
### Out of scope
- Product implementation, live production repositories, credential collection, automated login and CI account usage.
- Antigravity remains optional and disabled under ADR-008. Its absence cannot block this step.

## 4. Design
### 4.1 Evidence record
Use foundation 14's states. Each individual operation needs provider, exact CLI version, mode, source URL and retrieval date, experiment command, expected/observed result, fixture hash/path, tester/date and limitation. A grouped row must be split before assigning evidence. Documentation and mock tests do not promote runtime support.

### 4.2 Minimum release capability
For each required adapter, select at least one mode that proves launch in a worktree, structured session/turn identity, one supported permission round-trip (including correlated outcome), cancellation outcome and durable process-exit observation. If any of these cannot be demonstrated, the adapter gate remains blocked and MVP scope must be revised explicitly. Marking a mandatory operation `unsupported` does not satisfy this gate.
Other operations may be `limited`, `manual-only` or `unsupported`, with their dependent feature disabled or clearly restricted. Unknown quota is acceptable. Seamless restart is not mandatory: accurately reporting transport loss and a manual recovery path is acceptable. Unverified modes stay disabled.

### 4.3 Experiments
Claude interactive and headless modes are separate experiments; verify actual hook/tool payloads and whether a documented permission host is required. Do not add an SDK runtime to the official-binary architecture without an ADR. Codex app-server uses the installed binary's generated schema; `exec --json` is a separate capability profile and a new execution, not a seamless fallback. A transcript pane must be labelled as a transcript.
Use a retained pane or durable process wrapper to distinguish control-client disconnection from process termination. Kill only experiment-owned processes. Inject daemon/client downtime before prompt capture, after capture, after answer submission and before acknowledgement; record exactly which states can be recovered.

## 5. Tasks
- [ ] Record prerequisite versions and officially documented launch commands; designate a tester and disposable repo.
- [ ] Run positive and negative experiments per required operation and mode.
- [ ] Redact fixtures before committing; retain hashes, test IDs and source dates.
- [ ] Split grouped matrix rows and fill observed capability records with limitations.
- [ ] Reconcile SDK, M1-05/M1-06 and M1-11 contracts with results; disable unsupported features.
- [ ] Record gate verdict and remaining blockers in PROGRESS; no assumed approvals.

## 6. Tests
### 6.1 Automated
Fixture/schema validation, capability projection consistency and negative missing-evidence checks run without vendor accounts. Test that a mandatory `unsupported` row fails the release gate and optional unsupported rows disable only the feature.

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-09-01 | Claude modes | Launch each candidate mode in scratch repo; capture session identity | Each mode gets separate observed results and version-pinned fixtures | ⬜ |
| TC-M0-09-02 | Claude interactions | Trigger permission, question and plan tools; allow/deny and observe | Correlated outcomes or explicit limitation; no invented hook name | ⬜ |
| TC-M0-09-03 | Codex schema | Generate schema; launch app-server; trigger approval and cancel | Methods and responses match pinned schema; transcript labelled correctly | ⬜ |
| TC-M0-09-04 | Quota | Read documented in-band usage/limits where available | Units, account and bucket preserved; absent signal stays unknown | ⬜ |
| TC-M0-09-05 | Process lifecycle | Disconnect control client, then terminate child separately | Distinct events; durable child exit status; no false task success | ⬜ |
| TC-M0-09-06 | Recovery | Inject downtime at the four interaction boundaries | Capture gap, recoverable prompt and delivery uncertainty distinguished | ⬜ |
| TC-M0-09-07 | Negative gate | Leave mandatory capability unverified or unsupported | Adapter gate blocks; no fake-provider promotion; Antigravity absence irrelevant | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Both required adapters have a selected mode meeting §4.2 with real evidence.
- [ ] All advertised operations have an explicit state; unsupported features are disabled.
- [ ] Original payloads, schema hashes, tester/date and limitations can reproduce every claim.
- [ ] All manual tests are recorded and shared contracts reconciled; no product step is marked implemented by these experiments.

## 8. Risks / open questions
Three days is an initial experiment budget, not a promise that vendors expose the required controls. Missing account access or provider support blocks the relevant gate. Terms questions remain separate from technical results.

## 9. Notes & progress log
| Date | Note |
|---|---|
| 2026-09-15 | Added missing specification from the review response; experiments not run. |
