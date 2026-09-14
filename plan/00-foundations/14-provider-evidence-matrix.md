# 14 — Provider evidence matrix

## Purpose
A central weakness found in review is that it designs a universal provider contract **before proving which capabilities each provider actually exposes**. This file is the fix: one table where every claim about a vendor CLI is either backed by a recorded observation of that exact binary, or explicitly marked as not yet known.

It answers one question per row: *can Orchestra do this operation, with this provider, at this CLI version, in this execution mode — and what is the evidence?*

Rules:
- **Documentation is not runtime evidence.** A vendor doc gets a row and the state `unverified`. Only running the real CLI and recording a fixture changes that.
- **A green mock test suite is not live-provider evidence.** `FakeProvider` and recorded fixtures prove our parsing, not the vendor's behaviour. A passing contract run never promotes a state (`05-provider-contract.md` §5).
- **`unsupported` disables a feature, not a provider.** A provider with no headless permission path simply does not get headless auto-approval; it keeps every other capability it has.
- **No MVP-required operation may ship `unverified`.** M0-09 is the gate.
- This file is the human-readable source; `CapabilityManifest.capabilities[]` (`05-provider-contract.md` §2) is its machine-readable projection, and the two are kept in sync by `capability.contract.spec.ts`.

## State vocabulary
| State | Meaning | Required evidence |
|---|---|---|
| `verified` | performed against the real CLI at the tested version and mode; behaviour matched what the adapter assumes | fixture committed + acceptance test id |
| `limited` | works, but not for every case — documented restriction | fixture + `limitation` text naming what does not work |
| `manual-only` | the human can do it in the pane; Orchestra cannot do it programmatically | observation note + `limitation` |
| `unsupported` | the CLI does not offer it in this mode; the dependent feature is disabled for this provider/mode | observation note (a negative result is still a result) |
| `unverified` | read from vendor docs, never observed here | none — this is the default and the thing M0-09 removes |

## Key
Every row is keyed by **provider + CLI version + execution mode**. The same operation may legitimately hold different states across modes of the same binary (e.g. `verified` in `interactive-pty`, `unsupported` in `headless`).

Execution modes: `interactive-pty` · `headless` · `app-server` · `acp` · `wire`.

## Columns
| Column | Content |
|---|---|
| Operation | one of the 15 operations below |
| State | `verified` \| `limited` \| `manual-only` \| `unsupported` \| `unverified` |
| Source | official vendor documentation URL the claim was read from |
| CLI version | the exact version tested (`—` while `unverified`) |
| Mode | execution mode this row applies to |
| Fixture | path under `packages/providers/<id>/fixtures/<cliVersion>/` |
| Test | acceptance test id proving the adapter still matches the fixture |
| Limitation | required for `limited` / `manual-only` |
| Last checked | ISO date the row was established or refreshed |

## Operations
| # | Operation | What must be shown |
|---|---|---|
| 1 | launch | start a session in a worktree from a documented argv/env and reach a usable state |
| 2 | resume | reattach to or resume a prior conversation/thread by id |
| 3 | cancel / interrupt | stop the current turn without killing the session, and observe that it stopped |
| 4 | permission approval | answer a tool-permission request programmatically and observe a structured ack |
| 5 | question answer | answer a free/multiple-choice question programmatically with a structured ack |
| 6 | plan approval | approve or reject a plan artifact programmatically |
| 7 | elicitation | respond to a structured elicitation request |
| 8 | model switch | change model mid-session and observe confirmation |
| 9 | usage / quota signal | read consumption in a documented, quota-free way with a stated unit |
| 10 | rate-limit signal | observe a 429/window-exhaustion signal carrying `resetAt` or `retryAfterMs` |
| 11 | exit status | obtain the agent process's true exit status durably, distinct from "the model finished a turn" |
| 12 | adopt after daemon restart | re-bind a surviving agent to a restarted daemon without losing identity |
| 13 | MCP server registration | register an MCP server via documented config and see it available |
| 14 | instruction file | the documented per-project instruction file path and precedence |
| 15 | skills location | the documented skills/commands directory and install semantics |

## Sources (as of 2026-09; re-read at step start)
| Key | URL |
|---|---|
| CLAUDE-HOOKS | https://code.claude.com/docs/en/hooks |
| CLAUDE-LEGAL | https://code.claude.com/docs/en/legal-and-compliance |
| CODEX-APPSERVER | https://developers.openai.com/codex/app-server/ |
| AGY-HEADLESS | https://www.antigravity.google/docs/cli/headless/ |
| AGY-USAGE | https://www.antigravity.google/docs/cli/commands/usage/ |
| AGY-TERMS | https://antigravity.google/terms |
| KIMI-WIRE | https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html |
| OPENCODE-SERVER | https://opencode.ai/docs/server/ |

---

## claude — required adapter (M1-05)
Modes to evidence: `interactive-pty`, `headless`. Every row below is `unverified` until M0-09.

| Operation | State | Source | CLI version | Mode | Fixture | Test | Limitation | Last checked |
|---|---|---|---|---|---|---|---|---|
| launch | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| launch | unverified | CLAUDE-HOOKS | — | headless | — | — | — | — |
| resume | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| resume | unverified | CLAUDE-HOOKS | — | headless | — | — | — | — |
| cancel / interrupt | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| cancel / interrupt | unverified | CLAUDE-HOOKS | — | headless | — | — | — | — |
| permission approval | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | hook-based decision; shape unproven | — |
| permission approval | unverified | CLAUDE-HOOKS | — | headless | — | — | needs a permission host (`--permission-prompt-tool` MCP tool or SDK `canUseTool`); `allow` alone insufficient | — |
| question answer (`AskUserQuestion`) | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | it is a **tool** intercepted by `PreToolUse`; answer is `updatedInput` | — |
| question answer (`AskUserQuestion`) | unverified | CLAUDE-HOOKS | — | headless | — | — | same, plus permission host | — |
| plan approval (`ExitPlanMode`) | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | tool via `PreToolUse`, not a hook event | — |
| plan approval (`ExitPlanMode`) | unverified | CLAUDE-HOOKS | — | headless | — | — | same, plus permission host | — |
| elicitation | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| model switch | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| usage / quota signal | unverified | CLAUDE-HOOKS | — | headless | — | — | stream-json + session JSONL; unit must be stated | — |
| rate-limit signal | unverified | CLAUDE-HOOKS | — | headless | — | — | — | — |
| exit status | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | pane exit status must survive pane death | — |
| exit status | unverified | CLAUDE-HOOKS | — | headless | — | — | — | — |
| adopt after daemon restart | unverified | CLAUDE-HOOKS | — | interactive-pty | — | — | — | — |
| MCP server registration | unverified | CLAUDE-HOOKS | — | both | — | — | — | — |
| instruction file | unverified | CLAUDE-HOOKS | — | both | — | — | — | — |
| skills location | unverified | CLAUDE-HOOKS | — | both | — | — | — | — |

Legal note: CLAUDE-LEGAL permits an end user to authenticate to an **unmodified** Claude Code binary hosted by another platform under stated conditions. That supports the native-binary approach (C1) and does **not** permit collecting credentials or reselling usage (C3, C4).

## codex — required adapter (M1-06)
Modes to evidence: `app-server`, `headless` (`exec --json` fallback). Every row `unverified` until M0-09.

| Operation | State | Source | CLI version | Mode | Fixture | Test | Limitation | Last checked |
|---|---|---|---|---|---|---|---|---|
| launch | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| launch | unverified | CODEX-APPSERVER | — | headless | — | — | `exec --json` fallback | — |
| resume | unverified | CODEX-APPSERVER | — | app-server | — | — | thread resume | — |
| cancel / interrupt | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| permission approval | unverified | CODEX-APPSERVER | — | app-server | — | — | `requestApproval` / `execCommandApproval` / `applyPatchApproval` | — |
| question answer | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| plan approval | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| elicitation | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| model switch | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| usage / quota signal | unverified | CODEX-APPSERVER | — | app-server | — | — | `account/rateLimits/read` + `account/rateLimits/updated`; **multiple buckets**, bucket identity required | — |
| rate-limit signal | unverified | CODEX-APPSERVER | — | app-server | — | — | — | — |
| exit status | unverified | CODEX-APPSERVER | — | app-server | — | — | app-server process exit ≠ turn outcome; modes must be labelled | — |
| adopt after daemon restart | unverified | CODEX-APPSERVER | — | app-server | — | — | reconnect behaviour documented as experimental | — |
| MCP server registration | unverified | CODEX-APPSERVER | — | app-server | — | — | `codex mcp-server` is **removed** — never depend on it | — |
| instruction file | unverified | CODEX-APPSERVER | — | both | — | — | — | — |
| skills location | unverified | CODEX-APPSERVER | — | both | — | — | — | — |

Transport note: app-server surfaces are **experimental**; the schema is pinned per version via `codex app-server generate-json-schema` and committed as a fixture. A headless app-server process mirrored into a pane is **not** the interactive TUI — the session's execution mode is part of its identity in the UI and in every capability row.

## agy (Antigravity) — gated optional adapter (M1-07)
**Gated, not merely opt-in.** ADR-008 (amended) requires (a) a written terms resolution recorded in `DECISIONS.md` and (b) a filled row set here, before M1-07 may start (R17). No step, README, acceptance criterion or test may require this adapter. M0-09 runs its experiments **only if the gate is resolved**.

| Operation | State | Source | CLI version | Mode | Fixture | Test | Limitation | Last checked |
|---|---|---|---|---|---|---|---|---|
| launch | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| resume | unverified | AGY-HEADLESS | — | headless | — | — | multi-turn over stream-json stdio | — |
| cancel / interrupt | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| permission approval | unverified | AGY-HEADLESS | — | headless | — | — | headless **rejects** `control_request`/`control_response`; unavailable approval ⇒ tool **soft-denied while the process exits 0** | — |
| permission approval | unverified | AGY-HEADLESS | — | interactive-pty | — | — | PTY prompt; ack path unproven | — |
| question answer | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| plan approval | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| elicitation | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| model switch | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| usage / quota signal | unverified | AGY-USAGE | — | headless | — | — | `-p "/usage"` as a **structured, quota-free probe is unverified**; the cited doc describes an interactive panel | — |
| rate-limit signal | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| exit status | unverified | AGY-HEADLESS | — | headless | — | — | **exit 0 ≠ success**: soft-denied tools still exit 0 | — |
| adopt after daemon restart | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| MCP server registration | unverified | AGY-HEADLESS | — | headless | — | — | config files only | — |
| instruction file | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| skills location | unverified | AGY-HEADLESS | — | headless | — | — | — | — |
| terms permit this wrapper | unverified | AGY-TERMS | — | n/a | — | — | §6 third-party-access restrictions unresolved; enterprise terms may differ; an in-product acknowledgement does not resolve it | — |

## kimi — later adapter (M10-04)
Documented paths are the **Wire protocol** and **ACP**. Do not inherit Claude's hook assumptions.

| Operation | State | Source | CLI version | Mode | Fixture | Test | Limitation | Last checked |
|---|---|---|---|---|---|---|---|---|
| launch · resume · cancel | unverified | KIMI-WIRE | — | wire / acp | — | — | — | — |
| permission approval · question answer · plan approval · elicitation | unverified | KIMI-WIRE | — | wire / acp | — | — | assess Wire/ACP before assuming hooks | — |
| model switch · usage/quota · rate-limit · exit status · adopt after restart | unverified | KIMI-WIRE | — | wire / acp | — | — | local logs only for usage | — |
| MCP registration · instruction file · skills location | unverified | KIMI-WIRE | — | wire / acp | — | — | — | — |

## opencode — later adapter (M10-05)
Documented path is the **local server API** (sessions, messages, events, permission responses).

| Operation | State | Source | CLI version | Mode | Fixture | Test | Limitation | Last checked |
|---|---|---|---|---|---|---|---|---|
| launch · resume · cancel | unverified | OPENCODE-SERVER | — | app-server (local server API) | — | — | — | — |
| permission approval · question answer · plan approval · elicitation | unverified | OPENCODE-SERVER | — | app-server | — | — | server permission responses, not hook equivalents | — |
| model switch · usage/quota · rate-limit · exit status · adopt after restart | unverified | OPENCODE-SERVER | — | app-server | — | — | **per configured backend**: one adapter cannot guarantee identical approval or quota semantics across backends | — |
| MCP registration · instruction file · skills location | unverified | OPENCODE-SERVER | — | app-server | — | — | — | — |

---

## Maintenance rule
- **M0-09 fills the `claude` and `codex` row sets** and may only mark an MVP-required operation `verified|limited|manual-only|unsupported` — never leave one `unverified`.
- **Each adapter step refreshes its own rows** at step start (M1-05 claude, M1-06 codex, M1-07 agy *if gated open*, M10-04 kimi, M10-05 opencode), re-reading the source URL and re-running the affected experiment.
- A CLI version bump invalidates every row for that provider: the rows keep their old `cliVersion` for history and new rows are added; the Doctor (M6-02) opens a RepairCase for any operation with no row at the installed version.
- The published copy of this table lives at `docs/providers/evidence-matrix.md` in the repo; this plan file is its specification.

## Required versus optional operations
M0-09 §4.2 defines the minimum required operations for the selected Claude/Codex mode. Required launch, structured identity, permission round-trip, cancellation outcome and durable process-exit observation must be verified (or limited without losing the mandatory behavior). `unsupported` or `manual-only` cannot satisfy a mandatory operation. Optional unsupported operations disable that feature; unknown quota and explicit manual recovery are allowed limitations. Split every grouped operation/mode row before recording an observation; `both` is not a valid evidence key. Add source retrieval date and tester identity to each completed record. No rows were promoted by this plan revision.
