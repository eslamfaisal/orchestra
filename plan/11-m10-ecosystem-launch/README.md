# M10 — Ecosystem & 1.0

| | |
|---|---|
| Steps | 8 (M10-01 … M10-08) |
| Effort | 20 working days (sum of step estimates; optional work included) |
| Status | ⬜ |
| Entry | M6 complete (Doctor, drift, manifest registry, ladder 1–2, Health) and M9 complete (RBAC, audit, Postgres/Helm); M7-02 signed/notarized app shipping; M8-04 skills artifact format live |
| Exit | a third party ships a provider plugin without a core PR; the Repair Agent closes an injected drift with a passing contract suite; docs site live in EN + AR; 1.0 tagged with signed artifacts, provenance, SBOM, Scorecard ≥ 7 and every 1.0 DoD line evidenced |

## Goal
M10 turns Orchestra from "a program you run" into "a platform other people can extend, and that keeps itself alive". Three things happen. First, the self-maintenance story finishes: ladder step 3 (the Repair Agent, M10-01) proposes real patches under guardrails, and ladder step 4 (the opt-in anonymised community drift loop, M10-02) lets one user's detected drift mark a manifest stale for everyone. Second, the extension surface opens: a signed registry (M10-03) distributes provider plugins, skill packs, playbooks, policy packs and model-catalog data with semver + engine compatibility + trust levels, installable from the registry or a GitHub repo; two new adapters built entirely on the public SDK (Kimi, M10-04; OpenCode for any OpenAI-compatible backend, M10-05) prove the contract is complete; a Starlight docs site (M10-06) publishes the ADRs, the Plugin Author Guide and the Skill/Playbook Author Guide in EN and AR. Third, the project becomes a project: license and name decided, DCO, Contributor Covenant, an RFC process, a security policy with an SLA, semantic-release with signed tags, Homebrew cask and npm provenance (M10-07), and a line-by-line 1.0 Definition of Done audit with evidence (M10-08) before the tag is pushed.

## Why this milestone now
- **D6** says the platform maintains itself. M6 delivered rungs 1–2 of the remediation ladder; rungs 3 and 4 are the ones that survive a vendor release the maintainers have not seen yet. They can only be built once a manifest registry, a drift classifier and a review pipeline exist (M6-02, M6-03, M3-04).
- **D5 / G7** are unproven until someone outside the repo ships an adapter. The SDK has carried three first-party adapters (M1-05..07) that were written next to it; Kimi and OpenCode are the first written *against* it, and the registry + Plugin Author Guide are what make a fourth one possible without a core PR.
- **D10 / source plan §21**: license, name clearance, governance and release engineering are prerequisites for a public 1.0, not follow-ups. ADR-001 and ADR-002 have been open since M0 and block the first external PR.
- Everything else already shipped. M9 closed the enterprise gap; the remaining 1.0 DoD lines are exactly what M10 contains, so M10-08 is an audit rather than a build.

## Entry criteria
- [ ] M6 ✅ — `orch doctor`, drift classifier, manifest registry client (ADR-006 accepted), remediation ladder 1–2 meeting SLOs, Health screen.
- [ ] M9 ✅ — RBAC, OIDC, hash-chained audit, approval gates, Postgres + S3 drivers, container + Helm.
- [ ] M7-02 ✅ — signed/notarized desktop build with a working updater (needed for the release pipeline in M10-07).
- [ ] M8-04 ✅ — skill artifact format + trust levels + `SkillsInstaller` per provider (needed for registry artifact kinds in M10-03).
- [ ] M3-04 / M3-06 ✅ — review rounds and `gh`-based PR publishing (consumed by M10-01).
- [ ] Legal: trademark clearance search commissioned for the shortlist (input to ADR-002, M10-07).
- [ ] A GitHub org, npm scope and domain are reserved (or the decision to rename is taken) before M10-06 publishes URLs.
- [ ] Kimi Code and an OpenCode-compatible backend installed and logged in on the dev machine for M10-04 / M10-05 fixture recording.

## Exit criteria — the 1.0 Definition of Done, itemised
Each line is a row in the M10-08 audit table and must carry evidence (test ID, TC ID, screenshot path, or URL).

- [ ] **DoD-1 Adapters.** Four adapters (claude, codex, agy, kimi) — plus opencode — pass the full seven-spec contract suite on pinned fixtures for their recorded CLI version, including an approval round-trip fixture and a rate-limit fixture that yields `resetAt` or `retryAfterMs`. Evidence: `CT-*` IDs per provider.
- [ ] **DoD-2 Worktrees + Review & Merge** run end to end on ≥ 2 providers on a real repository. Evidence: M3-09 acceptance record + PR URL.
- [ ] **DoD-3 Cross-vendor review enforced** in e2e: a mission task's reviewer provider ≠ author provider, or the degrade path is flagged and audited. Evidence: M3-04 e2e ID.
- [ ] **DoD-4 Interaction Bridge** answers permission / question / planApproval prompts from web **and** PWA on every shipped provider through that provider's declared `answerTransport`. Evidence: per-provider TC IDs + M7-03 push TC.
- [ ] **DoD-5 Doctor + ladder 1–2 live** with SLOs met: time-to-detect < 60 s, safe remediation < 10 s, measured on injected drift. Evidence: M6-07 SLO panel screenshot + M6-04 timing TC.
- [ ] **DoD-6 Desktop app** signed, notarized, updater verified before delete, staged rollout, OS-floor check, memory/fps budgets met. Evidence: M7-02 TCs.
- [ ] **DoD-7 Restore with durable captured prompts with explicit recovery outcomes** across `kill -9` of the daemon mid-prompt. Evidence: M5-05 TC.
- [ ] **DoD-8 Forecasting on all providers**, every number labelled *official* or *estimate* with confidence. Evidence: M4-07 screenshot per provider.
- [ ] **DoD-9 Supply chain**: OpenSSF Best Practices badge *passing*, Scorecard ≥ 7 in CI, npm provenance on every published package, Sigstore-signed release artifacts, SLSA provenance, CycloneDX SBOM attached to the release, `SECURITY.md` with a report channel and SLA. Evidence: badge URL, Scorecard job output, release assets.
- [ ] **DoD-10 Docs** published with ADRs, Plugin Author Guide, Skill/Playbook Author Guide, deployment guide and a security/compliance page. Evidence: docs site URLs.
- [ ] **DoD-11 ≥ 1 third-party plugin** built from the guide by someone outside the maintainer set, installed from the registry (or a GitHub repo) into a clean machine, passing the contract harness, with **no core PR**. Evidence: plugin repo URL + install transcript.
- [ ] **DoD-12 EN + AR (RTL)** for the whole UI and for the docs site's getting-started, concepts and security pages. Evidence: RTL screenshots + `dir="rtl"` audit.
- [ ] **DoD-13 Trademark-cleared identity**: ADR-002 accepted, name cleared, GitHub org + npm scope + domains held, marks used consistently.
- [ ] **DoD-14 Compliance intact**: C1–C13 all still enforced by code at 1.0 — egress test green, ESLint compliance rules green, no vendor endpoint anywhere, registry policy forbids credential-handling plugins.
- [ ] All eight step files ✅ with their TC tables recorded; `PROGRESS.md` updated; no new lint / dependency-cruiser violations.

## Steps
| ID | File | Title | Effort | Depends |
|---|---|---|---|---|
| M10-01 | [step-01](step-01-repair-agent-ladder-3.md) | Repair Agent (ladder 3) | 4 d | M6-04, M3-04, M3-06, M1-12, M6-03 |
| M10-02 | [step-02](step-02-community-drift-loop.md) | Community drift loop | 2 d | M6-02, M6-03, M10-03, M8-01, M8-08 |
| M10-03 | [step-03](step-03-plugin-skill-playbook-registry.md) | Plugin / skill / playbook registry | 3 d | M6-03, M8-04, M8-01, M2-01, M2-02, M3-01 |
| M10-04 | [step-04](step-04-kimi-adapter.md) | Kimi adapter | 2.5 d | M2-03, M1-02, M1-04, M1-08, M1-11, M4-01, M8-04 |
| M10-05 | [step-05](step-05-opencode-adapter.md) | OpenCode adapter | 2.5 d | M2-03, M1-02, M1-04, M1-08, M1-11, M2-02, M4-01, M8-01 |
| M10-06 | [step-06](step-06-docs-site.md) | Docs site | 2.5 d | M10-03, M0-03, M8-04, M3-01, M9-06, M7-01, M7-02, M10-07 |
| M10-07 | [step-07](step-07-governance-and-releases.md) | Governance & releases | 2 d | M0-08, M7-02 |
| M10-08 | [step-08](step-08-1-0-definition-of-done-audit.md) | 1.0 Definition of Done audit | 1.5 d | M0-01, M0-02, M0-03, M0-04, M0-05, M0-06, M0-07, M0-08, M0-09, M1-01, M1-02, M1-03, M1-04, M1-05, M1-06, M1-08, M1-09, M1-10, M1-11, M1-12, M1-13, M2-01, M2-02, M2-03, M2-04, M2-05, M2-06, M2-07, M2-08, M2-09, M3-01, M3-02, M3-03, M3-04, M3-05, M3-06, M3-07, M3-08, M3-09, M4-01, M4-02, M4-03, M4-04, M4-05, M4-06, M4-07, M5-01, M5-02, M5-03, M5-04, M5-05, M5-06, M6-01, M6-02, M6-03, M6-04, M6-05, M6-06, M6-07, M7-01, M7-02, M7-03, M7-04, M7-05, M7-06, M8-01, M8-02, M8-03, M8-04, M8-05, M8-06, M8-07, M8-08, M9-01, M9-02, M9-03, M9-04, M9-05, M9-06, M9-07, M9-08, M9-09, M10-01, M10-02, M10-03, M10-04, M10-05, M10-06, M10-07 |

## What you can test after this milestone
- Inject a fixture drift for a provider, watch Doctor classify it, ladder 1–2 fail, then hand it to the Repair Agent and receive a patch whose contract suite is green — and open a PR from the Health screen.
- Toggle "share anonymised drift reports" on, reproduce the drift, and see the report payload in the preview dialog before it is sent — then see the registry index mark that manifest version stale.
- `orch plugin install orchestra-provider-<something>` from the registry and from a GitHub repo; watch signature and engine-compatibility verification refuse the bad ones and hot-load the good one without restarting the daemon.
- Start a real Kimi Code session and a real OpenCode session against an OpenAI-compatible backend, answer a permission prompt from the phone, and see both providers on the Fleet screen with parsed quota.
- Read the docs site in English, switch to Arabic, confirm RTL layout, and follow the Plugin Author Guide end to end to build a provider from `FakeProvider`.
- Cut a release: conventional commits → semantic-release → signed tag → GitHub Release with SBOM + provenance → `brew install --cask` on a clean machine.

## Demo script (end of M10)
1. `orch doctor` green. Inject drift: copy `packages/providers/codex/fixtures/<ver>/rpc/` and rename an event field so the contract suite fails, then run a session that triggers the parser.
2. Health shows a `RepairCase` within 60 s, kind `parser-drift`. Ladder 1 reloads the manifest (no change), ladder 2 finds no newer manifest → state `assisted`.
3. Click **Propose repair**. The repair session appears in Terminals, running in `~/.orchestra/repair/worktrees/<caseId>`; the repairer provider is not codex.
4. Proposal tab: files touched are under `packages/providers/codex/**`, guard verdict green, contract suite green. Click **Open PR** → `gh` returns a PR URL; the audit row names you as the approver.
5. Settings › Privacy: enable **Share anonymised drift reports**. Click **Preview report** → the dialog shows the exact JSON: provider, CLI version, drift kind, fixture hash, counts — no paths, no content, no ids. Confirm and send.
6. Registry status page (local fixture registry): `codex@<manifestVersion>` now carries `stale: true` with a report count; `orch registry status` shows the stale badge and the suggested action.
7. Third-party plugin: `orch plugin install github:<someone>/orchestra-provider-demo` → trust prompt (unsigned, `community`) → refuse; `orch plugin install orchestra-provider-demo` from the registry → signature + `engines.orchestra` verified → adapter hot-loaded → appears on Fleet with a **community** trust badge, contract harness run on its bundled fixtures.
8. `orch plugin install orchestra-provider-demo@2.0.0` where `engines.orchestra: ">=3"` → refused with `EngineIncompatible` naming both versions; nothing is loaded.
9. Fleet: start a **Kimi** session in the scratch worktree, ask it to write a file, answer the permission prompt from the PWA on the phone. Start an **OpenCode** session bound to a local OpenAI-compatible backend from `~/.orchestra/config.yaml`; both show parsed usage.
10. Docs: open the published site → Getting started → Concepts → ADR index (rendered from `docs/adr`) → Plugin Author Guide. Switch language to العربية; the page mirrors (RTL), navigation and code blocks stay correct.
11. Governance: open `CONTRIBUTING.md`, push a commit without a `Signed-off-by` line → DCO check fails; amend with `-s` → passes. Open the RFC template and the Contributor Covenant.
12. Release: merge a `feat:` commit to `main` → `release.yml` runs semantic-release → signed tag `v1.0.0`, GitHub Release with SBOM + provenance + notarized app, npm packages published with provenance, Homebrew cask bumped.
13. M10-08 audit table: every DoD line green with its evidence link; Scorecard job reports ≥ 7; OpenSSF Best Practices badge *passing*; launch checklist complete.

## Milestone risks
| Risk | Impact | Mitigation |
|---|---|---|
| R13 — Repair Agent modifies something it must not | compliance breach | path deny list + manifest semantic guard + CODEOWNERS + assisted-only (M10-01, C12) |
| R14 — trademark conflict forces a late rename | docs, org, npm scope, cask all churn | ADR-002 resolved in M10-07 **before** M10-06 publishes URLs; brand kept out of package internals |
| R9 — registry becomes a supply-chain hole | arbitrary code loaded into the daemon | pinned keys (no TOFU), signed index with per-artifact sha256, `engines.orchestra` gate, trust levels, no `postinstall`, documented no-sandbox decision in M10-03 |
| Privacy backlash on the drift loop | user trust | opt-in only, default off, preview-before-send, schema with no paths/content/ids, documented on the security page, single revocable toggle (M10-02) |
| R1 — Kimi / OpenCode surfaces differ from expectation | adapters slip | every unverified vendor fact carries "(verify against … docs at step start)"; fixtures are the source of truth afterwards; both adapters ship opt-in behind `features.providers.*` |
| R16 — solo bandwidth at the end of a long plan | 1.0 slips | M10-07 has no dependencies and can run any time; M10-04/05/06 are independent lanes; M10-08 is audit-only |
| DoD-11 depends on an external person | cannot be forced | recruit the third-party plugin author during M10-03, give them the guide draft, treat their feedback as M10-06 input |

## Parallelization
M10-07 depends on nothing and should start first — ADR-001 and ADR-002 gate names and URLs used everywhere else. M10-03 is the spine: M10-02's upload endpoint and M10-06's guides both consume it, so build it early in the milestone. M10-04 and M10-05 depend only on M2-03 and can run fully in parallel with M10-01/02/03 (they touch only `packages/providers/kimi|opencode`). M10-06 needs M10-03's manifest/plugin formats frozen, but its getting-started, concepts, ADR and deployment sections can be written in parallel from day one. M10-08 is last by construction and is audit + launch only — if it finds a gap, that gap becomes a new step in `ROADMAP.md`, never a silent expansion of M10-08.

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
