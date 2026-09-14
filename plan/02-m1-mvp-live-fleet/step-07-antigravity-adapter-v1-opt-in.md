# Step M1-07 — Antigravity adapter v1 (opt-in)

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet (optional for MVP exit; required for M3) |
| Status | ⬜ Not started |
| Depends on | M0-09, M1-02, M1-04 |
| Estimated effort | 3 days |
| Packages touched | `packages/providers/agy`, `apps/daemon` (ToS acknowledgement endpoint), `apps/web` (opt-in dialog) |
| Risk | High (R4 ToS; undocumented quota numerics) |
| Owner | |

## 1. Goal
`@orchestra/provider-agy` integrates Antigravity strictly by launching the user's own official `agy` binary: interactive PTY sessions with the five official hooks registered in a project-local config, headless multi-turn via `agy -p --input-format stream-json --output-format stream-json` over stdio, the quota-free `/usage` probe, and prompt answers via hook decisions with `send-keys-acked` fallback. The adapter is **disabled until the user acknowledges the ToS notice in-product**; the acknowledgement is stored and audited. No relay, no remote-control API, no backend calls (C11).

## 2. Why
D4, C11, ADR-008, R4; `05-provider-contract.md` §3 row "Antigravity"; G2 (Gemini Flash/Pro is the cheap-lane in the default matrix).

## 3. Scope
### In scope
- Opt-in: `PATCH /providers/agy {tosAcknowledged:true}` from a dialog that shows the ToS summary + link; stores `tos_acknowledged_at` + audit row; adapter refuses to launch otherwise (`PROVIDER_DISABLED`).
- Manifest v0: models (Gemini Pro/Flash + any Claude models exposed under the Google plan "(verify ids via `agy` model list)"), features `hooks mcp streamJsonInput websearch imagegen vision`, sandbox profiles `request-review | always-proceed` (never auto-select `always-proceed`), prompt protocol (hooks → `hook-response`; approval prompts in PTY → `send-keys-acked` with keystroke fixtures), headless spec, paths (`AGENTS.md`/instruction file "(verify)", `.agents/skills`), `updateSources`, `tos: {requiresAcknowledgement: true}`.
- `Launcher.interactive` with project-local hook config (`PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop`) pointing at the shared `orch-hook.mjs` pattern (reuse from M1-05, provider param); MCP config placeholder for M2-05.
- `Launcher.headless`: stream-json stdio, daemon writes user turns to stdin (multi-turn), reads events from stdout.
- `TelemetryParser`: hook payloads + stream-json events → normalized; `QuotaProbe`: `agy -p "/usage"` structured output → `WindowState[]` labelled `estimate` unless the output states limits explicitly; `/credits` if present.
- `RateLimitParser` from stream-json errors / exit codes.
- `PaneController`: slash/custom commands via keys with ack; `answerPrompt` hook-response for tool decisions; approval prompts in PTY via keystroke map.
- Fixtures from `agy 1.2.1`; contract tests; fuzz.
### Out of scope (deferred)
- Remote-control relay (never). Cloud session aggregation (M7-07, read-only). Quota forecasting (M4-02). Skills installer (M8-04).

## 4. Design
### 4.1 Domain
`ProviderAccount.tosAcknowledgedAt`; `enabled = tosAcknowledgedAt != null && config.enabled`.
### 4.2 Interfaces / contracts
```ts
// headless stdio protocol wrapper
export class AgyStreamSession { constructor(io: { stdin: Writable; stdout: Readable }); sendUserTurn(text: string): Promise<Result<void, AdapterError>>; events(): AsyncIterable<NormalizedEvent>; close(): Promise<void> }
```
Manifest `tos` block renders in Fleet as a card: "This adapter launches your own official `agy` binary. Orchestra never contacts Antigravity services directly and never reuses your login. Review Antigravity's Terms (link). [Acknowledge]".
### 4.3 Data / schema changes
`providers.tos_acknowledged_at` (baseline has it).
### 4.4 Infrastructure
Headless mode runs in a tmux pane too (`agy -p …` with the daemon attached to the pane's stdio through the same stdio bridge as Codex, M1-06) so it stays attachable and restart-safe.
### 4.5 API / UI surface
`PATCH /providers/agy` (ack), Fleet card (M1-10).
### 4.6 Flow
`terms resolution + technical evidence + ack → enabled → start → hooks config written in worktree → agy runs → PreToolUse hook → prompt → answer via hook response → continues`.

### 4.7 Review reconciliation contract (2026-09-15)
Start gate requires both written ADR-008 terms resolution and per-mode technical evidence; a ToS checkbox alone never enables the adapter. Treat headless control_request/control_response as unsupported per the supplied review until contrary version-specific evidence exists. A soft-denied required tool means incomplete task even if process exit is 0. The headless /usage probe is unverified and disabled until its documented support and consumption behavior are proven. Unsupported interactions stay manual-only/disabled; no mandatory milestone or KPI requires this adapter.

## 5. Tasks
- [ ] ToS acknowledgement endpoint + audit + Fleet dialog copy (EN/AR).
- [ ] Manifest v0 with `tos`, models, hooks, headless.
- [ ] Generalise `orch-hook.mjs` to `--provider agy` (shared bin in `packages/sdk/bin`).
- [ ] `AgyLauncher` (interactive/headless + preLaunchFiles hook config), `AgyAuthProbe` (quota-free status "(verify command)"), optional `AgyQuotaProbe` only after separate evidence; otherwise unavailable, `AgyTelemetryParser`, `AgyRateLimitParser`, `AgyPaneController` (keystroke map).
- [ ] Record fixtures: each hook kind, a headless multi-turn stream, `/usage` output, an approval prompt transcript for keystroke mapping, exit codes.
- [ ] Contract + fuzz tests; register adapter; Fleet integration.
- [ ] Docs: `packages/providers/agy/README.md` compliance section (what we do / never do).
- [ ] Manual TCs.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M1-07-01 | contract | seven specs on fixtures 1.2.1 | pass |
| AT-M1-07-02 | application | start without ToS ack | `PROVIDER_DISABLED`; audit row absent; nothing launched |
| UT-M1-07-03 | unit | `/usage` fixture → `WindowState[]` with `confidence:'estimate'` unless explicit | mapped |
| UT-M1-07-04 | unit | stream-json fixture → message/tool/usage/exit | golden |
| UT-M1-07-05 | unit | hook fixture `PreToolUse` → prompt with `hook-response` | mapped |
| UT-M1-07-06 | fuzz | parser | never throws |
| AT-M1-07-07 | architecture | egress test with an agy session | no non-local hosts contacted by the daemon |

### 6.2 Manual test cases (real agy, scratch repo)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-07-01 | Opt-in gate | 1. Fleet shows agy "requires acknowledgement" 2. try start | refused with clear message; acknowledgement alone leaves disabled until both gates pass; audit row | ⬜ |
| TC-M1-07-02 | Interactive + hook prompt | 1. start agy (Gemini Flash) 2. ask it to create a file | `PreToolUse` prompt in Attention; allow → file created | ⬜ |
| TC-M1-07-03 | PTY approval fallback | 1. trigger an approval that has no hook decision path (per fixtures) | AgentPrompt with `send-keys-acked`; answer → keystrokes → proceeds | ⬜ |
| TC-M1-07-04 | Headless multi-turn | 1. `orch dev run agy --headless` with two turns | both turns processed; events streamed; exit 0 | ⬜ |
| TC-M1-07-05 | Usage probe | 1. `POST /providers/agy/quota` | windows shown with `estimate` label; no session created | ⬜ |
| TC-M1-07-06 | Compliance grep | 1. `grep -r "antigravity.google\|remote-control" packages/providers/agy/src` | only in manifest `updateSources`/docs, never in code paths making requests | ⬜ |

### 6.3 Review regression scenarios
- [ ] Terms gate unresolved with checkbox accepted: adapter still disabled.
- [ ] Soft-denied required tool with exit 0: task not completed.
- [ ] Unsupported control input is not sent; absent usage probe stays unknown.

## 7. Acceptance criteria
- [ ] Adapter disabled until ADR-008 terms resolution, per-mode evidence and in-product acknowledgement; audited.
- [ ] Only evidenced modes/features enabled; unsupported headless controls stay disabled.
- [ ] Usage remains unknown unless a documented and separately evidenced probe exists.
- [ ] Contract/fuzz/egress tests green; fixtures recorded.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Legal review of the adapter before public release (DECISIONS ADR-008). Keep the adapter behind `providers.agy.enabled` default `false` in shipped config.
- `/usage` output format undocumented — parser must be tolerant; unknown fields → `estimate`.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
