# Step M10-04 — Kimi adapter

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M2-03 (full capability manifests incl. command discovery + prompt protocol); uses M1-02 (SessionSupervisor), M1-04 (BinaryRegistry), M1-08 (telemetry plane + fixture recorder), M1-11 (Interaction Bridge), M4-01 (quota windows), M8-04 (skills installer) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/providers/kimi`, `packages/sdk` (ACP transport helper), `apps/daemon/src/infrastructure/binaries`, `packages/catalog/models/kimi`, `apps/web` (Fleet copy) |
| Risk | Medium (R1; new vendor surface, but the SDK and three adapters already exist) |
| Owner | |

## 1. Goal
`@orchestra/provider-kimi` (published as `orchestra-provider-kimi`) implements the full `ProviderAdapter` for the Kimi Code CLI through official surfaces only: a quota-free `AuthProbe`, a `Launcher` for interactive PTY sessions and documented headless runs (with hook and MCP configuration written per worktree), a `TelemetryParser` for hook payloads, structured stream output and local session logs, a `RateLimitParser`, a `PaneController` whose `answerPrompt` uses the hook response or the ACP transport with `send-keys-acked` as the declared fallback, an optional `QuotaProbe`, and a `SkillsInstaller` that respects Kimi's own plugin/skill trust levels. It ships a capability manifest pinned to a recorded CLI version, a `fixtures/<cliVersion>/` set, a `RECORDED.md`, and passes all seven SDK contract specs. The provider is behind `features.providers.kimi` (default off) until its TC table is green, and it is the first adapter written **against** the published SDK rather than beside it — any friction found here is a bug report for M10-03/M10-06, not a local workaround.

## 2. Why
- **D5** — "adding Kimi/DeepSeek/next thing = one package". This step is the proof that the plugin contract is complete: nothing outside `packages/providers/kimi` may change except the binary allowlist entry and a catalog data file.
- **G7** — a fourth adapter is a 1.0 Definition-of-Done line ("four adapters pass contract tests on pinned fixtures incl. approval round-trips and quota parsing").
- **G1** — every agent visible and answerable in one place; Kimi sessions must reach the Attention queue through a typed `answerTransport` like every other provider (**D14**).
- **G2** — the default assignment matrix (`06-intelligence-layer.md` §4) already lists Kimi as the fallback for `boilerplate / bulk-edit / i18n` and `quick`; without an adapter the engine can never route there, so cheap quota keeps idling.
- **C1/C8** — only the official `kimi` binary from the allowlist, launched with documented flags from typed argv builders. **C3** — the auth probe returns status only; the adapter never reads Kimi's credential store. **C7** — no regex over PTY bytes; state comes from hooks/structured output only. **C9** — CI runs `FakeProvider` and recorded fixtures, never a real account.
- `05-provider-contract.md` §3 row "Kimi Code": *open-source CLI; hooks; MCP; ACP; skills/plugins with trust levels; local logs; first-class adapter (M10-04)*. Everything beyond that row is unverified and is treated as such below.

## 3. Scope
### In scope
- Package scaffold `packages/providers/kimi/` (`src/`, `manifest.json`, `fixtures/<cliVersion>/`, `README.md`, `orchestra.plugin.json` per M10-03 so it is installable as an artifact).
- `KimiAuthProbe`, `KimiLauncher` (interactive + headless + `preLaunchFiles`), `KimiTelemetryParser`, `KimiRateLimitParser`, `KimiPaneController`, `KimiQuotaProbe`, `KimiSkillsInstaller`.
- ACP transport client in `packages/sdk/src/transports/acp.ts` (shared, since a future provider may reuse it) with a Zod-validated message envelope and an ack model identical to the app-server client (M1-06).
- Capability manifest v1 with `cliVersionRange`, models, limits, features, sandbox profiles, commands (incl. discovery of workspace custom commands), prompt protocol, headless flags, paths, `updateSources`.
- Fixture recording on a real Kimi Code install via `orch fixtures record kimi` (M1-08) + redaction pass + `RECORDED.md`.
- Contract tests (all seven specs) + parser fuzz; registration in `BinaryRegistry`; Fleet row; catalog model profiles for the shipped Kimi models.
- Feature flag `features.providers.kimi` (default `false`) and the Doctor checks that come with any provider.
### Out of scope (deferred to …)
- Publishing the package to npm with provenance — M10-07 (release pipeline); M10-03 handles installation.
- Kimi cloud/remote session aggregation — out of scope entirely (M7-07 covers only what already exists).
- Native worktree support: we run inside our own worktree, `WorktreeHooks.nativeFlag` stays empty.
- Kimi-specific subagent orchestration: Kimi is a worker here; the Lead role stays with M3-02's existing providers until evidence says otherwise.
- Any ToS acknowledgement flow: unlike Antigravity (C11) no acknowledgement is planned — **confirm the licence/ToS position at step start**; if it turns out one is needed, mirror M1-07 exactly rather than inventing a new pattern.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
None new. The adapter uses SDK types only (`05-provider-contract.md` §1) and must not import from `apps/daemon` or any other provider (dependency-cruiser rule). Pending hook responses are held by the daemon's hooks receiver (M1-08); the adapter only declares which hook names it subscribes to.

### 4.2 Interfaces / contracts
```ts
// packages/providers/kimi/src/index.ts
export const kimiAdapter: ProviderAdapter = {
  id: 'kimi',
  manifest,                                   // ./manifest.json, Zod-validated at load
  auth: new KimiAuthProbe(),
  launcher: new KimiLauncher(),
  telemetry: new KimiTelemetryParser(),
  rateLimit: new KimiRateLimitParser(),
  pane: new KimiPaneController(acpClientFactory),
  skills: new KimiSkillsInstaller(),
  quota: new KimiQuotaProbe(),                // isQuotaFree: true only if a quota-free status command exists (verify)
};

// packages/sdk/src/transports/acp.ts — shared ACP (Agent Client Protocol) client
export interface AcpClient {
  start(plan: LaunchPlan): Promise<Result<void, AdapterError>>;
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<Result<T, AdapterError>>;
  notifications(): AsyncIterable<{ method: string; params: unknown }>;
  respond(id: string | number, result: unknown): Promise<Result<void, AdapterError>>;   // approvals answered in-band
  stop(): Promise<void>;
}
// Every inbound frame is Zod-parsed before use; an unparsable frame yields Result.err(UnknownPayload)
// which the Doctor counts as a drift signal (M6-02, SignalKind 'parse_error') — never a throw, never a guess.
```
Manifest excerpt (shapes are fixed by the SDK schema; every *value* marked "(verify)" is confirmed against the Kimi Code docs and the recorded CLI at step start):
```jsonc
{
  "provider": "kimi",
  "manifestVersion": "1.0.0",
  "cliVersionRange": ">=<recorded major.minor> <next major>",   // filled from the recorded CLI (verify)
  "fixturesVersion": "<cliVersion>",
  "models": [ /* ids exactly as the CLI lists them (verify) */ ],
  "limits": { "maxConcurrentSessions": 2, "windows": ["daily"], "resume": true, "fork": false },   // (verify)
  "features": ["hooks", "mcp", "skills", "acp", "streamJsonInput"],                                 // (verify)
  "sandboxProfiles": [ /* Kimi's own permission/approval modes (verify) */ ],
  "commands": [ /* native slash commands + discovered workspace commands (verify) */ ],
  "promptProtocol": {
    "permission":   { "source": "hook:<PreToolUse-equivalent>", "answerTransport": "hook-response", "fallback": "send-keys-acked", "deadlineMs": 60000 },
    "question":     { "source": "acp:<request method>",          "answerTransport": "acp-response",  "fallback": "send-keys-acked" },
    "planApproval": { "source": "hook:<plan-exit equivalent>",   "answerTransport": "hook-response", "fallback": "send-keys-acked" },
    "login":        { "source": "process:stderr",                "answerTransport": "none" }
  },
  "headless": { "flags": ["<documented headless flag>"], "outputFormat": "stream-json" },           // (verify)
  "paths": { "instructionFile": "<AGENTS.md or Kimi equivalent>", "skillsDir": "<...>", "commandsDir": "<...>", "hooksConfig": "<...>", "mcpConfig": "<...>" },  // (verify)
  "updateSources": { "releases": "<GitHub releases URL>", "changelog": "<...>", "docs": "<...>" }
}
```
### 4.3 Data / schema changes
None. Sessions, events, `agent_prompts`, `provider_windows` and `outcomes` already carry `providerId`; `kimi` is added to the `ProviderId` union in `packages/sdk` (a type-level change already anticipated by `05-provider-contract.md` §1) and to `packages/catalog/models/kimi/*.yaml`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Binary**: `kimi` added to `BinaryRegistry` (M1-04) with a version range and the documented `--version` parse. Not on PATH ⇒ the provider is `unavailable` on Fleet with an install hint; it is never auto-installed.
- **Per-worktree config, never global**: `preLaunchFiles` writes the hooks config and the MCP config into the worktree at the paths declared by `manifest.paths`, deep-merging any existing user file and backing the original up to `.orchestra/backup/` (identical to M1-05's rule). The user's home configuration is never modified.
- **Hooks**: the same bundled dependency-free script pattern as Claude Code — `bin/orch-hook.mjs` reads the hook JSON on stdin, POSTs it to `$ORCH_HOOK_URL/kimi/$ORCH_SESSION_ID/<hook>`, prints the daemon's JSON response on stdout and exits non-blocking if the daemon is unreachable. Hook names and response semantics come from the recorded fixtures **(verify against Kimi Code hooks docs at step start)**.
- **ACP**: if the CLI exposes ACP over stdio, the adapter runs it as a second, *structured* channel next to the PTY pane, exactly as M1-06 does for `codex app-server`: the pane stays the user's window, the RPC channel carries approvals and model switches. Transport choice is a manifest feature flag so a future ACP removal is a ladder-1 transport switch (M6-04), not a code change.
- **Session logs**: local session-log ingestion is registered as a `TelemetrySource` (`'session-log'`) and read from the path declared in the manifest; file reads stay inside the worktree and the user's Kimi session directory, are size-capped, and are redacted at capture time (C13) before anything is persisted.
- **Env**: child processes get the explicit allowlist only (`PATH`, `HOME`, `TERM`, `LANG` + any Kimi-required variable named in the manifest). The daemon's full environment is never inherited (`09-engineering-standards.md`).
- **Network**: none from the adapter. The CLI talks to its own vendor over its own official channel; Orchestra adds nothing (C2). The `no-vendor-endpoints` rule covers `api.moonshot.*` already (M0-08).
- **Skills**: `KimiSkillsInstaller.install()` writes a rendered skill into `manifest.paths.skillsDir` with the trust level chosen in M8-04 and refuses to install an `untrusted` skill; it maps Orchestra trust levels onto Kimi's own plugin/skill trust levels **(verify the exact levels and their file format at step start)**.

### 4.5 API / UI surface
None new. `kimi` appears on Fleet (M1-10) once `features.providers.kimi` is on and the binary is detected; Start-session, Terminals, Chat, Attention, Board and Missions all work through the existing provider-agnostic surfaces. Fleet copy (EN + AR) gains the provider label and the "not installed" hint.

### 4.6 Flow / sequence
```
Fleet → Start session (provider=kimi, model, repo)
  1 BinaryRegistry.resolve('kimi') → version ∈ cliVersionRange ? ok : Doctor case (M6-02)
  2 WorktreeManager.create(taskId)  (M1-03)
  3 launcher.preLaunchFiles() → daemon writes hooks + MCP config into the worktree (merged, backed up)
  4 launcher.interactive() → LaunchPlan → SessionSupervisor starts the pane in tmux (M1-02)
  5 optional: AcpClient.start() on the structured channel

permission round-trip
  kimi <tool-use hook> → orch-hook.mjs → POST /hooks/kimi/:sid/<hook>
    → KimiTelemetryParser.parse → NormalizedEvent prompt_opened{kind:'permission'}
    → M1-11 AgentPrompt (transport 'hook-response') → Attention → web/PWA
  user answers → PaneController.answerPrompt → receiver.respond(<decision JSON>) → hook exits → agent continues
  deadline passes → receiver responds with the manifest's defer/ask value → CLI shows its native prompt
                 → AgentPrompt stays open with transport 'send-keys-acked' (keystrokes from fixtures/keys.yaml)

rate limit
  stream/stderr/exit fixture → KimiRateLimitParser → RateLimitSignal{windowKind, resetAt|retryAfterMs, confidence}
    → M4-01 window → M4-03 cooling + reroute
```

## 5. Tasks
- [ ] Verify the Kimi Code surface against its docs and the installed CLI: hook names + payloads, ACP availability and method names, headless flags, skills/plugins directory and trust levels, session-log location, `--version` output, any quota/status command. Record findings in `README.md` and in the step log before writing code.
- [ ] Package scaffold: `packages/providers/kimi/` with `orchestra.plugin.json` (M10-03 format, `engines.orchestra`, `declares.egressHosts: []`, `declares.binaries: ["kimi"]`).
- [ ] `BinaryRegistry` entry + version parser + Fleet "not installed" hint; `features.providers.kimi` flag (default off).
- [ ] `KimiAuthProbe`: quota-free status command, status-only mapping, no credential-file reads; contract test for secret-shaped fields.
- [ ] `KimiLauncher.interactive` / `.headless` typed argv builders (documented flags only) + `preLaunchFiles` (hooks + MCP config, deep merge, backup).
- [ ] `bin/orch-hook.mjs` (dependency-free, ≤ 60 lines, timeout, non-blocking failure) + unit + integration tests against a stub receiver.
- [ ] `packages/sdk/src/transports/acp.ts` shared ACP client (Zod frames, ack-on-response, timeout → `AckTimeout`) + fuzz test.
- [ ] `KimiTelemetryParser`: Zod schema per hook kind, structured stream lines, session-log lines; unknown ⇒ `ParseError`; `sources()` declares `['hook','stream-json','session-log','acp']` as verified.
- [ ] `KimiRateLimitParser` over 429 / usage-limit fixtures; `confidence: 'official'` only when a reset timestamp is present.
- [ ] `KimiPaneController`: `sendCommand` with ack, `switchModel`, `answerPrompt` (hook-response / acp-response / send-keys-acked fallback with `fixtures/keys.yaml`).
- [ ] `KimiQuotaProbe` (only if a documented quota-free command exists; otherwise omit the member rather than guessing).
- [ ] `KimiSkillsInstaller` mapping Orchestra trust levels to Kimi's, refusing `untrusted`, writing only inside the worktree.
- [ ] Manifest v1 filled from the verification pass; command discovery for workspace custom commands (M2-03 mechanism).
- [ ] Record fixtures on the installed CLI with `orch fixtures record kimi` in `~/orchestra-scratch/`: one payload per hook kind, a headless run with a tool call and usage, an approval round-trip, a rate-limit sample (synthetic and marked if not reproducible), exit/stderr samples for auth-missing and model-not-found, `keys.yaml`; redaction pass; `RECORDED.md`.
- [ ] `defineAdapterContract(kimiAdapter, fixtures/<cliVersion>)` — all seven specs green; parser fuzz green.
- [ ] Catalog: `packages/catalog/models/kimi/*.yaml` profiles with `evidence: []` (no invented benchmark numbers) so the assignment engine can route to it.
- [ ] Add `kimi` to the CI fixtures matrix job (`fixtures-matrix.yml`) — fixtures only, never a real account (C9).
- [ ] Run the TC table on the real CLI; flip `features.providers.kimi` default only after it is green.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M10-04-01 | contract | all seven SDK contract specs against `fixtures/<cliVersion>` | pass; `manifest.contract.spec` confirms `cliVersionRange` matches `fixturesVersion` |
| UT-M10-04-01 | unit | permission hook fixture → `prompt_opened{kind:'permission'}` | tool name + input mapped; `answerTransport: 'hook-response'`; deadline from manifest |
| UT-M10-04-02 | unit | headless structured-output fixture → event sequence | golden: message → tool_call → tool_result → usage → exit |
| UT-M10-04-03 | unit | launcher argv (interactive + headless) | only binary + flags present in the manifest's `headless.flags` / documented interactive flags; cwd inside a worktree; no shell string |
| UT-M10-04-04 | unit | `preLaunchFiles` merge with an existing user hooks/MCP config | user entries preserved, ours appended, backup written, nothing outside the worktree |
| UT-M10-04-05 | unit | rate-limit fixtures (with and without a reset timestamp) | `RateLimitSignal` with `resetAt` and `confidence: 'official'`, else `retryAfterMs`/`estimate` |
| UT-M10-04-06 | unit | auth probe output mapping incl. logged-out fixture | `{loggedIn, plan?, accountLabel?}` only; no field matching `/token|secret|key|cookie|authorization/i` |
| UT-M10-04-07 | fuzz (fast-check) | telemetry parser over random JSON, truncated lines, unknown hook names, huge strings | never throws; always `Result.ok` or `ParseError`; no regex applied to PTY bytes (arch test) |
| UT-M10-04-08 | unit | ACP client: response, notification, timeout, malformed frame | ack on response; `AckTimeout` after the deadline; malformed frame ⇒ `UnknownPayload`, connection kept |
| IT-M10-04-01 | integration | `orch-hook.mjs` against a stub receiver (up and down) | posts the body, prints the response, exits 0; receiver down ⇒ non-blocking exit within 2 s |
| IT-M10-04-02 | integration | session lifecycle with a fake `kimi` binary in tmux (M1-02 fake) | pane starts, hooks flow, prompt opens and is answered, exit recorded; no daemon restart needed |
| E2E-M10-04-01 | e2e | Playwright: start a `FakeProvider`-scripted "kimi" session, answer a permission from the UI | prompt appears in Attention, answer acknowledged, session ends 0 |

### 6.2 Manual test cases (real Kimi Code, scratch repo `~/orchestra-scratch/`)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-04-01 | Detection and auth | 1. `features.providers.kimi: true`, restart. 2. Open Fleet. 3. `orch doctor --provider kimi`. | Binary detected with version inside `cliVersionRange`; auth row shows logged-in + plan label; no credential-shaped strings anywhere in logs or DB | ⬜ |
| TC-M10-04-02 | Interactive launch in a worktree | 1. Fleet → start a Kimi session. 2. Inspect the worktree. | Pane shows the Kimi TUI; hooks + MCP config written **inside** the worktree only; `~/` config untouched (diff before/after); `session.launched` event | ⬜ |
| TC-M10-04-03 | Permission round-trip from the web | 1. Ask Kimi to create `hello.txt`. 2. Answer *allow* from Attention. | Prompt appears within 1 s with the tool and path; allow is delivered through the declared transport; file created; tool-result event logged | ⬜ |
| TC-M10-04-04 | Permission round-trip from the phone | 1. Repeat TC-03, answer from the PWA (M7-03). | Push received, answer delivered, no double-answer (idempotent), audit row present | ⬜ |
| TC-M10-04-05 | Deadline fallback (negative-ish) | 1. Trigger a permission and do not answer past `deadlineMs`. | Daemon returns the manifest's defer/ask value, the CLI shows its native prompt, the `AgentPrompt` stays open with `send-keys-acked`; answering via the API then proceeds | ⬜ |
| TC-M10-04-06 | Headless run + model switch | 1. Quick Delegate a `boilerplate` task to Kimi. 2. Switch the model mid-session on an interactive one. | Headless output parsed to message/usage/exit 0; branch + diffstat collected; `/model`-equivalent acked and reflected in the TUI | ⬜ |
| TC-M10-04-07 | Rate limit (negative) | 1. Drive Kimi until a limit is hit, or replay the recorded 429 through the telemetry plane. | `RateLimitSignal` parsed, window shown on Fleet with *official*/*estimate* label, cooling until `resetAt`, one reroute, no retry storm (C5) | ⬜ |
| TC-M10-04-08 | **Negative: CLI version outside the manifest range** | 1. Pin `cliVersionRange` to a range excluding the installed version. 2. Restart and open Health. | Commands marked *unverified*, Doctor opens a `manifest-stale` RepairCase within 60 s, start-session warns; nothing crashes | ⬜ |
| TC-M10-04-09 | **Negative: not logged in / binary missing** | 1. Run with a separate `HOME` (logged out). 2. Rename the binary and restart. | Start refused with `AUTH_REQUIRED`; with the binary gone, Fleet shows *not installed* with an install hint and no session can be started; no stack traces | ⬜ |
| TC-M10-04-10 | Skills install with trust levels | 1. Install a trusted skill pack to a Kimi worktree; then attempt an `untrusted` one. | Trusted skill lands in the declared skills dir inside the worktree and appears in the Lead's `capabilities()`; untrusted is refused with a visible reason | ⬜ |
| TC-M10-04-11 | Cross-vendor review | 1. Run a small mission where Kimi implements and another vendor reviews. | Assignment engine picks a reviewer whose provider ≠ kimi; findings route back to the Kimi session; round completes | ⬜ |
| TC-M10-04-12 | Fixtures are the truth | 1. `pnpm --filter ./packages/providers/kimi test`. 2. Upgrade the CLI to the next release and re-run. | Contract suite green on the pinned fixtures; after the upgrade, any failure is a drift signal and produces a RepairCase rather than a silent pass | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All seven contract specs green on fixtures recorded from a real Kimi Code install; `RECORDED.md` states the CLI version, date, scenario and redaction applied.
- [ ] Permission, question and plan prompts round-trip on a real session from web **and** PWA through the declared transports, with the fallback proven (TC-03, TC-04, TC-05).
- [ ] Rate-limit parsing yields a usable window with an explicit *official* / *estimate* label (TC-07).
- [ ] Configuration is written only inside the worktree; the user's global Kimi configuration is byte-identical before and after a session (TC-02).
- [ ] The auth probe never returns or logs a secret-shaped field (UT-06, contract spec).
- [ ] Nothing outside `packages/providers/kimi`, the `BinaryRegistry` entry, the `ProviderId` union and `packages/catalog/models/kimi/` changed — verified by the PR diff; no `switch (provider)` added anywhere.
- [ ] Parser fuzz green; no regex is applied to PTY bytes (`no-pty-regex-state` clean).
- [ ] `kimi` is in the CI fixtures matrix and CI still holds no vendor credentials (C9).
- [ ] All TC-M10-04-01 … 12 pass and are recorded; `features.providers.kimi` defaulted on only afterwards.
- [ ] No new lint / dependency-cruiser violations.

## 8. Risks / open questions
- Every vendor fact in §4.2 and §4.4 is marked "(verify)" for a reason: hook event names, hook response schema, ACP method names and availability, headless flag spelling, skills directory and trust-level format, session-log location and quota/status command are all **to be verified against the Kimi Code documentation and the installed CLI at step start**. Fixtures become the source of truth once recorded; the manifest must not contain a value that no fixture demonstrates.
- If ACP is absent or unstable in the installed version, the adapter ships hook-response + `send-keys-acked` only and declares no `acp` feature; a later ACP arrival is a manifest change, not an adapter rewrite (M6-04 ladder 1 transport switch). Mirrors the Codex app-server decision (ADR-009).
- Kimi is an open-source CLI with faster release cadence than the commercial ones; expect `cliVersionRange` churn. The canary lane (M6-05) should cover it from day one.
- Quota semantics are undocumented in the plan (`local logs` only). If no official signal exists, `QuotaProbe` is omitted and forecasts for Kimi are labelled *estimate* with low confidence (R6 pattern), never presented as official.
- Licence / terms position: confirm that normal use of the official binary needs no in-product acknowledgement. If it does, mirror M1-07/C11 exactly and raise an ADR — do not improvise.
- Writing this adapter against the published SDK will expose gaps (missing types, unclear contract specs, harness ergonomics). Those are M10-03/M10-06 defects; record each one in the step log so the Plugin Author Guide can address it rather than papering over it in this package.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
