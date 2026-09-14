# Step M10-05 — OpenCode adapter

| Field | Value |
|---|---|
| Milestone | M10 — Ecosystem & 1.0 |
| Status | ⬜ Not started |
| Depends on | M2-03, M1-02, M1-04, M1-08, M1-11, M2-02, M4-01, M8-01 |
| Estimated effort | 2.5 days |
| Packages touched | `packages/providers/opencode`, `packages/catalog/models/opencode`, `apps/daemon/src/infrastructure/binaries`, `apps/web` (Fleet + Models copy) |
| Risk | Medium (R1 on the CLI surface; the multi-backend model story is the novel part) |
| Owner | |

## 1. Goal
`@orchestra/provider-opencode` (published as `orchestra-provider-opencode`) is **one adapter for every OpenAI-compatible backend** the user has already configured in the OpenCode CLI — DeepSeek, a local Ollama/vLLM endpoint, an enterprise gateway, anything the CLI itself supports. It implements the full `ProviderAdapter` over official surfaces: a quota-free `AuthProbe` that reports whether the CLI considers itself configured (never reading or echoing an API key), a `Launcher` for interactive PTY sessions and documented headless/JSON runs with hooks and MCP configured per worktree, a `TelemetryParser` for hook payloads, structured output and local logs, a `RateLimitParser` for 429/quota responses surfaced by the CLI, a `PaneController` with typed commands, model switch and prompt answering, and a manifest pinned to a recorded CLI version with fixtures. The available **models come from the user's own OpenCode configuration and from Orchestra's catalog layer — never from a vendor API call** (C2): Orchestra uses a verified credential-free provider projection or its documented list-models command, presents the result as selectable models with per-backend cost tiers the user sets, and routes to them through the normal assignment engine. Goose is documented as the alternate CLI for the same niche and deliberately not implemented.

## 2. Why
- **D5** — "adding Kimi/DeepSeek/next thing = one package"; this is the package that covers *the entire long tail* of API-backed models with a single adapter instead of one per vendor.
- **G2 / G4** — the cheapest capacity a developer owns is usually an API-key backend with no subscription window. Without this adapter the assignment engine can never spend it, so top-tier subscription quota keeps burning on boilerplate.
- **G7** — together with M10-04 it proves the plugin contract generalises beyond subscription CLIs, and it is the natural template for third-party adapters (M10-03 `examples/provider-plugin-template` points at it).
- **C2** — this is the adapter most at risk of "just call `/v1/models`". It must not. Orchestra code makes **zero** vendor API calls; model discovery is file- and CLI-based, and the `no-vendor-endpoints` ESLint rule plus the egress test are the enforcement.
- **C3 / C13** — API keys live in the user's OpenCode configuration or environment. Orchestra never reads, stores, forwards, logs or displays them; the auth probe returns a boolean and a label, and recordings are redacted at capture time.
- `05-provider-contract.md` §3 row "OpenCode (DeepSeek / any OpenAI-compatible)": *headless/JSON/MCP/hooks; hooks; local logs; one adapter covers all API-backed models (M10-05)*. Everything beyond that row is unverified and marked as such.

## 3. Scope
### In scope
- Package scaffold `packages/providers/opencode/` (`src/`, `manifest.json`, `fixtures/<cliVersion>/`, `README.md`, `orchestra.plugin.json` per M10-03).
- `OpenCodeAuthProbe`, `OpenCodeLauncher`, `OpenCodeTelemetryParser`, `OpenCodeRateLimitParser`, `OpenCodePaneController`, optional `OpenCodeQuotaProbe`.
- **Backend & model discovery from user configuration**: a `ModelSource` resolver that merges (a) a documented credential-free provider projection, (b) the CLI's documented list-models command if one exists, and (c) Orchestra's `opencode.backends` settings block — with precedence, hot reload on file change, and a clear provenance label per model in the UI.
- Per-backend cost tier, context window and capability dimensions authored by the user (or shipped as a `model-catalog` artifact via M10-03) so the assignment engine can score them.
- Fixture recording against at least two backends (one hosted, one local) + `RECORDED.md`; contract tests; parser fuzz.
- `BinaryRegistry` entry, `features.providers.opencode` flag (default off), Fleet + Models UI copy (EN + AR).
- A README section documenting Goose as the alternate CLI for this niche and why it is not implemented.
### Out of scope (deferred to …)
- Any direct HTTP call to an OpenAI-compatible endpoint from Orchestra code — **never**, at any milestone (C2).
- Managing, validating, rotating or storing API keys — never (C3). Orchestra only reports "configured / not configured" as the CLI itself reports it.
- A Goose adapter — post-1.0, and only as a separate plugin package; the design here must not special-case it.
- Per-backend billing/cost reporting in currency — M4 forecasts stay in the existing *official/estimate* window model; API-key backends usually have no window at all (see §4.1 rule B4).
- Publishing to npm with provenance — M10-07.
- Native worktree support: `WorktreeHooks.nativeFlag` stays empty.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new core entities. One value object local to the adapter and the catalog:

```ts
// packages/providers/opencode/src/backends.ts
export interface OpenCodeBackend {
  id: string;                     // user-chosen, stable, e.g. 'deepseek', 'local-vllm'
  label: string;
  source: 'provider-projection' | 'cli-list' | 'orchestra-settings';   // provenance, shown in the UI
  models: { id: string; label?: string; contextWindow?: number; costTier?: 1|2|3|4|5 }[];
  windowKind: 'none' | 'daily' | 'tokens';   // usually 'none' for pay-as-you-go keys
  configured: boolean;            // as reported by the CLI; NEVER derived from reading a key
}
```
Rules (pure, unit-tested):
- **B1 No credential-store reads.** Do not read OpenCode config files that may contain secrets, even if a later filter would discard them. Use a documented credential-free CLI/local-server projection or manually supplied non-secret Orchestra model metadata. If no safe projection exists, disable discovery and explain manual metadata entry.
- **B2 Provenance precedence.** `orchestra-settings` > `cli-list` > `opencode-config`; a model present in several sources keeps the highest-precedence metadata and lists all sources. Conflicting ids are never merged silently — the UI shows both origins.
- **B3 Unknown capability is unknown.** A model with no authored profile gets `dimensions` from the catalog default for its declared family or, failing that, a neutral profile flagged `unrated`; `unrated` models are selectable manually but the assignment engine never *prefers* them (score multiplier caps at the lowest rated peer) until outcomes exist (M8-06).
- **B4 No invented windows.** `windowKind: 'none'` ⇒ no forecast is shown; the Fleet card says "pay-as-you-go, no window" rather than an estimate. Only a 429 with a parsable reset produces a cooling period (C5).
- **B5 Model ids are namespaced** as `<backendId>/<modelId>` inside Orchestra so two backends can expose the same upstream model name without collision; the launcher maps back to whatever the CLI expects.

### 4.2 Interfaces / contracts
```ts
// packages/providers/opencode/src/index.ts
export const openCodeAdapter: ProviderAdapter = {
  id: 'opencode',
  manifest,                                   // ./manifest.json, Zod-validated at load; models are DYNAMIC (see below)
  auth: new OpenCodeAuthProbe(),
  launcher: new OpenCodeLauncher(),
  telemetry: new OpenCodeTelemetryParser(),
  rateLimit: new OpenCodeRateLimitParser(),
  pane: new OpenCodePaneController(),
  quota: undefined,                           // omitted unless a documented quota-free command exists (verify)
};

// Dynamic model discovery — the one place this adapter differs from claude/codex/agy/kimi
export interface ModelSource {
  /** Reads only a verified safe projection or manual metadata; no credential-store reads. */
  discover(ctx: HostContext): Promise<Result<OpenCodeBackend[], AdapterError>>;
  /** fs.watch on Orchestra metadata paths; debounced; emits on change so Models/Fleet update live. */
  watch(ctx: HostContext, onChange: () => void): () => void;
}
// The manifest declares `models: []` and `features: [... 'dynamicModels']`; M2-03's manifest schema treats an
// empty models array as valid ONLY when 'dynamicModels' is declared, and the ProviderRegistry then asks the
// adapter for its model list at session start and on change. Contract spec `manifest.contract.spec` enforces this.
```
Manifest excerpt (shapes fixed by the SDK schema; every "(verify)" value is confirmed against the OpenCode docs and the installed CLI at step start):
No illustrative hook/permission manifest is normative. Populate the SDK capability schema from the chosen version-pinned protocol, with every operation initially `unverified`; disable unsupported operations.
### 4.3 Data / schema changes
- `opencode` added to the `ProviderId` union (`packages/sdk`).
- Settings block `opencode.backends` (M8-01 layered, user/workspace/org): `{ id, label, models: [{ id, contextWindow?, costTier? }], windowKind }[]` — metadata only; a Zod refinement rejects any property that looks like a credential (B1).
- `packages/catalog/models/opencode/*.yaml`: profiles keyed by `<backendId>/<modelId>` with `evidence: []`; shipped examples are commented templates, not claims.
- No new table. `sessions.model` already stores a string; namespaced ids (B5) fit. `provider_windows` simply has no rows for `windowKind: 'none'` backends.
- Events: reuse `provider.models_changed` (M2-02) — emitted by `ModelSource.watch` so the Models screen and Fleet update without a restart.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Binary**: `opencode` added to `BinaryRegistry` with a version range and the documented `--version` parse; absent ⇒ provider `unavailable` with an install hint, never auto-installed (C1).
- **Network:** allow only the owned authenticated local OpenCode server control endpoint. Upstream model calls remain exclusively in the official CLI. Egress tests prove no direct upstream daemon traffic.
- **Model discovery:** verify the credential-free projection before use. No direct vendor configuration reads or raw secret-bearing configuration responses; watch only Orchestra metadata and safe provider model events.
- **Telemetry/control:** use the selected server API and its versioned event/permission schema; hooks are not assumed to exist.
- **Env allowlist**: `PATH`, `HOME`, `TERM`, `LANG` plus the backend-selection variables the manifest names. Credential variables are passed through **only** if the CLI requires them and the user has them in their own environment — the daemon never sets, reads back, logs or persists their values, and the redacting serializer covers them.
- **Local backends**: a local endpoint (Ollama/vLLM on `127.0.0.1`) is the recommended CI/demo configuration because it needs no key and no external network; the fixture-recording script defaults to it.
- **Rate limits**: OpenAI-compatible 429 bodies/headers surfaced by the CLI in its structured output are parsed into a `RateLimitSignal`; `Retry-After`-style hints map to `retryAfterMs` with `confidence: 'official'`, anything inferred is `estimate` (R6 pattern).

### 4.5 API / UI surface
- No new endpoints. `GET /api/providers/opencode/models` is the existing per-provider models route (M2-02) now served from `ModelSource`.
- Fleet (M1-10): one `opencode` provider row with a **backends** sub-list (label, provenance chip, configured ✓/✗, model count, "no window" badge).
- Models screen (M2-02): namespaced ids, provenance chip per model, `unrated` badge, inline editing of `costTier`/`contextWindow` writing to `opencode.backends`.
- Start-session dialog: backend picker → model picker; a `not configured` backend is disabled with the CLI's own reason as the tooltip.

### 4.6 Flow / sequence
```
boot / config change
  1 ModelSource.discover → read manifest.paths.configFile + documented list command (no network)
  2 B1 secret filter → B2 precedence merge with opencode.backends settings → B5 namespacing
  3 ProviderRegistry.setModels('opencode', …) → provider.models_changed → WS → Models + Fleet update
  4 fs.watch (debounced 300 ms) keeps this live; a malformed config keeps the last good list and shows a banner

start session (provider=opencode, model='deepseek/deepseek-chat')
  5 BinaryRegistry.resolve('opencode') → version check → worktree (M1-03)
  6 launcher.preLaunchFiles() → hooks + MCP config into the worktree (merged, backed up)
  7 launcher.interactive({ model: mapBack('deepseek/deepseek-chat') }) → SessionSupervisor → pane

permission round-trip   (identical shape to every other provider — D14)
  hook → orch-hook.mjs → POST /hooks/opencode/:sid/<hook> → TelemetryParser → AgentPrompt(kind=permission)
  answer from web/PWA → PaneController.answerPrompt → held hook response → agent continues
  deadline → manifest defer/ask value → native prompt → AgentPrompt stays open with send-keys-acked

429 from the backend, surfaced by the CLI
  → RateLimitParser → RateLimitSignal → M4-03 cooling until resetAt → one reroute to the next candidate
```

### 4.7 Review reconciliation contract (2026-09-15)
Assess the official local server API for sessions, messages, events and permission responses first. Permit authenticated local control traffic to the verified provider process; this is distinct from calling upstream model endpoints. Restrict endpoint discovery to the owned local session and reject arbitrary remote URLs. One adapter does not imply identical capabilities across configured backends. Record provider/version/mode/backend identity, source retrieval date, fixtures, limitations and acceptance outcomes in foundation 14. Contract success never establishes live vendor compatibility.

## 5. Tasks
- [ ] Verify the OpenCode surface against its docs and the installed CLI: server event/permission schemas, supported execution modes, safe model-projection schema, list-models command (if any), permission/approval modes, MCP config path, `--version` output, 429 surfacing. Record findings in `README.md` and the step log **before** writing code.
- [ ] Package scaffold + `orchestra.plugin.json` (`engines.orchestra`, `declares.egressHosts: []`, `declares.binaries: ["opencode"]`).
- [ ] `BinaryRegistry` entry + version parser; `features.providers.opencode` flag (default off); Fleet "not installed" hint.
- [ ] `ModelSource`: verified credential-free provider projection or manually supplied metadata, documented list command, B1 boundary guard, B2 precedence merge, B5 namespacing, `watch` with debounce.
- [ ] `opencode.backends` settings schema (Zod) with the credential-shaped-property refusal; Models screen inline editing writing back to the user layer.
- [ ] Manifest schema change in `packages/sdk`: allow `models: []` **only** with the `dynamicModels` feature; extend `manifest.contract.spec` accordingly (this is the one SDK change this step is allowed to make).
- [ ] `OpenCodeAuthProbe` (configured/not-configured, backend labels, no key reads) + no-secrets contract test.
- [ ] `OpenCodeLauncher.interactive` / `.headless` typed argv builders + `preLaunchFiles` (hooks + MCP into the worktree, deep merge, backup).
- [ ] Authenticated local server client + unit and stub-server integration tests.
- [ ] `OpenCodeTelemetryParser` (Zod per server event kind and supported structured output; unknown ⇒ `ParseError`).
- [ ] `OpenCodeRateLimitParser` (429 body/header shapes → `resetAt`/`retryAfterMs`, official vs estimate).
- [ ] `OpenCodePaneController` (sendCommand + ack, switchModel across backends, answerPrompt via documented permission response; unsupported operations manual-only).
- [ ] Record fixtures against **two** backends (one hosted pay-as-you-go, one local `127.0.0.1`) with `orch fixtures record opencode`: hook payloads, a headless JSON run with a tool call and usage, an approval round-trip, a 429 sample, auth-missing and model-not-found exits, `manual-mode-limitations.md`; redaction pass; `RECORDED.md` naming both backends and the CLI version.
- [ ] Catalog templates `packages/catalog/models/opencode/*.yaml` with `evidence: []` and a comment explaining that the user authors these.
- [ ] Contract suite `defineAdapterContract(openCodeAdapter, fixtures/<cliVersion>)` + parser fuzz + the dynamic-models manifest spec.
- [ ] Extend the M0-08 egress test with an `opencode` job: a full scripted session against a local stub backend ⇒ only authenticated local provider-control traffic, no upstream daemon calls.
- [ ] README: supported backend shapes, how to add one, why no key ever reaches Orchestra, and the Goose alternative note.
- [ ] Add `opencode` to `fixtures-matrix.yml` (fixtures only, C9); run the TC table; flip the feature flag default only after it is green.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M10-05-01 | contract | all seven SDK contract specs against `fixtures/<cliVersion>` | pass, including the dynamic-models variant of `manifest.contract.spec` |
| UT-M10-05-01 | unit | `ModelSource.discover` over config fixtures containing `api_key`, `authorization`, nested secrets | backends/models resolved; no secret-shaped property present in the output (deep scan); 100 % branch on B1 |
| UT-M10-05-02 | unit | B2 precedence: same model in config, list command and settings | highest-precedence metadata wins; all sources listed; conflicting ids surfaced, not merged |
| UT-M10-05-03 | unit | B3/B5: unrated model scoring and id namespacing/round-trip | `unrated` never preferred by the engine; `mapBack('deepseek/x') === 'x'` with the backend selected |
| UT-M10-05-04 | unit | B4: backend with `windowKind: 'none'` | no forecast produced; Fleet copy is "no window"; a 429 still creates a cooling period |
| UT-M10-05-05 | unit | launcher argv for a hosted and a local backend, interactive and headless | only documented flags; correct backend/model mapping; cwd inside a worktree; no shell string; no credential in argv or env dump |
| UT-M10-05-06 | unit | rate-limit fixtures with and without a retry hint | `official` + `retryAfterMs` vs `estimate`; never a fabricated `resetAt` |
| UT-M10-05-07 | unit | auth probe on configured / not-configured / partially-configured fixtures | `{loggedIn, plan?, accountLabel?}` only; reason text carries no key material |
| UT-M10-05-08 | fuzz (fast-check) | telemetry parser + config parser over random/truncated/huge inputs | never throws; `Result.err` only; parser never regexes PTY bytes (arch test) |
| IT-M10-05-01 | integration | config file edited on disk while the daemon runs | debounced reload; `provider.models_changed` emitted once; Models screen updates; a malformed edit keeps the last good list plus a banner |
| IT-M10-05-02 | integration | egress: scripted session against a local stub backend | **zero** outbound sockets from the daemon; a planted `fetch` to an OpenAI-compatible host fails lint and the egress job |
| IT-M10-05-03 | integration | session lifecycle with a fake `opencode` binary in tmux | pane starts, hooks flow, prompt opens and is answered, exit recorded |
| E2E-M10-05-01 | e2e | Playwright: pick a backend + model in the start dialog, run a scripted session, answer a permission | backend picker reflects the config; prompt answered from the UI; session ends 0 |

### 6.2 Manual test cases (real OpenCode CLI, scratch repo `~/orchestra-scratch/`)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M10-05-01 | Discovery from the user's own config | 1. Configure two backends in OpenCode (one hosted, one local). 2. `features.providers.opencode: true`, restart. 3. Open Fleet and Models. | Both backends listed with provenance chips and their models; configured ✓; no network call made by the daemon (verify with a local proxy or `lsof`) | ⬜ |
| TC-M10-05-02 | **Negative: no key reaches Orchestra** | 1. Put a real API key in the OpenCode config and in the environment. 2. Run a session. 3. `grep -ri "<key prefix>" ~/.orchestra/orchestra.db ~/.orchestra/logs ~/.orchestra/recordings` and the `/api/providers/opencode/models` response. | Zero hits anywhere; the models response contains labels and ids only; recordings are redacted at capture time | ⬜ |
| TC-M10-05-03 | Live config change | 1. With the daemon running, add a third backend to the OpenCode config. | Models and Fleet update within ~1 s without a restart; one `provider.models_changed` event; running sessions untouched | ⬜ |
| TC-M10-05-04 | Interactive session + permission round-trip | 1. Start a session on the local backend. 2. Ask it to create a file. 3. Answer *allow* from Attention, then repeat and answer from the PWA. | Prompt within 1 s with the tool and path; both answers delivered through the declared transport; file created; no double-answer | ⬜ |
| TC-M10-05-05 | Deadline fallback | 1. Trigger a permission; do not answer past `deadlineMs`. | Native prompt appears; the `AgentPrompt` stays open with `send-keys-acked`; answering via the API proceeds | ⬜ |
| TC-M10-05-06 | Headless + routing | 1. Quick Delegate a `boilerplate` task with auto-assign enabled and a cheap backend configured. | The engine picks the opencode backend with reasons citing cost tier; headless JSON parsed to message/usage/exit 0; branch + diffstat collected | ⬜ |
| TC-M10-05-07 | Model switch across backends | 1. In one session, switch from the hosted model to the local one. | `switchModel` acked; the pane reflects the change; the event records both namespaced ids; no session restart | ⬜ |
| TC-M10-05-08 | **Negative: 429 from the backend** | 1. Drive the hosted backend into a 429 (or replay the recorded fixture). | Signal parsed with *official* label when a retry hint exists; cooling until the hint expires; exactly one reroute; no retry storm (C5) | ⬜ |
| TC-M10-05-09 | **Negative: backend not configured / bad endpoint** | 1. Point a backend at an unreachable endpoint and start a session. | Session fails with a typed error surfaced in the UI; `AUTH_REQUIRED`/`ProviderUnavailable` as appropriate; no stack trace; no key in the message; Doctor stays calm (not a drift case) | ⬜ |
| TC-M10-05-10 | **Negative: malformed config file** | 1. Break the OpenCode config syntax while the daemon runs. | Last good model list stays active; banner names the file; no crash; fixing the file restores discovery | ⬜ |
| TC-M10-05-11 | **Negative: CLI version outside the manifest range** | 1. Pin `cliVersionRange` to exclude the installed version. 2. Restart; open Health. | Commands marked *unverified*; `manifest-stale` RepairCase within 60 s; start-session warns | ⬜ |
| TC-M10-05-12 | Cross-vendor review with an API-backed author | 1. Run a small mission where an opencode model implements and a subscription CLI reviews. | Reviewer provider ≠ opencode; findings route back; round completes; routing decision lists cost-tier reasoning | ⬜ |

### 6.3 Review regression scenarios
- [ ] An unsupported prompt kind disables only that feature.
- [ ] Real protocol fixtures drive positive/negative permission tests.
- [ ] Backend/model change cannot inherit an unverified capability.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] All seven contract specs green on fixtures recorded from **two** different backends; `RECORDED.md` names the CLI version, both backends, date and redaction.
- [ ] The daemon makes zero outbound connections during a full OpenCode session (IT-02, TC-01) — the adapter contains no HTTP client at all.
- [ ] No API key, token or credential-shaped string exists anywhere in the DB, logs, recordings, API responses or argv (TC-02, UT-01, UT-07).
- [ ] Model discovery comes only from the user's configuration and documented CLI output, is hot-reloaded on change, and shows provenance per model (TC-01, TC-03).
- [ ] A backend without a window shows "no window" and never a fabricated forecast; a 429 still produces cooling (UT-04, TC-08).
- [ ] Prompts round-trip from web and PWA with the fallback proven (TC-04, TC-05).
- [ ] The only change outside `packages/providers/opencode` and `packages/catalog/models/opencode/` is the `dynamicModels` manifest rule in `packages/sdk`, the `BinaryRegistry` entry and the `ProviderId` union; no `switch (provider)` anywhere.
- [ ] Parser and config fuzz green; `no-pty-regex-state` and `no-vendor-endpoints` clean; egress job extended.
- [ ] README documents the Goose alternative and the "no key ever reaches Orchestra" guarantee.
- [ ] All TC-M10-05-01 … 12 pass and are recorded; no new lint / dependency-cruiser violations.

## 8. Risks / open questions
- Hook names, headless flag spelling, config file location and schema, the list-models command, approval modes and MCP config path are all **to be verified against the OpenCode documentation and the installed CLI at step start**. The manifest must contain no value that a recorded fixture does not demonstrate.
- The temptation to call `/v1/models` for discovery will recur in review; the ESLint rule and the egress test make it fail the build, and this risk line exists so the reason is recorded: C2 is about *Orchestra* never being a client of a model API, regardless of whose key it would use.
- OpenAI-compatible backends differ in their 429 shapes and in whether the CLI surfaces headers at all; forecasts for these backends will often be absent. B4 makes absence the honest default rather than an estimate (R6).
- Capability profiles for arbitrary user-configured models cannot be shipped credibly; `unrated` (B3) plus the M8-06 learning loop is the answer. Resist populating `dimensions` with guesses — a wrong profile silently misroutes work (G2).
- If the CLI stores backend config in multiple files or a directory, precedence (B2) may need refinement after the verification pass; keep the resolver's rules in one pure function so the change is a unit-test edit.
- A user pointing a "local" backend at a remote host is their choice and outside our controls; the UI shows the endpoint's *label* only and never resolves or validates it.
- Goose overlaps this niche and may be requested. It belongs in a separate plugin package once M10-03 lands (that is the whole point of the registry); adding a second CLI to this adapter would re-create the `switch (provider)` pattern the architecture forbids.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
