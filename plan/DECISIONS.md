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
| ADR-008 | Antigravity adapter **gated**: (a) written resolution of Antigravity terms §6 for Orchestra's wrapper recorded here, and (b) an M0-09 evidence-matrix row for `agy` (headless rejects `control_request`/`control_response`; soft-denied tools exit 0; `/usage` probe unverified) — both before M1-07 starts. Still opt-in with in-product ToS acknowledgement when enabled. No step, acceptance criterion or KPI may require the adapter. | Accepted 2026-09-14; **amended 2026-09-15** | M1-07 | | Rule C11, R17. An acknowledgement checkbox does not settle the terms question. |
| ADR-009 | Codex integration via `app-server` (experimental) with `exec --json` fallback; never `mcp-server` | Accepted 2026-09-14 | M1-06 | | Pin schema fixture; switching to exec is a new execution gated by reconciliation and replay safety (M6-04). |
| ADR-010 | Storage: SQLite (WAL, FTS5) local-first; Postgres + S3 through dialect-specific migrations and repository contracts | Accepted 2026-09-14 | M0-04 / M9-05 | | D8. Preserve shipped migrations; ADR-016 defines dialect-specific SQL and logical schema parity. |
| ADR-011 | Codex `app-server` (and agy headless stdio) run **inside a tmux pane** through a stdio↔Unix-socket bridge with a labelled transcript and version/mode-specific reconnect evidence; socket persistence alone is not restart safety; the daemon never owns the agent process directly | Accepted 2026-09-14 | M1-06, M1-07, M5-05 | | Revisit if the bridge proves flaky (fallback: daemon-child process, documented in M1-06 §8). |
| ADR-012 | REST routes under `/api/v1`; step docs omit the prefix; WS/hooks/health unprefixed | Accepted 2026-09-14 | M0-06 | | See 03-architecture.md §2 route prefix rule. |
| ADR-013 | `orch` CLI package exists from M0-01; subcommands added incrementally (`dev`, `fixtures`, `catalog`, …); M7-06 consolidates into a command registry with `--json` output | Accepted 2026-09-14 | M0-01, M7-06 | | |
| ADR-014 | Plugin trust in v1: only **trusted** plugin code (`official`, `verified`, user-enabled `local`) is loaded in-process; `community` provider plugins are installable but not loadable until an isolated out-of-process plugin host exists (post-1.0 design sketched in M10-03). Signature = provenance, not safety; worker threads are not a boundary. | Proposed; **amended 2026-09-15** | M10-03 | | R20. Replaces the ">100 installs" revisit trigger: the trigger is "before the first community provider plugin becomes loadable". |
| ADR-015 | Repair Agent trust boundary: assisted-only, PR by default, local apply only for manifest+fixtures after guards + suite + explicit approval; never autonomous | Proposed | M10-01 | | Closes the open decision below. |
| ADR-016 | Migration dialect parity: shipped SQLite migrations stay untouched; Postgres support via separate append-only SQLite and Postgres migration histories with explicit logical-schema version mapping — final choice recorded in the ADR | Proposed | M9-05 | | Written in M9-05. |
| ADR-017 | Encryption at rest: OS/volume encryption as baseline; sensitive columns (OIDC refresh tokens, webhook secrets, signed approvals) encrypted with a daemon key from keychain/KMS | Proposed | decision before M9-02/M9-04/M9-07; final audit in M9-09 | | Written in M9-09. |
| ADR-018 | Container mode binds `0.0.0.0` inside the pod behind ingress/network policy; 127.0.0.1 rule applies to host installs only | Proposed | M9-06 | | Guarded by `features.container`. |
| ADR-019 | Enterprise execution model: v1 is a **trusted shared-team installation** — agents run under the daemon's OS identity, sharing home, provider auth and tmux; RBAC filters visibility/actions and does not isolate processes, credentials or repositories. Isolated per-user execution (workers or OS identities per user, per-user credential contexts, filesystem/process boundaries) is post-1.0. | Proposed | M9-01 | | R19. Stated in the product UI (Settings › Enterprise banner) and docs. |
| ADR-020 | One daemon owner per data directory: advisory lock + endpoint file (M0-04); a second daemon on the same data dir refuses to start; version mismatch triggers the coordinated upgrade protocol (drain → stop old → start new → adopt panes), never a second daemon on another port; two daemons only with fully separate data dir + tmux socket + port. | Proposed | M0-04, M7-01 | | Keeps the single-supervisor model (D13) true across upgrades. |
| ADR-021 | Budgets are **admission budgets**: a cap stops admitting new work; in-flight work continues with a documented overshoot allowance (reserved in-flight estimate + late accounting); optional `onExceed: cancel-running`; Orchestra never promises an exact external billing cap without provider-side enforcement. | Proposed | M4-04 | | UI copy says "admission budget". |
| ADR-022 | Review independence identity: `integrationId` (adapter), `modelPublisher` (family), `endpoint`, `billingIdentity` are separate; default cross-review rule is `reviewer.modelPublisher ≠ author.modelPublisher` (Claude via Claude CLI vs Claude via OpenCode is **not** independent; two publishers via OpenCode **are**); policy may tighten to endpoint/billing. Cross-review raises quality; it does not guarantee correctness. | Proposed | M3-04 | | Replaces "provider id ≠ provider id". |

| ADR-023 | [Evidence-bound orchestration and recovery](adr/ADR-023-evidence-bound-orchestration.md) | Proposed | M0-09 / affected implementation | | Capability gates, prompt delivery, deliverable success, exact candidate validation, bounded recovery and safe instruction cleanup. |

## Open product decisions (not ADRs yet)
| Topic | Options | Decide by |
|---|---|---|
| Depth of cloud-session aggregation (Claude web, Codex cloud, agy remote) | none / read-only monitor / handoff | M7-07 |
| Repair Agent trust boundary | assisted-only (proposes PR) vs local-apply-with-approval | M10-01 |
| OTel GenAI semconv snapshot version | pin at M0-04 | M0-04 |
| Default auto-answer policy shipped | conservative (ask everything) vs "read-only auto-approve" | M1-11 |
| Antigravity terms §6 resolution for Orchestra's wrapper (ADR-008 gate a) | written legal position / vendor clarification / keep disabled | before M1-07 |
| Isolated per-user execution design (ADR-019 follow-up) | separate worker processes vs OS identities vs container-per-user | post-1.0; trigger: first multi-tenant enterprise pilot |
| Isolated plugin host (ADR-014 follow-up) | out-of-process runner with narrow RPC vs no community provider plugins | before first community provider plugin is loadable |

## How to add an ADR
Copy `templates/ADR_TEMPLATE.md` → `plan/adr/ADR-NNN-<slug>.md` (later `docs/adr/`), fill it, add a row above, link it from the affected step's "Why" or "Risks" section, and note it in `PROGRESS.md` Change log.
