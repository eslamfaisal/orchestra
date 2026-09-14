# 03 — System architecture

## 1. Planes

```
Surfaces: Tauri macOS app · Browser/PWA · `orch` CLI
            │ HTTPS + WS (local token / OIDC)
orchestrad (NestJS, one process per host)
  A Terminal plane    tmux control-mode driver · SessionSupervisor · worktree manager · PTY recorder
  B Telemetry plane   hooks receiver (HTTP) · JSON/JSONL stream parsers · app-server RPC client · OTLP receiver
  C Delegation plane  MCP server for Leads: capabilities/delegate/status/collect/ask_user (elicitation)
  D Intelligence      task taxonomy · model profiles · assignment engine · quota forecaster · skills resolver
  E Maintenance       doctor · drift detector · registry client · repair agent · update manager
  F Event store       append-only events · conversations · recordings (SQLite → Postgres)
  G Plugin host       ProviderAdapter · Manifest · SkillPack · Playbook · ModelCatalog loaders
            │ tmux pane per agent, one worktree per task, official binary, official login
  claude · codex · agy · kimi · opencode
```

## 2. Process model on one host

```
launchd/user shell
 └─ orchestrad (node)                 ← HTTP :4300 default (127.0.0.1; M7-01 makes the port dynamic, docs use 4300 as the example), WS /ws, WS /term (raw), MCP (stdio or streamable-http)
     ├─ tmux -CC attach -t orchestra   ← ONE control-mode client, owned by SessionSupervisor
     │    └─ tmux server "orchestra"   ← survives daemon death; panes = agents
     │         ├─ window task-abc: claude --worktree … (cwd: .orchestra/worktrees/task-abc)
     │         ├─ window task-def: codex app-server … (or `codex` interactive)
     │         └─ window task-ghi: agy -p --input-format stream-json …
     ├─ hooks receiver: agents POST hook payloads to http://127.0.0.1:4300/hooks/<provider>/<sessionId>
     ├─ recorder: pipe-pane per window → asciicast v2 files
     └─ sqlite: ~/.orchestra/orchestra.db (WAL), recordings in ~/.orchestra/recordings/
```

**Route prefix rule:** every REST route lives under `/api/v1`; step files write routes without the prefix for brevity (`POST /sessions` ≡ `POST /api/v1/sessions`); a step that writes `/api/doctor/run` means `/api/v1/doctor/run`. WS endpoints (`/ws`, `/term`), hooks (`/hooks`) and `/health` are unprefixed.

Key properties:
- Daemon crash ⇒ agents keep running in tmux. On restart the supervisor re-attaches, reconciles panes vs DB, replays hook/stream backlog, re-derives open prompts (M5-05).
- UI crash ⇒ nothing happens to agents; UI re-subscribes over WS and gets a snapshot + delta.
- User can `tmux attach -t orchestra` from any terminal at any time (D2).

## 3. Components

| Component | Responsibility | Tech |
|---|---|---|
| `apps/daemon` (`orchestrad`) | tmux, storage, engines, MCP, HTTP/WS, plugin host | Node 22, NestJS (Fastify adapter, WS gateway), Zod, Kysely |
| `apps/web` | full UI, served by daemon, embedded in Tauri | React 19, Vite, Tailwind 4, shadcn/ui, Zustand, TanStack Query, xterm.js (WebGL), asciinema-player, cmdk |
| `apps/desktop` | macOS shell: tray, notifications, deep links `orchestra://`, signed updater, daemon sidecar | Tauri 2 |
| `apps/cli` (`orch`) | scripting: `orch delegate`, `orch fleet`, `orch doctor`, `orch replay`, `orch skill eval` | TypeScript, talks to daemon HTTP |
| `packages/core` | pure domain: entities, value objects, rules, repository interfaces | TypeScript, zero deps |
| `packages/sdk` | public contracts for plugin/skill/playbook authors + contract-test harness + `FakeProvider` | TypeScript |
| `packages/catalog` | task taxonomy, model profiles, playbooks, skill packs (data + Zod schemas) | JSON/YAML |
| `packages/ui` | shared design-system components (shadcn base, tokens, RTL) | React |
| `packages/providers/*` | adapters + manifests + fixtures: claude, codex, agy, kimi, opencode | TypeScript |

## 4. Clean Architecture inside every package

```
core/            entities · value objects · repository interfaces · domain services · rules   (PURE, no I/O)
application/     use cases: StartSession, StopSession, AnswerPrompt, DelegateTask, PlanMission,
                 AssignTask, RunDoctor, ApplyRepair, RecordOutcome …  (depends on core + ports)
infrastructure/  tmux · git worktrees · sqlite/postgres (Kysely) · recorder · otlp · registry client · adapters
interface/       http controllers · ws gateways · mcp tools · cli commands · hook receivers
```

Rules:
- `core` imports nothing outside itself. `application` imports `core` and port interfaces only. `infrastructure` implements ports. `interface` calls use cases. Enforced by `dependency-cruiser` (M0-01) and CI.
- `Result<T, DomainError>` (neverthrow) inside core/application. Exceptions only at the interface layer.
- One use case per class; strategies (providers, roles, drivers, remediations) are DI-registered — no `switch(provider)` in core.

## 5. Real-time channels

| Channel | Transport | Payload | Notes |
|---|---|---|---|
| `/ws` | WebSocket (JSON) | domain events, snapshots, prompt updates, fleet state | one connection per UI tab; subscribe by topic |
| `/term/:sessionId` | WebSocket (binary) | raw PTY bytes both ways, resize | never through Tauri JSON IPC; backpressure + 40 MB/pane budget |
| `/hooks/:provider/:sessionId` | HTTP POST (from agent hooks) | vendor hook payloads | idempotent by `(sessionId, hookEventId)`; respond with decisions where the hook allows |
| `/otlp` | HTTP/protobuf | OTel traces/metrics from CLIs that emit them | optional |
| MCP | stdio (per Lead session) or streamable HTTP | `capabilities/delegate/status/collect/ask_user` | registered in the Lead's MCP config at session start |

## 6. Cross-cutting
- Zod-validated config (fail fast at boot) · Kysely migrations (never edit shipped ones) · pino logs with correlation ids (`sessionId`, `taskId`, `missionId`) · OTel traces · idempotent event ingestion · RBAC guards (no-op single-user mode until M9) · audit interceptor · secrets-redacting serializer.

## 7. Security boundaries
- Daemon binds `127.0.0.1` only on host installs. Remote access = Tailscale / Cloudflare Tunnel in front (M7-04). Container mode (M9-06) binds the pod interface behind ingress + network policy (ADR-018).
- Local token in `~/.orchestra/token` (0600) for web/CLI; OIDC in team mode.
- The daemon never reads vendor credential stores. `AuthProbe` returns `{loggedIn, plan, accountLabel}` only; tests assert no token-shaped fields ever cross a port boundary.
- Repair Agent (M10-01) runs in a sandboxed worktree with a path-based deny list (auth, ToS rules, allowlist, ESLint bans).

## 8. Data flow: one prompt round-trip (example, Claude Code)

```
claude (pane) ──PreToolUse hook──▶ POST /hooks/claude/:sid ──▶ TelemetryParser → AgentPrompt(kind=permission)
     ▲                                                                      │ persist + emit ws event
     │ hook response {decision:"allow"} ◀── AnswerPrompt use case ◀── UI/phone/auto-answer policy
     └───────────── continues ─────────────────────────────────────────────┘
```
Timeouts: if no answer within the hook's deadline, the daemon returns `defer`/`ask` per manifest so the CLI shows its own native prompt, and the AgentPrompt stays open with transport `send-keys-acked` as fallback.

## Feasibility contract reconciliation (2026-09-15)
Provider capabilities are keyed by exact CLI version and execution mode; foundation 14 and M0-09 define the release gate. Mandatory unsupported capabilities block that mode; optional unsupported capabilities disable only the feature. Task success follows declared deliverables (M3-03), independent review uses model publisher identity (M3-04), and merge validation binds the exact candidate commit (M3-05). Recovery means durable captured records with explicit outcomes (M5-05), not universal capture or exactly-once effects. Budgets are admission limits (ADR-021). Learning defaults to shadow proposals (M8-06). Enterprise v1 is trusted shared-team execution (ADR-019); plugin provenance alone never authorizes untrusted execution (ADR-014). These revised contracts govern implementation; the source-plan-v0.2 snapshot is historical.
