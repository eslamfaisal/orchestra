# Step M10-07 — Governance & releases

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M0-08, M7-02 |
| Estimated effort | 2 days |
| Packages touched | repo root (`LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `CODEOWNERS`), `.github/**`, `docs/adr`, `tools/release`, every publishable `package.json` |
| Risk | High (a wrong licence or an uncleared name is expensive to undo after 1.0) |
| Owner | |

## 1. Goal
Orchestra becomes a project other people can safely contribute to and consume. Two long-open decisions are closed: **ADR-001** fixes the core licence (SDK/protocol/plugins stay Apache-2.0 regardless), and **ADR-002** fixes the product name after a formal trademark clearance, with the GitHub organisation, npm scope and domains secured under that name. The contribution surface is complete: `CONTRIBUTING.md` with DCO (not CLA) enforced by a DCO check on every PR, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) with a named enforcement contact, `GOVERNANCE.md` describing BDFL-now with objective triggers for moving to a steering committee, and an RFC process with a template and a public queue. The security surface is complete: `SECURITY.md` with supported versions, a private advisory channel, a response SLA and the explicit non-features list. The release pipeline is real: conventional commits drive `semantic-release` from `main`, tags are signed, GitHub Releases carry the notarized desktop bundle, a CycloneDX SBOM and SLSA provenance, npm packages publish with provenance from OIDC, a Homebrew tap ships a cask, and the OpenSSF Best Practices badge reaches *passing* with Scorecard ≥ 7 enforced in CI rather than observed.

## 2. Why
- **D10** — "Apache-2.0 for SDK/protocol/plugins; core licence decided by ADR-001 **before first external PR**. DCO, not CLA." That deadline has been deferred since M0-01 and expires the moment M10-03/M10-06 invite outside contributors.
- **G7** — "global OSS project with enterprise-grade governance" (source plan §2.7, §21). A registry and an author guide without a licence, a code of conduct and a security policy are an invitation with no terms.
- **R14** — a late rename costs the docs site, the GitHub org, the npm scope, the Homebrew cask, every artifact name and every screenshot. ADR-002 must land before M10-06 deploys to production and before any package is published.
- **R9 / `07-compliance-rules.md` supply-chain section** — provenance, signed artifacts, SBOM, Scorecard and pinned dependencies are security controls against the 2026 npm worms that specifically target agent config directories. M0-08 built the scaffolding (`release.yml` dry-run, Scorecard informational); this step makes them enforcing.
- **1.0 Definition of Done** — three lines depend entirely on this step: "OpenSSF Best Practices *passing*, Scorecard ≥ 7, provenance + signed artifacts, SECURITY.md", "trademark-cleared identity", and the release mechanics behind "Tauri signed/notarized, safe updater".
- **C4** — the published `SECURITY.md` non-features list ("no token proxies, no account switchers, no quota tricks, no private usage readers") is what makes the compliance stance legible to users, vendors and procurement.

## 3. Scope
### In scope
- **ADR-001** (core licence) written, decided, applied: `LICENSE`, per-package `license` fields, SPDX headers policy, a `NOTICE` if required, and the licence matrix documented.
- **ADR-002** (name & trademark): clearance result, chosen mark, GitHub org, npm scope, `.dev`/`.com` domains, a rename checklist even if the answer is "keep the name", and the rule that package internals keep neutral ids (`orch`, `orchestrad`).
- `CONTRIBUTING.md` (DCO sign-off, step-file workflow from `plan/README.md`, conventional commits, PR checklist, how to run the test suites), DCO check in CI, PR template, issue templates, `good-first-issue` labelling policy.
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) + enforcement contact + escalation path.
- `GOVERNANCE.md`: BDFL model, decision scope, objective triggers for a steering committee, maintainer onboarding/offboarding, public roadmap pointer.
- RFC process: `rfcs/` directory, `0000-template.md`, states, review window, who decides, relationship to ADRs.
- `SECURITY.md` final: supported versions, private advisory reporting, triage + fix SLA, disclosure policy, non-features, and the plugin trust model pointer (ADR-013).
- Release pipeline: semantic-release monorepo config, signed tags, GitHub Releases with assets (desktop bundle, SBOM, provenance, checksums), npm publish with provenance via OIDC, Homebrew tap repository + cask formula + auto-bump, release checklist and rollback/yank procedure.
- OpenSSF Best Practices badge application to *passing*; Scorecard job flipped from informational to blocking at ≥ 7.
### Out of scope (deferred to …)
- Trademark **registration** filings (a legal process with its own timeline) — clearance + availability is what gates 1.0; registration continues after launch.
- Foundation donation / CLA-based relicensing paths — explicitly not pursued (DCO chosen, D10).
- Community infrastructure (Discussions, Discord, moderation rota) — set up at launch in M10-08's checklist; this step only defines the code of conduct that governs them.
- Paid support, hosted offering, pricing — out of scope for 1.0; ADR-001 records the licence *reason* without committing to a business model.
- Signing the manifest/artifact registry keys — owned by M6-03 / M10-03; this step covers *release* artifact signing and records the key-custody procedure.
- Linux/Windows packaging beyond what M7 shipped — post-1.0; the cask covers macOS.

## 4. Design
### 4.1 ADR-001 — core licence (decided in this step)
| Option | Effect on adoption | Effect on a future hosted offering | Effect on the plugin ecosystem | Verdict |
|---|---|---|---|---|
| Apache-2.0 everywhere | maximal; enterprise procurement is routine; no copyleft questions for embedders | none — anyone may host it | plugins and forks unconstrained | **default if no stronger reason emerges** |
| AGPL-3.0 core + Apache-2.0 SDK/protocol/plugins | some enterprises refuse AGPL outright; needs a clear boundary statement | protects against a closed hosted clone | plugins stay permissive; the boundary must be documented precisely | viable, but costs adoption at exactly the moment adoption matters most |
| BSL / source-available | fails "open source"; contradicts the product statement | strongest protection | poisons the ecosystem story (G7) | rejected |
Decision procedure: choose one, write `docs/adr/ADR-001-core-license.md` with the boundary statement (which directories are which licence), apply it, and record the consequence for the daemon/web/desktop/CLI split. Whatever is chosen, `packages/sdk`, `packages/core` type exports consumed by plugins, the manifest/artifact schemas and `examples/` are **Apache-2.0** (D10) so third-party plugins are unencumbered.

### 4.2 ADR-002 — name & identity (decided in this step)
- Inputs: the clearance search commissioned at milestone entry; "Orchestra" is known to collide (ORCHESTRA AI / Orchestral marks in adjacent classes) **(verify against the clearance report at step start)**.
- Output: chosen mark, classes checked, jurisdictions checked, risk rating, and the decision to keep or rename.
- Assets to secure **before** anything is published: GitHub organisation, npm scope (plus the unscoped `orchestra-provider-*` prefix reservation policy for third parties), `.dev` and `.com` domains, and the docs `site` value (M10-06).
- Internal ids stay neutral and configurable regardless of the outcome: CLI `orch`, daemon `orchestrad`, config dir `~/.orchestra` (renaming this later is a migration, so it is explicitly in the rename checklist), deep-link scheme, tmux session name.
- Rename checklist (executed only if the mark changes): repo + org, package names, `~/.orchestra` migration with a compatibility symlink, deep-link scheme with a fallback handler, docs `site`, cask token, screenshots, this plan's references.

### 4.3 Governance artifacts
```
CONTRIBUTING.md     how to build/test; step-file workflow; conventional commits (scope = package);
                    DCO: every commit signed off with `git commit -s`; PR title starts with the step id;
                    PR checklist (tests · fixtures · docs/ADR · PROGRESS.md row); review expectations
CODE_OF_CONDUCT.md  Contributor Covenant 2.1 verbatim + enforcement contact + appeal path
GOVERNANCE.md       BDFL today. Triggers to move to a steering committee (ALL must hold for 3 months):
                      ≥ 3 sustained maintainers outside the founder, ≥ 25 merged external PRs,
                      ≥ 2 organisations depending on it in production.
                    Then: 5 seats, 2-year terms, lazy consensus, RFC vote on ties, public minutes.
                    Maintainer onboarding (2 sponsors + 10 merged PRs) and emeritus/offboarding rules.
rfcs/0000-template.md   Summary · Motivation · Design · Alternatives · Compliance impact (C1–C13) ·
                        Security & privacy impact · Migration · Unresolved questions
                    States: draft → review (14-day window) → accepted | rejected | withdrawn.
                    An RFC that changes an architectural decision produces an ADR; an RFC that changes a
                    compliance rule requires CODEOWNERS approval and cannot be lazy-consensus.
SECURITY.md         supported versions (latest minor + previous minor); private advisory via GitHub
                    Security Advisories; PGP/contact fallback; SLA: acknowledge ≤ 48 h, triage ≤ 5 d,
                    fix or mitigation for critical ≤ 14 d, coordinated disclosure ≤ 90 d;
                    scope (what is in/out); safe-harbour statement; non-features list (C4);
                    plugin privilege model pointer (ADR-013); how to report a malicious registry artifact
```

### 4.4 Release pipeline
```
main ──(conventional commits)──▶ semantic-release
  analyze commits → next version → CHANGELOG → git tag (SIGNED) → GitHub Release
  publish matrix:
    @orchestra/sdk, @orchestra/core, @orchestra/catalog, @orchestra/ui   → npm, --provenance (OIDC)
    orchestra-provider-{claude,codex,agy,kimi,opencode}                  → npm, --provenance
    apps/cli (orch)                                                      → npm, --provenance
    apps/desktop                                                         → notarized .dmg/.app (M7-02) + updater manifest
  attach to the Release: SBOM (CycloneDX, per workspace + aggregate), SLSA provenance attestation,
                         SHA256SUMS, the signed updater manifest, and the signed artifact index diff (M10-03)
  then: bump the Homebrew cask in the tap repo via a bot PR; verify `brew install --cask` on a clean runner
```
- **Signing**: tags signed with the maintainer key (SSH or GPG, recorded in `GOVERNANCE.md`); release artifacts signed with Sigstore/cosign per ADR-006's split (hot artifacts = minisign/ed25519, releases = Sigstore). Key custody, rotation and the "who can cut a release" rule are documented in `docs/release-process.md`.
- **Versioning**: the monorepo releases **one version for everything** (fixed versioning) so `engines.orchestra` (M10-03) has a single, comparable meaning. Independent versioning is rejected for exactly that reason; record it in the release doc.
- **Permissions**: `release.yml` is the only workflow with write permissions and `id-token: write` (OIDC for npm provenance and Sigstore). No long-lived npm token exists. `ci.yml`/`e2e.yml`/`docs.yml` keep `permissions: read-all`.
- **Pre-release channel**: `next` on `main` (prerelease tags) so the desktop updater's staged rollout (M7-02) and the registry's `allowPrerelease` flag have something to consume.
- **Rollback / yank**: documented procedure — deprecate the npm version (never unpublish except for a secret leak), mark the artifact-index entries `yanked` (M10-03), publish a patched updater manifest, and open a security advisory if user-impacting.
- **OpenSSF Best Practices**: complete the questionnaire to *passing* (project description, contribution guide, bug reporting, vulnerability reporting with an SLA, licence in a standard location, documented build + test, static analysis, signed releases, dependency monitoring, no known vulnerabilities). Badge markdown in `README.md`; the remaining *silver* criteria listed in the ADR as post-1.0 work.
- **Scorecard**: flip `scorecard.yml` from informational to blocking with a minimum aggregate of 7.0; the known-weak checks (`Branch-Protection`, `Pinned-Dependencies`, `Token-Permissions`, `Signed-Releases`) each get a concrete remediation task below.

### 4.5 API / UI surface
No daemon API. Three user-visible touches: `orch --version` prints the release version, commit and whether the build is a prerelease; the desktop About panel shows the same plus the licence and a link to `SECURITY.md`; the web footer links licence, code of conduct and security policy (EN + AR).

### 4.6 Flow / sequence — first signed release
```
1 ADR-001 + ADR-002 accepted; LICENSE and package metadata updated; org/scope/domains secured
2 CONTRIBUTING / CODE_OF_CONDUCT / GOVERNANCE / SECURITY / rfcs/ merged; DCO check enabled and required
3 branch protection updated: required checks = typecheck, lint, depcruise, test, e2e, egress, audit,
  scorecard, dco, docs; signed commits required on main; no force-push; merge queue on
4 release.yml: dry-run on a release branch → verify every asset is produced and verifiable offline
5 merge a `feat:` commit → semantic-release cuts v1.0.0-next.1 → verify updater, npm provenance, SBOM
6 promote to v1.0.0 (M10-08 gates this) → cask bump PR → `brew install --cask` verified on a clean runner
7 post-release verification: cosign verify, npm provenance inspect, SBOM parse, Scorecard re-run ≥ 7
```

## 5. Tasks
- [ ] Read the clearance report; write `docs/adr/ADR-002-name-and-identity.md` with the decision, the classes/jurisdictions checked and the rename checklist; update `plan/DECISIONS.md`.
- [ ] Secure the GitHub organisation, npm scope, `orchestra-provider-*` prefix policy and the domains; record who holds them and the recovery contacts in `GOVERNANCE.md`.
- [ ] Write `docs/adr/ADR-001-core-license.md` from §4.1, decide, and apply: root `LICENSE`, per-package `license` fields, SPDX header policy, `NOTICE` if required, licence matrix in the docs security page.
- [ ] `CONTRIBUTING.md` final (DCO instructions, build/test, step workflow, conventional commits, PR checklist).
- [ ] Enable the DCO check as a required status; add PR and issue templates; document the `good-first-issue` policy.
- [ ] `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) with a real enforcement contact and appeal path.
- [ ] `GOVERNANCE.md` with the BDFL→steering triggers, maintainer on/offboarding, key custody and release authority.
- [ ] `rfcs/` with `0000-template.md`, README describing states and the 14-day review window, and the ADR relationship.
- [ ] `SECURITY.md` final: supported versions, private advisory channel, SLA numbers, scope, safe harbour, non-features (C4), malicious-artifact reporting, ADR-013 pointer.
- [ ] `tools/release/`: semantic-release config (fixed versioning across the workspace), changelog generator, asset assembly script (SBOM + provenance + checksums + updater manifest).
- [ ] `release.yml`: OIDC `id-token: write`, npm publish `--provenance` matrix, Sigstore signing of release artifacts, signed tag creation, GitHub Release with all assets, prerelease `next` channel.
- [ ] Homebrew tap repository + cask formula + auto-bump bot PR + a clean-runner `brew install --cask` verification job.
- [ ] CycloneDX SBOM generation per workspace and aggregate; attach to the Release; verify it parses in a third-party tool.
- [ ] Flip `scorecard.yml` to blocking at ≥ 7; remediate each failing check (branch protection, pinned dependencies/actions by SHA, least-privilege tokens, signed releases, dependency update tooling).
- [ ] Apply for the OpenSSF Best Practices badge; reach *passing*; add the badge to `README.md`; list the silver gaps in the ADR.
- [ ] `docs/release-process.md`: who can release, key custody and rotation, the checklist, the rollback/yank procedure, and the post-release verification commands.
- [ ] Update branch protection to the final required-check list; require signed commits on `main`; enable the merge queue.
- [ ] Dry-run the whole pipeline on a release branch, then cut `v1.0.0-next.1`; run the TC table against it.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M10-07-01 | unit | licence metadata check script over every workspace `package.json` | every publishable package has the correct `license`, `repository`, `engines`, `files`, and `publishConfig.provenance` |
| UT-M10-07-02 | unit | release asset assembler over a fixture build | produces SBOM, checksums, provenance placeholder and updater manifest with stable names; missing input fails loudly |
| AT-M10-07-01 | ci | PR without `Signed-off-by` | DCO check fails and blocks merge; amending with `-s` passes |
| AT-M10-07-02 | ci | commit message violating conventional commits | commitlint fails; semantic-release would not version it |
| AT-M10-07-03 | ci | `release.yml` dry-run on a release branch | version computed, changelog rendered, all assets produced, **nothing published** |
| IT-M10-07-01 | integration | `cosign verify` + `npm view <pkg> --json` provenance inspection on the `next` release | signatures verify; provenance names this repository and workflow |
| IT-M10-07-02 | integration | SBOM parsed by an external CycloneDX tool; `pnpm audit --prod` at release time | SBOM valid and complete; zero known-critical advisories, or an accepted exception recorded |
| IT-M10-07-03 | integration | Scorecard run on the release commit | aggregate ≥ 7.0; the job fails the build below that |
| E2E-M10-07-01 | e2e | clean macOS runner: `brew install --cask <token>` → launch → `orch --version` | app installs without Gatekeeper dialogs, daemon starts, version/commit match the Release |
| E2E-M10-07-02 | e2e | updater path from `v1.0.0-next.1` to `next.2` | staged rollout honoured, signature verified before replacing anything, rollback path intact (M7-02 harness) |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-07-01 | Licence applied consistently | 1. Read ADR-001. 2. `grep -r "\"license\"" --include=package.json`. 3. Check `LICENSE`, `NOTICE`, docs licence matrix. | Every package matches the ADR's matrix; SDK/schemas/examples are Apache-2.0; the boundary statement is unambiguous | ⬜ |
| TC-M10-07-02 | Identity secured | 1. Open ADR-002. 2. Verify the GitHub org, npm scope and domains resolve and are held by us. | Decision recorded with classes/jurisdictions; all assets held; internal ids (`orch`, `orchestrad`, `~/.orchestra`) unchanged or migration-listed | ⬜ |
| TC-M10-07-03 | **Negative: DCO enforced** | 1. Open a PR from a second account with an unsigned commit. 2. Amend with `-s`. | First attempt blocked with instructions; after amending, the check passes; no CLA is ever requested | ⬜ |
| TC-M10-07-04 | Contribution path readable | 1. As an outsider, read CONTRIBUTING, CODE_OF_CONDUCT, GOVERNANCE, the RFC README. 2. Open a draft RFC. | Build/test commands work as written; the RFC template renders; states and the 14-day window are clear; enforcement contact is real | ⬜ |
| TC-M10-07-05 | Security policy exercised | 1. File a test private advisory. 2. Time the acknowledgement. | Private advisory channel works; SLA numbers in `SECURITY.md` are ones you can actually meet; non-features list present and accurate | ⬜ |
| TC-M10-07-06 | First signed prerelease | 1. Merge a `feat:` commit. 2. Watch `release.yml`. 3. Inspect the Release page. | `v1.0.0-next.1` tagged and **signed**; Release carries the notarized bundle, SBOM, provenance, SHA256SUMS, updater manifest; npm packages show provenance | ⬜ |
| TC-M10-07-07 | Offline verification by a third party | 1. On a different machine, download the assets. 2. Verify checksums, cosign signature, npm provenance, and parse the SBOM. | All verify without any project-provided tooling beyond public commands documented in `docs/release-process.md` | ⬜ |
| TC-M10-07-08 | Homebrew install on a clean machine | 1. `brew tap` + `brew install --cask`. 2. Launch; check the About panel. | Installs and launches with no Gatekeeper dialog; About shows version, commit, licence and a working security-policy link | ⬜ |
| TC-M10-07-09 | **Negative: release with a failing gate** | 1. Push a commit that drops Scorecard below 7 (e.g. unpin an action) on a release branch. | `release.yml` refuses to publish; the failure names the check; nothing is tagged or uploaded | ⬜ |
| TC-M10-07-10 | **Negative: yank / rollback** | 1. Simulate a bad release: deprecate the npm version, mark the artifact index entries yanked, publish a corrected updater manifest. | Documented procedure works end to end; clients stop resolving the yanked version (M10-03 resolver); an advisory is published; nothing is unpublished | ⬜ |
| TC-M10-07-11 | Badges honest | 1. Open the OpenSSF Best Practices entry and the Scorecard report. | Badge shows *passing* with every answer truthful and evidenced; Scorecard ≥ 7; README badges link to the live reports, not images we host | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] ADR-001 and ADR-002 accepted, dated, linked from `plan/DECISIONS.md` and from the docs ADR index; their open rows are closed.
- [ ] Licence applied consistently across every package; SDK, schemas and examples are Apache-2.0 (TC-01).
- [ ] GitHub org, npm scope and domains secured under the decided name before anything is published (TC-02).
- [ ] DCO is a required check that blocks unsigned commits with no CLA anywhere, and `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `rfcs/` and `SECURITY.md` are complete, accurate and reachable from the README and the docs site (TC-03, TC-04, TC-05).
- [ ] A signed prerelease is produced end to end by CI with SBOM, SLSA provenance, checksums, notarized bundle and npm provenance, and a third party can verify all of it offline (TC-06, TC-07).
- [ ] Homebrew cask installs and launches on a clean machine with no Gatekeeper dialog (TC-08).
- [ ] Scorecard is blocking at ≥ 7 and OpenSSF Best Practices is *passing*, with every questionnaire answer evidenced (TC-11, IT-03).
- [ ] The release cannot proceed when a gate fails, and the yank/rollback procedure is proven (TC-09, TC-10).
- [ ] `release.yml` is the only workflow with write/OIDC permissions; no long-lived publishing token exists in the repository.
- [ ] All TC-M10-07-01 … 11 pass and are recorded; no new lint / dependency-cruiser violations.

## 8. Risks / open questions
- **Licence choice is one-way in practice.** Relicensing later needs every contributor's agreement (DCO, not CLA, by design). Decide with the hosted-offering question explicitly answered in the ADR, even if the answer is "not planned".
- **Clearance may force a rename (R14).** Sequence matters: ADR-002 before the docs production deploy (M10-06), before any npm publish, and before the cask token exists. If the report is ambiguous, prefer a coined mark over a contested one; the plan already shortlists alternatives **(verify against the clearance report at step start)**.
- `~/.orchestra` is user data; a rename needs a migration with a compatibility path, not a rename in code. It is in the ADR-002 checklist for that reason.
- **SLA credibility.** A solo maintainer publishing "critical fix ≤ 14 days" must be able to meet it (R16). Numbers in `SECURITY.md` should be ones you would hit on your worst month, not your best.
- Key custody is a single point of failure: tag-signing key, Sigstore identity, npm OIDC configuration, notarization credentials and the registry signing keys (M6-03/M10-03) all live with one person at 1.0. `GOVERNANCE.md` must state the recovery plan honestly, and the steering-committee trigger should also be a custody-diversification trigger.
- npm provenance requires the publish to run in a supported CI with OIDC and the repository to be public at publish time; confirm the exact requirements and any registry-side constraints **(verify against npm provenance docs at step start)**.
- Homebrew tap vs. homebrew-cask submission: a personal tap is immediate and under our control; the main cask repository has its own acceptance criteria and review latency. Ship the tap for 1.0 and treat upstream submission as post-1.0.
- The Contributor Covenant enforcement contact should not be a single overloaded inbox; if no second person exists yet, say so in the document rather than implying a committee that does not exist.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
