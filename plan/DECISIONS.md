# Decisions & ADR index

Architectural decisions D1–D14 live in `00-foundations/02-decisions.md`. This file tracks ADRs. **Canonical location: `docs/adr/ADR-NNN-<slug>.md` in the repo (created by M0-01).** `plan/adr/` is only a holding area before M0-01; move any drafts into `docs/adr/` during M0-01 and delete the folder. Numbers are reserved here first — take the next free number from this table before writing a file.

## ADR index

| ADR | Title | Status | Needed before | Owner | Notes |
|---|---|---|---|---|---|
| ADR-001 | Core license: Apache-2.0 vs AGPL-3.0 (SDK/protocol/plugins fixed Apache-2.0) | Proposed | first external PR; latest M10-07 | | Consider: future hosted offering, plugin ecosystem friendliness, enterprise procurement. Default if undecided: Apache-2.0 everywhere. |
| ADR-002 | Product name & trademark clearance ("Orchestra" likely conflicts: ORCHESTRA AI / Orchestral marks) | Open | public launch (M10-07); GitHub org/npm scope/domains reserved earlier | | Shortlist coined marks (e.g. Maestrae, Fleetwright, Podium). Keep `orch` CLI name if possible. |
| ADR-003 | Node floor: 22 LTS (plan) vs 24 LTS; dev machine runs 26 | Proposed (22) | M0-01 | | node-pty 1.1.0 prebuilt matrix; NestJS support; Tauri sidecar build. |
| ADR-004 | Recording source: tmux `pipe-pane` vs control-mode `%output` capture | Open | M5-01 | | Control-mode capture = single source, already parsed; pipe-pane = independent of daemon liveness. Likely: pipe-pane to file for durability + control-mode for live. |
| ADR-005 | Daemon packaging inside Tauri: Node single-executable (SEA) vs bundled Node runtime sidecar vs Rust port of terminal plane | Open | M7-01 | | Affects updater size, notarization, native modules (better-sqlite3, node-pty). |
| ADR-006 | Signing scheme for manifests/registry artifacts: Sigstore/cosign vs minisign (ed25519) | Open | M6-03 | | Sigstore = ecosystem standard, heavier; minisign = trivial offline verify. Could do both: minisign for hot manifests, Sigstore for releases. |
| ADR-007 | MVP scope = M0 + M1; agy adapter optional for MVP | Accepted 2026-09-14 | — | | See D11. |
| ADR-008 | Antigravity adapter opt-in with in-product ToS acknowledgement; legal review before public release | Accepted 2026-09-14 | M1-07 | | Rule C11. |
| ADR-009 | Codex integration via `app-server` (experimental) with `exec --json` fallback; never `mcp-server` | Accepted 2026-09-14 | M1-06 | | Pin schema fixture; transport switch is a ladder-1 remediation. |
| ADR-010 | Storage: SQLite (WAL, FTS5) local-first; Postgres + S3 via driver swap | Accepted 2026-09-14 | M0-04 / M9-05 | | D8. Only Postgres-compatible column types in migrations. |
| ADR-011 | Codex `app-server` (and agy headless stdio) run **inside a tmux pane** through a stdio↔Unix-socket bridge so every agent stays attachable and restart-safe; the daemon never owns the agent process directly | Accepted 2026-09-14 | M1-06, M1-07, M5-05 | | Revisit if the bridge proves flaky (fallback: daemon-child process, documented in M1-06 §8). |
| ADR-012 | REST routes under `/api/v1`; step docs omit the prefix; WS/hooks/health unprefixed | Accepted 2026-09-14 | M0-06 | | See 03-architecture.md §2 route prefix rule. |
| ADR-013 | `orch` CLI package exists from M0-01; subcommands added incrementally (`dev`, `fixtures`, `catalog`, …); M7-06 consolidates into a command registry with `--json` output | Accepted 2026-09-14 | M0-01, M7-06 | | |
| ADR-014 | No runtime sandbox for plugin code in v1; signature + trust level + review + no install scripts + declarative `declares` as compensating controls; revisit trigger defined | Proposed | M10-03 | | Written in M10-03. |
| ADR-015 | Repair Agent trust boundary: assisted-only, PR by default, local apply only for manifest+fixtures after guards + suite + explicit approval; never autonomous | Proposed | M10-01 | | Closes the open decision below. |
| ADR-016 | Migration dialect parity: shipped SQLite migrations stay untouched; Postgres support via a dialect-aware migration provider that maps types at run time (no parallel migration list) — final choice recorded in the ADR | Proposed | M9-05 | | Written in M9-05. |
| ADR-017 | Encryption at rest: OS/volume encryption as baseline; sensitive columns (OIDC refresh tokens, webhook secrets, signed approvals) encrypted with a daemon key from keychain/KMS | Proposed | M9-09 (needed by M9-02, M9-04, M9-07) | | Written in M9-09. |
| ADR-018 | Container mode binds `0.0.0.0` inside the pod behind ingress/network policy; 127.0.0.1 rule applies to host installs only | Proposed | M9-06 | | Guarded by `features.container`. |

## Open product decisions (not ADRs yet)
| Topic | Options | Decide by |
|---|---|---|
| Depth of cloud-session aggregation (Claude web, Codex cloud, agy remote) | none / read-only monitor / handoff | M7-07 |
| Repair Agent trust boundary | assisted-only (proposes PR) vs local-apply-with-approval | M10-01 |
| OTel GenAI semconv snapshot version | pin at M0-04 | M0-04 |
| Default auto-answer policy shipped | conservative (ask everything) vs "read-only auto-approve" | M1-11 |

## How to add an ADR
Copy `templates/ADR_TEMPLATE.md` → `plan/adr/ADR-NNN-<slug>.md` (later `docs/adr/`), fill it, add a row above, link it from the affected step's "Why" or "Risks" section, and note it in `PROGRESS.md` Change log.
