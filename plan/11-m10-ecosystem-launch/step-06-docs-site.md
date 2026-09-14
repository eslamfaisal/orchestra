# Step M10-06 — Docs site

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M10-03 (artifact/plugin formats, `orch plugin check`, templates); uses M0-03 (`FakeProvider` + contract harness), M8-04 (skill format), M3-01 (playbook schema), M9-06 (container + Helm), M7-01/02 (desktop install), M10-07 (final name, license, URLs) |
| Estimated effort | 2.5 days |
| Packages touched | `docs/`, `packages/sdk` (doc-generation entry points), `packages/ui` (RTL tokens reused), `.github/workflows/docs.yml`, `examples/` |
| Risk | Medium (content volume; AR/RTL correctness; docs drifting from code) |
| Owner | |

## 1. Goal
A published Starlight (Astro) documentation site, built from `docs/` in the monorepo and deployed by CI on every merge to `main` and every tag, covering: getting started (install the daemon, run the desktop app, first session), concepts (the glossary made navigable — session, worktree, mission, task, prompt, window, manifest, drift, skill, playbook), the ADR index rendered directly from `docs/adr/*.md`, a **Plugin Author Guide** that walks an author from `FakeProvider` to a published `orchestra-provider-*` package that passes `orch plugin check`, a **Skill / Playbook Author Guide**, deployment guides for local / Tauri / container / Helm, and a security & compliance page that states the official-only rules, the trust model, the plugin privilege model (ADR-013) and the drift-report privacy contract (M10-02). Every page exists in **English and Arabic** with correct RTL rendering, and every page that describes a vendor surface carries a machine-generated "verified against `<cli> <version>`" banner sourced from the provider packages' `RECORDED.md`, so a reader always knows how fresh the claim is. Broken links, stale code samples and missing translations fail CI.

## 2. Why
- **G7** — extensibility is only real if someone outside the repository can follow a written path from nothing to a working provider plugin. The 1.0 Definition of Done requires "docs with ADRs + Plugin Author Guide" **and** "≥ 1 third-party plugin"; the second depends on the first.
- **D5** — the plugin contract is the product's public API; it needs an author-facing surface, not just TypeScript types.
- **D6 / G6** — the docs must be updatable independently of the app, and must not lie about vendor behaviour between releases. The "verified against version" banner is the documentation equivalent of a pinned fixture.
- **D10 / source plan §21** — "Docs: Starlight; ADRs; Plugin Author Guide (adapter + manifest + fixture harness); Skill/Playbook Author Guide; versioned per CLI version; EN + AR."
- **C1–C13** — the security & compliance page is where the official-only stance is stated publicly; procurement and contributors both read it. It is also where ADR-013 (plugins run in-process) and the M10-02 privacy contract must be visible rather than buried.
- **G1 / UX principles** — the product ships an AR + RTL UI; documentation that is English-only would contradict it and would make the AR audience second-class from day one.

## 3. Scope
### In scope
- Starlight site in `docs/` (Astro), design tokens aligned with `packages/ui`, dark theme, search, sidebar IA, versioned builds, EN + AR with `dir="rtl"`.
- Content: Getting started · Concepts · How-to guides (fleet, missions, review & merge, quota, health, replay, settings) · Reference (CLI, HTTP/WS API from OpenAPI, manifest schema, artifact manifest schema, events) · ADRs · Plugin Author Guide · Skill & Playbook Author Guide · Deployment · Security & compliance · Troubleshooting · Contributing/RFC pointers.
- Generated content pipelines: ADR index from `docs/adr/*.md`; CLI reference from `orch --help` JSON; API reference from the daemon's OpenAPI; manifest/artifact JSON-Schema tables from `packages/sdk`; the "verified against" banner from each provider's `RECORDED.md`; glossary from `plan/00-foundations/13-glossary.md`.
- Runnable-sample verification: every TypeScript sample in the author guides lives in `examples/` and is typechecked and executed in CI, not pasted into markdown.
- `docs.yml` workflow: build, link-check, translation-completeness check, sample tests, deploy (preview per PR, production on `main`/tag).
- AR translation of the full site with a glossary of technical terms kept in English (`tmux`, `git worktree`, `MCP`) and a documented translation policy.
### Out of scope (deferred to …)
- Marketing/landing site, blog, changelog site — out of scope for 1.0; the release notes live in GitHub Releases (M10-07).
- Languages beyond EN + AR — post-1.0; the i18n structure must not make a third language a rewrite.
- Hosted search infrastructure — Starlight's built-in (pagefind) search only.
- API playground / interactive console — post-1.0.
- Video content — post-1.0.
- Domain, DNS and the final product name — M10-07; this step uses a configurable `site` value so a rename is one config change (R14).

## 4. Design
### 4.1 Domain
None. This step produces content and build tooling; no daemon code changes except the doc-generation entry points exported from `packages/sdk` and a `--json` flag audit on `orch` commands.

### 4.2 Interfaces / contracts
```
docs/
  astro.config.mjs            starlight({ title, defaultLocale:'en', locales:{ en, ar:{ dir:'rtl' } }, versions })
  src/content/docs/
    en/
      index.mdx                       getting started: install, first session, first delegate
      concepts/{sessions,worktrees,missions,tasks,prompts,windows,manifests,drift,skills,playbooks}.md
      guides/{fleet,missions,review-merge,quota,health,replay,settings,cli}.md
      reference/{cli,api,events,manifest-schema,artifact-schema}.md          ← generated
      adr/index.md + adr/ADR-NNN-*.md                                        ← generated from docs/adr
      plugin-guide/{00-overview,01-scaffold,02-manifest,03-launcher,04-telemetry,05-prompts,
                    06-fixtures,07-contract-tests,08-publish,09-checklist}.md
      skill-guide/{skills,playbooks,policy-packs,evals}.md
      deployment/{local,desktop,container,helm,remote-access}.md
      security/{compliance,threat-model,plugins-and-trust,drift-reports,reporting}.md
      troubleshooting.md
    ar/  … same tree, same slugs, RTL …
  src/components/VerifiedAgainst.astro     renders the CLI-version banner
  src/data/verified.json                   generated from packages/providers/*/fixtures/*/RECORDED.md
  scripts/{gen-adr.ts,gen-cli.ts,gen-api.ts,gen-schemas.ts,gen-verified.ts,check-i18n.ts}
```
```ts
// docs/scripts/gen-verified.ts → src/data/verified.json
export interface VerifiedEntry {
  provider: ProviderId;
  cliVersion: string;          // from RECORDED.md front matter
  recordedAt: string;          // ISO date
  manifestVersion: string;     // from the provider's manifest.json
  fixturesPath: string;
}
// Usage in any page describing a vendor surface:
//   <VerifiedAgainst provider="claude" />
//   → "Verified against Claude Code 2.1.216 · fixtures recorded 2026-09-14 · manifest 1.3.0"
// A page tagged `provider: <id>` in its front matter WITHOUT the banner fails `check-i18n.ts`'s sibling
// check `check-provider-banners.ts`.

// docs/scripts/check-i18n.ts  — CI gate
// 1. every en/**/*.md(x) has an ar/ sibling with the same slug
// 2. no ar page is an untranslated copy (front-matter `translationStatus: machine|human|pending`; `pending` fails on main)
// 3. no hardcoded LTR-only CSS (`margin-left`, `padding-right`, `text-align: left`) in docs components — use logical properties
```

### 4.3 Data / schema changes
None in the daemon. Two repo-level conventions are introduced:
- `RECORDED.md` gains YAML front matter (`provider`, `cliVersion`, `recordedAt`, `scenario`, `redaction`) so `gen-verified.ts` can parse it. M1-05/06/07, M10-04 and M10-05 fixture sets are updated in this step (front matter only — no fixture content changes).
- Every ADR file gains front matter (`adr`, `title`, `status`, `date`, `supersedes?`) so the ADR index can be generated and sorted; `plan/adr/*` files are moved/copied to `docs/adr/` as the canonical home (`plan/DECISIONS.md` keeps the index table and links there).

### 4.4 Infrastructure
- **Build**: `pnpm --filter docs build` (Astro + Starlight, pagefind search). Node 22. Output is static; no server-side code, no analytics, no third-party trackers (a privacy claim on the security page would otherwise be false).
- **Versioning**: one built version per minor release plus `next` from `main`. The version picker is Starlight's; older versions are kept as immutable builds. Per-CLI-version accuracy is handled by the `VerifiedAgainst` banner rather than by branching docs per CLI.
- **Deploy** (`.github/workflows/docs.yml`): PR → build + checks + preview deployment; `main` → deploy to `/next`; tag `v*` → deploy to `/<major.minor>` and repoint `latest`. Deploy uses OIDC to the static host; no long-lived secrets. The workflow has `permissions: read-all` except the deploy job.
- **Checks in CI (all blocking)**: build; `check-i18n.ts`; `check-provider-banners.ts`; link check (internal + external, external allowed to warn on 429/timeout only); `examples/` typecheck + test run; spell check with a project dictionary; a size budget (any page > 300 KB of HTML fails).
- **Samples**: the Plugin Author Guide's code is imported from `examples/provider-plugin-template/` using Starlight's file-include, so a sample cannot drift from a compiling, contract-test-passing package. `orch plugin check examples/provider-plugin-template` runs in `docs.yml`.
- **RTL**: the site inherits `packages/ui`'s logical-property discipline; the AR locale sets `dir="rtl"`; code blocks, terminal transcripts, file trees and mermaid diagrams stay LTR inside an RTL page (explicit `dir="ltr"` wrappers), which is checked by a Playwright screenshot test on three representative pages.
- **Accessibility**: colour contrast AA, focus visible, headings hierarchical; an axe-core pass over five sampled pages in CI.

### 4.5 API / UI surface
No daemon API changes. Two product-side touches: the web UI's help links and the desktop app's Help menu point at `<docsUrl>/<locale>/<slug>` resolved from a single config value, and `orch --help` footers print the matching docs URL. Both read the same `docsBaseUrl` constant so a rename or domain change (R14, ADR-002) is one edit.

### 4.6 Flow / sequence — the Plugin Author Guide walkthrough (the spine of this step)
```
00 Overview        what a provider plugin is; what the daemon does for you; what you must not do (C1–C13)
01 Scaffold        copy examples/provider-plugin-template → package name orchestra-provider-<id>;
                   orchestra.plugin.json (engines.orchestra, declares.egressHosts: [], declares.binaries)
02 Manifest        fill CapabilityManifest field by field, each with "how to find this out from your CLI";
                   cliVersionRange, promptProtocol, headless flags, paths, updateSources
03 Launcher        typed argv builders; preLaunchFiles; the worktree-only rule; env allowlist
04 Telemetry       TelemetryParser + Zod per payload; unknown ⇒ ParseError, never a throw; sources()
05 Prompts         AgentPrompt kinds; answerTransport per kind; hook-response vs RPC vs send-keys-acked;
                   the deadline/fallback contract (D14)
06 Fixtures        record against your CLI: one payload per kind, a headless run, a 429, exits, keys.yaml;
                   redaction; RECORDED.md front matter
07 Contract tests  defineAdapterContract(adapter, fixtures/<ver>); what each of the seven specs proves;
                   how a failure maps to a drift signal (M6-02)
08 Publish         npm with provenance; engines/sdkRange; trust levels; getting into the signed index;
                   installing your own build with `orch plugin install --from github:…  --trust local`
09 Checklist       `orch plugin check` must be green; the compliance checklist (no vendor API calls, no
                   credential reads, no PTY regex, no egress declarations) before requesting review
```
Each page ends with a runnable command and its expected output, taken from `examples/`. The guide's acceptance is behavioural: a person who has never seen the codebase reaches a loading plugin (TC-06/TC-07 below, and DoD-11 in M10-08).

## 5. Tasks
- [ ] Scaffold the Starlight site in `docs/` with EN + AR locales, RTL for AR, theme tokens from `packages/ui`, pagefind search, version picker; wire `docsBaseUrl`.
- [ ] Define the sidebar IA and create every page stub in EN with front matter (`translationStatus: pending`), so gaps are visible from day one.
- [ ] Add YAML front matter to every `RECORDED.md` and every ADR; move `plan/adr/*` to `docs/adr/` and repoint `plan/DECISIONS.md`.
- [ ] `gen-adr.ts`, `gen-cli.ts` (`orch <cmd> --help --json`), `gen-api.ts` (OpenAPI → reference), `gen-schemas.ts` (SDK JSON-Schemas → tables), `gen-verified.ts` (+ `VerifiedAgainst.astro`).
- [ ] Write **Getting started** (daemon install, desktop app, first session on a scratch repo, first Quick Delegate) and verify it on a clean machine.
- [ ] Write **Concepts** from `13-glossary.md`, one page per term cluster, each linking to the guide that uses it.
- [ ] Write **Guides**: fleet, missions, review & merge, quota & budgets, health & drift, replay, settings layers, CLI.
- [ ] Write the **Plugin Author Guide** (10 pages per §4.6) with all code imported from `examples/provider-plugin-template/`.
- [ ] Write the **Skill / Playbook Author Guide**: skill frontmatter and trust levels (M8-04), evals (M8-05), playbook DAG schema and gates (M3-01), policy packs (M8-02), packaging as registry artifacts (M10-03).
- [ ] Write **Deployment**: local daemon (launchd, ports, `~/.orchestra` layout), desktop app + updater, container image, Helm chart (M9-06), remote access via Tailscale/Cloudflare Tunnel (M7-04) with the "bind 127.0.0.1" warning.
- [ ] Write **Security & compliance**: C1–C13 in plain language, the non-features list, the trust model and ADR-013, drift-report privacy contract (M10-02) with the exact field table, supply-chain posture (provenance, SBOM, Scorecard), vulnerability reporting + SLA (links `SECURITY.md`).
- [ ] Write **Troubleshooting**: tmux not found, CLI version outside range, hooks not arriving, prompts stuck, quota exhausted, plugin refused, docs of every user-visible error code.
- [ ] `check-i18n.ts` + `check-provider-banners.ts` + link check + spell check + size budget + axe-core pass.
- [ ] Translate the full site to Arabic (human pass; `translationStatus: human`), with a term glossary and the policy on untranslated technical nouns.
- [ ] Playwright RTL screenshot tests on three pages (getting started, plugin guide page with code, deployment with a file tree).
- [ ] `docs.yml`: build, checks, `orch plugin check examples/provider-plugin-template`, PR preview, `main` → `/next`, tag → versioned deploy + `latest`.
- [ ] Point the web UI help links and `orch --help` footers at the site; add "Edit this page" links to the repo.
- [ ] Recruit and support the third-party plugin author (DoD-11) using only the published guide; log every question as a docs defect.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M10-06-01 | unit | `gen-verified.ts` over `RECORDED.md` fixtures incl. one with missing front matter | entries parsed; missing front matter fails the build with the file path |
| UT-M10-06-02 | unit | `check-i18n.ts` on a tree with a missing AR sibling and a `pending` AR page | both reported with paths; exit 2 |
| UT-M10-06-03 | unit | `check-provider-banners.ts` on a page with `provider:` front matter and no `<VerifiedAgainst>` | reported; exit 2 |
| UT-M10-06-04 | unit | `gen-adr.ts` over ADR files with `supersedes` and mixed statuses | index sorted by number, statuses rendered, superseded ADRs linked both ways |
| IT-M10-06-01 | integration | full site build | zero broken internal links; no page over the size budget; search index generated |
| IT-M10-06-02 | integration | `orch plugin check examples/provider-plugin-template` in `docs.yml` | exit 0; the guide's quoted output matches the actual output byte-for-byte |
| IT-M10-06-03 | integration | examples typecheck + test run | every imported sample compiles under `tsc --strict` and its tests pass |
| E2E-M10-06-01 | e2e (Playwright) | AR locale on three pages | `dir="rtl"` on `<html>`, sidebar mirrored, code blocks and file trees remain LTR, no horizontal overflow at 375 px |
| E2E-M10-06-02 | e2e (axe-core) | five sampled pages, EN and AR | no critical/serious violations; contrast AA |
| AT-M10-06-01 | ci | a deliberately broken external link and a stale CLI reference | link check warns/fails per policy; banner shows the recorded version, not the installed one |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-06-01 | Getting started on a clean machine | 1. On a fresh user account, follow Getting started verbatim (no prior knowledge, no shortcuts). 2. Time it. | A working daemon, web UI and one real session; every command in the page works as written; time to first session recorded (target < 20 min) | ⬜ |
| TC-M10-06-02 | Arabic reading pass | 1. Switch to العربية. 2. Read getting started, concepts and the security page end to end on desktop and at 375 px. | Layout mirrors correctly; punctuation and numerals render correctly; code, paths and CLI flags stay LTR and copyable; no clipped or overlapping text | ⬜ |
| TC-M10-06-03 | ADR index accuracy | 1. Open the ADR index. 2. Compare with `plan/DECISIONS.md`. | Every ADR present with the correct status and date; ADR-001, 002, 006, 009, 012, 013 linked from the pages that depend on them | ⬜ |
| TC-M10-06-04 | Verified-against banners | 1. Open every page describing a vendor surface. 2. Compare the banner with `packages/providers/*/fixtures/*/RECORDED.md`. | Each banner matches the recorded CLI version and date; no page describing a vendor surface lacks a banner | ⬜ |
| TC-M10-06-05 | Security page completeness | 1. Read Security & compliance. | C1–C13 stated in plain language; non-features list present; ADR-013 privilege model stated plainly; drift-report field table matches `docs/security/drift-reports.md` exactly; reporting channel + SLA present | ⬜ |
| TC-M10-06-06 | **Plugin Author Guide, followed literally** | 1. On a clean checkout, follow pages 01→09 without reading any source file outside `examples/`. 2. Stop at the first ambiguity and log it. | A plugin that installs with `--trust local` and passes `orch plugin check`; every ambiguity logged becomes a docs fix before ✅ | ⬜ |
| TC-M10-06-07 | **Third-party author (DoD-11 rehearsal)** | 1. Give an external developer only the published URL. 2. Observe without helping; answer only in writing, and add every answer to the docs. | They reach a loading plugin; the list of questions is empty or fully folded back into the guide; this transcript is the M10-08 evidence | ⬜ |
| TC-M10-06-08 | Deployment guides | 1. Follow container and Helm pages on a test cluster; follow remote-access with Tailscale. | Daemon runs in a container with tmux; Helm install passes probes; remote access works and the page's warnings about binding and tokens are accurate | ⬜ |
| TC-M10-06-09 | **Negative: broken link and missing translation** | 1. Add a link to a non-existent page and an EN page with no AR sibling. 2. Push. | Both fail `docs.yml` with the exact file and line; no deployment happens | ⬜ |
| TC-M10-06-10 | **Negative: stale sample** | 1. Change a public SDK signature without updating `examples/`. 2. Push. | `examples/` typecheck fails in `docs.yml`; the guide can never ship a sample that does not compile | ⬜ |
| TC-M10-06-11 | Versioning | 1. Tag a release. 2. Open `/latest` and the previous version. | Versioned build published, picker lists both, old build unchanged, `latest` repointed; deep links from the app still resolve | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Site builds and deploys from CI on PR (preview), `main` (`/next`) and tags (versioned + `latest`), with no long-lived deploy secrets.
- [ ] Every EN page has a human-translated AR sibling with correct RTL rendering; `translationStatus: pending` cannot reach `main` (UT-02, TC-02, TC-09).
- [ ] Every page describing a vendor surface carries a generated `VerifiedAgainst` banner matching the provider's `RECORDED.md` (UT-03, TC-04).
- [ ] Every code sample in the author guides is imported from `examples/`, typechecks under `tsc --strict`, and its tests run in CI (IT-03, TC-10).
- [ ] The ADR index is generated from `docs/adr/` and matches `plan/DECISIONS.md` (TC-03).
- [ ] A person following only the Plugin Author Guide reaches a plugin that passes `orch plugin check` and loads with `--trust local` (TC-06), and an external developer does the same with no verbal help (TC-07).
- [ ] Security & compliance page states C1–C13, the non-features, ADR-013 and the drift-report field table (TC-05).
- [ ] Deployment pages verified on a real container and a real cluster (TC-08).
- [ ] No third-party trackers or analytics on the site; axe-core shows no critical/serious issues (E2E-02).
- [ ] All TC-M10-06-01 … 11 pass and are recorded; no new lint violations; docs build time under 3 minutes in CI.

## 8. Risks / open questions
- **Naming (R14).** Every URL, package name and screenshot embeds the product name. ADR-002 must be accepted (M10-07) before the production deploy; until then deploy only to the preview environment and keep the name in one config value.
- **Docs drift.** Prose ages faster than code. The mitigations here are structural — generated reference, imported samples, verified-against banners — but the guides' *narrative* still needs a review pass at each minor release; add it to the release checklist in M10-07 rather than hoping.
- **AR translation quality and maintenance.** A human pass is required at 1.0; the ongoing cost is real. Policy decision to record: EN is normative, AR may lag by at most one minor version, and `translationStatus` makes the lag visible instead of invisible.
- Arabic technical typography (mixed LTR code inside RTL prose, bidi in inline code, numerals) is easy to get subtly wrong; TC-02 plus the Playwright RTL screenshots are the guard, and a native reader should review before 1.0.
- The Plugin Author Guide depends on M10-03's formats being final. If the registry formats move after the guide is written, the guide is wrong in a way CI cannot catch (prose, not samples) — sequence M10-03 fully before writing pages 02 and 08.
- External link rot and vendor doc URLs moving: link checking treats external links as warnings except in the security and deployment pages, where they are blocking.
- Hosting choice and its privacy properties must match the security page's "no trackers" claim — verify the chosen static host does not inject analytics **(confirm at step start)**.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
