# Step M10-08 — 1.0 Definition of Done audit

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M0-01, M0-02, M0-03, M0-04, M0-05, M0-06, M0-07, M0-08, M0-09, M1-01, M1-02, M1-03, M1-04, M1-05, M1-06, M1-08, M1-09, M1-10, M1-11, M1-12, M1-13, M2-01, M2-02, M2-03, M2-04, M2-05, M2-06, M2-07, M2-08, M2-09, M3-01, M3-02, M3-03, M3-04, M3-05, M3-06, M3-07, M3-08, M3-09, M4-01, M4-02, M4-03, M4-04, M4-05, M4-06, M4-07, M5-01, M5-02, M5-03, M5-04, M5-05, M5-06, M6-01, M6-02, M6-03, M6-04, M6-05, M6-06, M6-07, M7-01, M7-02, M7-03, M7-04, M7-05, M7-06, M8-01, M8-02, M8-03, M8-04, M8-05, M8-06, M8-07, M8-08, M9-01, M9-02, M9-03, M9-04, M9-05, M9-06, M9-07, M9-08, M9-09, M10-01, M10-02, M10-03, M10-04, M10-05, M10-06, M10-07 |
| Estimated effort | 1.5 days |
| Packages touched | `plan/` (audit record + evidence), `docs/` (release notes, launch page), `.github/` (release checklist), no product code except gap fixes raised as their own steps |
| Risk | Medium (the risk is declaring done what is not; the mitigation is that this step ships no features) |
| Owner | |

## 1. Goal
One auditable document proves that every line of the 1.0 Definition of Done (`ROADMAP.md`, from source plan §20) holds on the release candidate, on real hardware, with named evidence: a test id that ran on this build, a manual test-case id with its recorded result, a screenshot in `plan/11-m10-ecosystem-launch/evidence/`, or a public URL. The audit re-runs the full gate suite against the RC tag rather than trusting historical green runs, verifies the supply-chain posture (OpenSSF Best Practices *passing*, Scorecard ≥ 7, signed artifacts, provenance, SBOM), and captures the one piece of evidence that cannot be manufactured internally: a **third-party plugin**, built by someone outside the maintainer set, from the published guide, installed on a clean machine with no core PR. Any line that cannot be evidenced becomes a new step in `ROADMAP.md` and `PROGRESS.md` — never a footnote — and 1.0 does not ship until it is closed or explicitly deferred with a written, signed-off consequence. The step ends with the launch checklist executed and a 30-day post-launch monitoring plan that respects the product's own no-telemetry stance.

## 2. Why
- **`ROADMAP.md` "1.0 Definition of Done"** is a contract with the reader of this plan. Fourteen lines were written at the start; this step is where each one is proven rather than assumed.
- **`plan/README.md` workflow rule** — "a step is never marked ✅ with a failing manual test case". At milestone scale the same rule needs a milestone-scale instrument: an evidence table.
- **G1–G7** — every goal has a measurable target (live terminal for 100 % of sessions, ≥ 60 % of tasks off the top-tier model, cross-vendor review on 100 % of mission tasks, drift detected < 60 s, ≥ 1 third-party plugin). A release that cannot show the numbers has not met the goals it was designed around.
- **C1–C13** — compliance is enforced by code, but at a release boundary it must also be *demonstrated*: the egress test, the ESLint compliance rules, the no-secrets assertions and the registry policy are re-run and their outputs archived, because that archive is what a vendor or a procurement reviewer will ask for.
- **D6 / G6** — a self-maintaining platform needs a post-launch watch that does not depend on telemetry the product refuses to collect. The monitoring plan is therefore built from public signals, opt-in aggregates (M10-02) and the canary lane (M6-05).
- **R10 / R16** — the temptation at the end of a long plan is to declare victory. An explicit gap procedure ("a gap becomes a step") is the defence.

## 3. Scope
### In scope
- The audit record `plan/11-m10-ecosystem-launch/1.0-audit.md`: one row per DoD line with verdict, evidence, the build hash it was proven on, and the date.
- Evidence collection protocol and the `evidence/` directory layout (screenshots, JSON reports, transcripts, links).
- A full re-run of the gate suite on the RC tag: unit/application/contract/integration/E2E, the provider fixture matrix, egress, load tests, the restore (`kill -9`) test, SLO measurements for detect/remediate, and the performance budgets.
- Supply-chain verification on the RC assets (cosign, provenance, SBOM parse, Scorecard, Best Practices questionnaire review).
- Third-party plugin proof: recruitment, the unaided build, the clean-machine install, and the archived transcript.
- Goal-metric snapshot (G1–G7) taken from your own 30 days of real usage, with the measurement method written down.
- Launch checklist (repo, docs, registry, release, community, support) and the go/no-go decision record.
- Post-launch monitoring plan for the first 30 days, with owners, cadence and trigger thresholds.
- Gap procedure: how a failed line becomes a `ROADMAP.md` step, and what "deferred with consequence" requires.
### Out of scope (deferred to …)
- Building anything. If the audit finds a gap, the fix is a new step in its own right; this step may only fix documentation and evidence defects.
- Post-1.0 roadmap planning — a separate exercise after launch; this step only records the gaps it found.
- Marketing launch (posts, videos, press) — out of scope for the plan; the checklist covers only what the project itself must have ready.
- Ongoing release management beyond day 30 — folded into the normal release process (M10-07 `docs/release-process.md`).

## 4. Design
### 4.1 Domain
None. This step produces records, not code.

### 4.2 Interfaces / contracts — the audit record format
```md
| # | DoD line | Verdict | Evidence | Build | Date |
|---|---|---|---|---|---|
| DoD-1 | Four adapters pass contract tests on pinned fixtures incl. approval round-trips and quota parsing | ✅ | CT-M1-05-01, CT-M1-06-01, CT-M1-07-01, CT-M10-04-01, CT-M10-05-01 · fixtures-matrix run #<id> · evidence/dod-01-matrix.json | <sha> | <ISO> |
```
Verdicts are exactly: `✅ proven` · `⚠️ proven with a recorded caveat` · `❌ not proven` · `⏸ deferred with consequence`.
Rules:
- **A1 Evidence must be re-runnable or archived.** A test id is valid only if that test ran on the RC build hash in the archived run; a screenshot must carry the build hash in frame or in its filename; a link must be a permalink.
- **A2 One line, one owner, one date.** No aggregate rows, no "see milestone X".
- **A3 `⚠️` requires a caveat sentence** naming what is *not* covered and where it is tracked.
- **A4 `⏸` requires a written consequence**: what a user loses, who is affected, what the workaround is, and the step id that will close it. A `⏸` on a compliance line (C1–C13) is not permitted — those are `✅` or the release does not ship.
- **A5 No self-issued evidence for DoD-11.** The third-party plugin line is proven by an external person's artifact and transcript, not by a maintainer's test plugin.

```
plan/11-m10-ecosystem-launch/evidence/
  dod-01-contract-matrix.json        fixtures matrix run export
  dod-02-review-merge/*.png          Review & Merge on a real repo, two providers
  dod-03-cross-vendor-e2e.txt        e2e output showing reviewer.provider ≠ author.provider
  dod-04-prompts/{web,pwa}/*.png     one screenshot per provider × surface
  dod-05-slo.json                    detect/remediate timings, p50/p95, n ≥ 20
  dod-06-desktop/*.png|txt           notarization + updater + budgets
  dod-07-restore.txt                 kill -9 transcript with prompt counts before/after
  dod-08-forecasts/*.png             one per provider, official/estimate labels visible
  dod-09-supplychain/                cosign output, provenance JSON, SBOM, Scorecard report, badge page
  dod-10-docs/                       site URLs + ADR index + guide screenshots (EN + AR)
  dod-11-thirdparty/                 plugin repo permalink, install transcript, author's write-up
  dod-12-rtl/*.png                   UI + docs RTL
  dod-13-identity/                   ADR-002, org/scope/domain proofs
  dod-14-compliance/                 egress test output, ESLint rule runs, no-secrets grep results
  goals/G1..G7.md                    metric, method, value, sample window
```

### 4.3 Data / schema changes
None. The audit adds a `1.0 audit` section to `PROGRESS.md` linking the record, and `RISKS.md` is reviewed at the milestone boundary (every row gets a status: Open / Mitigated / Retired) as part of the go/no-go.

### 4.4 Infrastructure — the re-run matrix (all on the RC tag, archived)
| Suite | Command | Environment | Archived as |
|---|---|---|---|
| Typecheck / lint / arch | `pnpm typecheck && pnpm lint && pnpm depcruise` | CI, Node 22 + 24 | run link |
| Unit + application + coverage | `pnpm test -- --coverage` | CI | coverage report |
| Contract / fixtures matrix | `fixtures-matrix.yml` for the four required providers (Antigravity only when its gate is resolved) | CI, **no vendor credentials** (C9) | `dod-01-contract-matrix.json` |
| Parser fuzz | fast-check suites | CI | run link |
| Integration (tmux, git, sqlite, recorder, hooks) | `pnpm test:integration` | CI ubuntu + local macOS | run links |
| E2E | Playwright with `FakeProvider` | CI | HTML report |
| Egress | `apps/daemon/test/egress.spec.ts` + registry/plugin/opencode jobs | CI | `dod-14-compliance/egress.txt` |
| Load | 50 panes, 10k events/min, 10k-line scrollback | local, real tmux | `dod-06-desktop/budgets.txt` |
| Restore | `kill -9` mid-prompt ×5 | local, real CLIs | `dod-07-restore.txt` |
| SLO | inject drift ×20, measure detect + remediate | local, real CLIs | `dod-05-slo.json` |
| Supply chain | cosign verify, npm provenance, SBOM parse, Scorecard, `pnpm audit --prod` | local + CI | `dod-09-supplychain/` |
| Real-CLI acceptance | M1-13, M3-09 demo scripts re-run on the RC | local, real repo | screenshots + transcripts |

Goal metrics use the canonical definitions and query contracts in foundation 15. Archive exact query/version/parameters, numerator, denominator, exclusions and ≥30-day observation dates in evidence/goals. K1 routing share never substitutes for K2 productive usage; G3 counts required-review tasks with independent-publisher review on the final source revision.

### 4.5 API / UI surface
None. Two documents are produced for users: the 1.0 release notes (generated by semantic-release, then edited for narrative) and a docs "What 1.0 means" page summarising the DoD verdicts honestly, including any `⚠️` and `⏸` lines.

### 4.6 Flow / sequence
```
1 cut RC tag v1.0.0-rc.N from main (M10-07 pipeline, prerelease channel)
2 run the whole matrix in §4.4 against that exact build; archive every output under evidence/
3 fill 1.0-audit.md row by row; each row gets verdict + evidence + build hash + date
4 third-party plugin proof (DoD-11): external author builds from the published guide only;
  archive repo permalink, their write-up, and a clean-machine install transcript
5 goal metrics snapshot (G1–G7) with queries
6 RISKS.md milestone review: every row Open / Mitigated / Retired, with a note
7 gap triage: each ❌ → new step in ROADMAP.md + PROGRESS.md (id, effort, owner) → RC is re-cut after the fix
             each ⏸ → written consequence + sign-off; never on a compliance line
8 launch checklist (§5) → go / no-go decision recorded in 1.0-audit.md with a date and a name
9 promote the RC to v1.0.0 (M10-07); publish release notes and the "What 1.0 means" page
10 start the 30-day monitoring plan (§4.7)
```

### 4.7 Post-launch monitoring plan (30 days) — without telemetry
The product collects nothing by default (C13, `07-compliance-rules.md` data handling), so monitoring is built from signals that do not require it:

| Signal | Source | Cadence | Threshold / action |
|---|---|---|---|
| Crash and error reports | GitHub issues with the bug template (users paste their own logs) | daily | any crash-on-start issue → patch release within 72 h |
| Vendor CLI releases | M6-05 release watchers on `manifest.updateSources` + canary lane | continuous | a canary failure → manifest fix via the registry within 24 h |
| Drift in the wild | M10-02 opt-in aggregates, k ≥ 3 | daily | a new `(provider, cliVersion, driftKind)` above threshold → advisory + manifest fix |
| Registry health | uptime check of the index host; install failures reported | daily | index unavailable > 1 h → status note in Discussions; client works offline by design |
| Supply chain | Scorecard weekly run, `pnpm audit`, Dependabot/Renovate, npm advisory feed | weekly | Scorecard < 7 or a critical advisory → blocking issue, release gate stays closed |
| Security reports | private advisories (`SECURITY.md` SLA: ack ≤ 48 h) | continuous | critical → fix or mitigation ≤ 14 d, coordinated disclosure ≤ 90 d |
| Updater health | GitHub Release asset download counts + staged-rollout stage state | per release | anomalous failure reports → halt the rollout, keep the previous version installable |
| Plugin ecosystem | new `orchestra-provider-*` publications, `orch plugin check` questions | weekly | recurring questions → docs fix (M10-06) rather than a support reply |
| Your own dogfooding | daily use on real work; Health screen; `orch doctor` | daily | any SLO miss → RepairCase, and a plan step if it recurs |

Explicitly **not** done: automatic crash reporting, usage analytics, install pings, or any beacon. If a future release wants them, they follow the M10-02 pattern (opt-in, previewable, anonymised) and need an ADR.

## 5. Tasks
- [ ] Create `plan/11-m10-ecosystem-launch/1.0-audit.md` with the 14 DoD rows, the verdict legend and rules A1–A5.
- [ ] Create `evidence/` with the directory layout in §4.2 and a `README.md` stating the naming rules (build hash in every filename).
- [ ] Cut `v1.0.0-rc.1` through the M10-07 pipeline; record the build hash everywhere.
- [ ] Re-run the full matrix in §4.4 on that build; archive every output; link each from the audit rows.
- [ ] DoD-1: run the fixtures matrix for the four required providers (Antigravity only when its gate is resolved); confirm each includes an approval round-trip fixture and a rate-limit fixture; export the report.
- [ ] DoD-2/3: re-run the M3-09 mission on a real repository across two providers; capture the PR, the review rounds and the reviewer-provider check.
- [ ] DoD-4/8: one screenshot per provider × {web, PWA} of a prompt answered through its declared transport, and one forecast screenshot per provider with the *official*/*estimate* label visible (noting providers that legitimately have no window, M10-05 B4).
- [ ] DoD-5/7: inject drift 20 times and record detect/remediate p50/p95; `kill -9` the daemon mid-prompt five times and compare prompt counts and payloads; archive both transcripts.
- [ ] DoD-6: verify notarization, the updater (verify-before-delete, staged rollout, OS floor) and the memory/fps budgets; archive outputs.
- [ ] DoD-9: cosign verify, npm provenance inspect, SBOM parse, Scorecard report, Best Practices questionnaire re-read for truthfulness; archive all.
- [ ] DoD-10/12/13: capture the docs site URLs, ADR index and both author guides in EN and AR; RTL screenshots of the UI's main screens; ADR-002 plus org/scope/domain proofs and consistent mark usage.
- [ ] DoD-11: recruit the external author (started during M10-03), hand over only the published URL, archive their repo permalink, write-up and a clean-machine install transcript; confirm zero core PRs were needed.
- [ ] DoD-14: archive the egress test output, both compliance ESLint rule runs, the no-secrets greps and the registry policy page.
- [ ] Goal metrics G1–G7 with their queries over a ≥ 30-day window; write the method next to each number.
- [ ] `RISKS.md` milestone review: set every row to Open / Mitigated / Retired with a note; move closed rows to "Retired risks".
- [ ] Gap triage: create a `ROADMAP.md` + `PROGRESS.md` step for every `❌`; write the consequence text for every `⏸`; re-cut the RC after fixes.
- [ ] Execute the launch checklist; record the go/no-go decision with a date and a name in `1.0-audit.md`.
- [ ] Publish 1.0 release notes and the docs "What 1.0 means" page including every `⚠️`/`⏸`.
- [ ] Stand up the 30-day monitoring plan: calendar entries, issue labels, dashboards/queries, and who acts on each threshold.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| AT-M10-08-01 | ci | full gate suite on the RC tag (typecheck, lint, depcruise, unit, application, contract, integration, e2e) | all green on the exact release build; run links archived |
| CT-M10-08-01 | contract | fixtures matrix across required claude, codex, kimi, opencode; agy only when enabled | every provider passes all seven specs, including an approval round-trip and a rate-limit fixture |
| IT-M10-08-01 | integration | egress suite (daemon, registry, plugins, drift reports, opencode) | only allowlisted hosts contacted; zero egress with the optional features disabled |
| IT-M10-08-02 | integration | restore test: `kill -9` mid-prompt ×5 | persisted records and payloads accounted for; usable recovery and capture gaps reported separately |
| IT-M10-08-03 | integration | SLO harness: 20 injected drifts | p95 time-to-detect < 60 s and p95 safe-remediation < 10 s |
| IT-M10-08-04 | integration | supply-chain verification of the RC assets | cosign verify OK, provenance names this repo/workflow, SBOM parses, Scorecard ≥ 7, `pnpm audit --prod` clean |
| E2E-M10-08-01 | e2e | the M1-13 and M3-09 demo scripts replayed against the RC | both complete without manual intervention beyond the scripted approvals |
| E2E-M10-08-02 | e2e | clean-machine install of the third-party plugin from the registry | plugin loads, contract smoke green, provider row appears; no core code change required |
| AT-M10-08-02 | ci | audit-record linter (`tools/scripts/check-audit.ts`) | fails if any row lacks a verdict, evidence, build hash or date; fails on `⏸` against a compliance line (A4) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-08-01 | Every DoD row is evidenced | 1. Open `1.0-audit.md`. 2. Follow all 14 evidence links. | Every link resolves to an archived artifact or permalink naming the RC build hash; no row is empty or aggregated (A1, A2) | ⬜ |
| TC-M10-08-02 | **Third-party plugin, unaided** | 1. Hand the external author only the published docs URL. 2. Do not answer questions verbally; write every answer into the docs. 3. Install their plugin on a machine that has never seen the repo. | Their plugin installs from the registry (or GitHub with `--trust local`), passes the contract smoke, appears on Fleet, and required **zero** core PRs; transcript archived (A5) | ⬜ |
| TC-M10-08-03 | SLOs on real hardware | 1. Run the 20-drift SLO harness on the dev machine with real CLIs. 2. Read `dod-05-slo.json`. | p95 detect < 60 s, p95 remediate < 10 s, n = 20, outliers explained in the notes | ⬜ |
| TC-M10-08-04 | Durable captured prompts with explicit recovery outcomes | 1. Open prompts on three providers. 2. `kill -9` the daemon. 3. Restart and compare. | Persisted prompts keep payloads and identity; each receives a verified answerable, expired, cancelled or uncertain outcome; only revalidated live requests accept answers | ⬜ |
| TC-M10-08-05 | **Negative: compliance line cannot be deferred** | 1. Set DoD-14 to `⏸` in the audit record. 2. Run `check-audit.ts`. | Linter fails naming rule A4; the release gate stays closed | ⬜ |
| TC-M10-08-06 | **Negative: stale evidence rejected** | 1. Point a DoD row at a green run from a previous build. 2. Run `check-audit.ts`. | Fails because the build hash does not match the RC; forces a re-run (A1) | ⬜ |
| TC-M10-08-07 | Supply-chain verification by a third party | 1. On another machine, verify signatures, provenance and the SBOM using only `docs/release-process.md`. | All verify with public tooling; Scorecard ≥ 7 and Best Practices *passing* pages reachable and truthful | ⬜ |
| TC-M10-08-08 | Goal metrics honest | 1. Read `evidence/goals/G1..G7.md`. 2. Re-run each query yourself. | Each number reproduces from the stated query over the stated window; targets that are missed are stated as missed, not rounded | ⬜ |
| TC-M10-08-09 | RTL and AR completeness | 1. Walk the whole UI and the key docs pages in Arabic. | No LTR leakage, no clipped text, no untranslated primary navigation; screenshots archived | ⬜ |
| TC-M10-08-10 | Launch checklist executed | 1. Walk the checklist item by item. 2. Record go/no-go. | Every item done or explicitly waived with a reason; the decision carries a date and a name | ⬜ |
| TC-M10-08-11 | Monitoring plan is live | 1. Day 1 after launch: run the daily items. 2. Trigger a synthetic signal (e.g. a canary failure). | Each signal has an owner, a cadence and a threshold; the synthetic signal produces the documented action within its window | ⬜ |
| TC-M10-08-12 | **Negative: a gap becomes a step** | 1. Mark one row `❌` deliberately. 2. Follow the gap procedure. | A new step exists in `ROADMAP.md` and `PROGRESS.md` with an id, effort and owner; 1.0 promotion is blocked until it is closed or converted to `⏸` with a consequence | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `1.0-audit.md` exists with all 14 DoD rows, each carrying a verdict, evidence, the RC build hash and a date; `check-audit.ts` passes (TC-01, AT-02).
- [ ] The full gate matrix (§4.4) was re-run on the RC build and archived; no suite was accepted from an older build (TC-06).
- [ ] Contract tests pass for the four required providers (Antigravity only when its gate is resolved), including approval round-trips and quota parsing (CT-M10-08-01).
- [ ] SLOs measured on real hardware meet < 60 s detect and < 10 s safe remediation at p95, and prompts survive five `kill -9` runs with zero loss (TC-03, TC-04).
- [ ] Supply chain verified independently: signed artifacts, npm provenance, SBOM, Scorecard ≥ 7, OpenSSF Best Practices *passing* (TC-07).
- [ ] DoD-11 proven by an external author with no core PR, transcript archived (TC-02).
- [ ] No compliance line (C1–C13 / DoD-14) is anything other than `✅` (TC-05).
- [ ] Every `❌` became a `ROADMAP.md` step and every `⏸` carries a written consequence and a sign-off (TC-12).
- [ ] `RISKS.md` reviewed with every row statused, `PROGRESS.md` updated, the go/no-go decision recorded, and the 30-day monitoring plan live with owners, cadences and thresholds while collecting nothing from users by default (TC-10, TC-11).
- [ ] All TC-M10-08-01 … 12 pass and are recorded; no new lint / dependency-cruiser violations.

## 8. Risks / open questions
- **Auditing your own work.** A solo maintainer signing off on their own release is structurally weak. Mitigations: evidence rather than assertion, the external DoD-11 author as one genuinely independent check, and a written invitation to a second reviewer for the compliance rows. State the limitation in the audit record rather than hiding it.
- **DoD-11 depends on a volunteer.** If no external author materialises, 1.0 does not meet its own definition. Options, to be decided *before* the RC: delay the tag, or ship 1.0 with DoD-11 as `⏸` and a consequence stating that G7 is unproven — which materially weakens the release. Recruit early (M10-03) and treat it as a scheduling risk, not a discovery.
- **Metrics windows.** G2/G3 need ≥ 30 days of real usage on real work; if the dev machine was mostly running demos, the numbers are not evidence. Start at M8 exit once instrumentation is ready; record actual dates and restart any materially changed metric window.
- Re-running everything on real CLIs costs real quota and real time, and vendor CLIs may update mid-audit — which is itself a test of M6. Pin CLI versions for the audit window where possible and record any mid-audit upgrade as a note.
- A `⚠️` verdict is a slope: three or four caveats can hollow out a line without any single one looking bad. Cap it — more than three `⚠️` rows should trigger a go/no-go conversation, not a summary.
- Post-launch, the absence of telemetry means slow, noisy signal. Expect the first serious problem to arrive as a GitHub issue days after it started; the canary lane and the opt-in drift aggregates are the only fast channels, so keep both healthy.
- Release-notes honesty: the "What 1.0 means" page must list the `⚠️`/`⏸` lines. Publishing a clean claim over a caveated audit would be the first real breach of the project's own standards.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
