# Step M2-03 — Capability manifests v1 (full)

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M1-05, M1-06 (∥ with M2-01/M2-02); M1-07 only if the optional agy adapter is enabled |
| Estimated effort | 2.5 days |
| Packages touched | `packages/sdk`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, `apps/daemon` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step each of the required adapters (`claude`, `codex`) plus any enabled optional adapter ships a complete `CapabilityManifest` (`05-provider-contract.md §2`): full `models[]`, `limits`, `features[]`, `sandboxProfiles[]`, native `commands[]` with transport/effects/approval/ackEvent, a `promptProtocol` **capability record per prompt kind** (state, execution mode, request source, answer transport, ack source, reachable answer states), `headless` flags, `paths`, `updateSources`, and `cliVersionRange` pinned to the versions in `ENVIRONMENT.md`. Prompt support is **conditional, not universal**: a kind that exposes neither a structured request nor a supported answer channel is declared `manual-only` and the UI says so instead of pretending it can be answered remotely. A `CommandsDiscovery` service merges workspace custom commands and skills into the session's command list at session start. New contract specs make a *missing or malformed record* a failing test — they do not make an unproven capability `verified`.

## 2. Why
- D5: core knows no vendor; everything the engine (M2-04), Chat palette (M2-08) and MCP `capabilities()` (M2-05) need must be declared in the manifest.
- D6 / G6: `updateSources` and `cliVersionRange` are the inputs for release watchers (M6-05) and drift detection (M6-02).
- D14: `promptProtocol` per kind is what makes a prompt answerable through a *typed* transport where one exists, and what makes the absence of one explicit (`manual-only`) rather than silently degraded. `send-keys-acked` is a declared fallback only where a documented ack event exists for that provider + mode; otherwise a send-keys answer can only end in `delivery_uncertain` (M1-11 answer states), which is not an answer channel.
- Capability states (`verified | limited | manual-only | unsupported | unverified`, `00-foundations/14-provider-evidence-matrix.md`, `05 §2`) are keyed by **provider + CLI version + execution mode**. An `unsupported`/`unverified` prompt kind disables remote answering *for that kind* — it never invalidates the provider.
- C1, C8: commands and headless flags are typed data verified by contract tests, never ad-hoc strings.

## 3. Scope
### In scope
- Complete `manifest.json` for `claude` and `codex` (fields in §4.2), plus `agy` only when the optional adapter is enabled (M1-07; ADR-008 amended gates it), each with `manifestVersion` bumped to `1.0.0`.
- SDK schema additions: `TypedCommandSchema` (args as JSON-Schema-like Zod descriptor), `PromptProtocolSchema`, `UpdateSourcesSchema`; `CapabilityFlag` enum finalised.
- `CommandsDiscovery` (adapter-side, in `packages/providers/<id>/src/commands-discovery.ts`) reading `manifest.paths.commandsDir` / `skillsDir` from the worktree and user home; merge with `origin: native|workspace|user`.
- Daemon: `SessionCommandsRegistry` populated at session start; `GET /api/sessions/:id/commands`; event `session.commands_discovered`.
- Contract specs: `commands-discovery.contract.spec.ts`, `prompt-protocol.contract.spec.ts`, extended `manifest.contract.spec.ts`.
- Unverified marking: CLI version outside `cliVersionRange` ⇒ every command `verified: false` and every `promptProtocol.kinds[*].state` downgraded to `unverified` (Doctor consumes in M6-02).
- `manual-only` UI affordance: Attention + Chat render an "answer in the terminal" card for kinds without a supported answer channel (§4.5).
### Out of scope (deferred to …)
- Promoting any capability record to `verified` — that happens only via an M0-09 evidence-matrix row recorded against a real CLI; this step ships the records and their declared states.
- Fetching signed manifests from a registry and rollback → M6-03.
- Release feed polling and canary verification → M6-05.
- Skills installation and trust levels (only *listing* skills here) → M8-04.
- Kimi and OpenCode manifests → M10-04, M10-05.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `TypedCommand` rules: `transport ∈ {keys, rpc, slash}`; `effects ⊆ {none, reads-fs, writes-fs, spends-quota, changes-model, exits}`; `approval ∈ {none, confirm}` — any command with `writes-fs` or `spends-quota` must be `approval: confirm` (C10, zero-surprise); `ackEvent` is a `NormalizedEvent` type name or `none` (UI shows *sent, no ack available*).
- `PromptProtocol` rules (conditional support, review §4.1):
  - Every `PromptKind` (`permission question planApproval confirm login error`) has **a capability record**, not necessarily a transport. The record is keyed by `provider + cliVersionRange + executionMode` (`interactive-pty | headless | app-server | acp | wire`) and carries `state ∈ {verified, limited, manual-only, unsupported, unverified}`.
  - `requestSource ∈ {hook, app-server-rpc, stream-json, mcp-elicitation, none}` says whether Orchestra learns about the prompt through a structured channel. `requestSource: 'none'` ⇒ the kind can be detected only by looking at the pane, which is not a contract (C7) ⇒ `state: 'manual-only'`.
  - `answerTransport` (`hook-response | permission-tool | app-server-rpc | elicitation | send-keys-acked`) is **optional**. Absent ⇒ no supported answer channel ⇒ `state: 'manual-only'`.
  - `ackSource` is mandatory wherever `answerTransport` is present: `{ kind: 'hook-response' | 'rpc-response' | 'mcp-result' | 'event', event?: <NormalizedEvent type> }`. It is the *only* thing that may move a prompt to `acknowledged` (M1-11 answer states). Echoed text in the transcript, a later unrelated assistant message, or the process simply continuing are explicitly not acks.
  - `reachableStates ⊆ {pending, submitted, acknowledged, expired, cancelled, delivery_uncertain}` is declared per kind and asserted by the contract spec: a kind whose `ackSource` is absent may not declare `acknowledged` reachable; a `send-keys-acked` kind without a documented ack event may not either, and its answers terminate in `delivery_uncertain`.
  - A `fallback.keys` map (from `fixtures/<ver>/keys/*.yaml`) **exists only where a documented ack event is declared for that provider + mode**. No ack event ⇒ no fallback map is authored; the kind stays `manual-only` rather than shipping a key sequence that cannot be confirmed. This replaces the earlier rule that every non-send-keys kind must carry a keys fallback.
  - `evidence: { source: 'vendor-docs' | 'evidence-matrix', ref, checkedAt }` is mandatory on every record. `state: 'verified'` is legal **only** when `source === 'evidence-matrix'` and the referenced M0-09 row exists; anything backed by docs alone is at most `limited` and is authored as `unverified` until M0-09 records the real-CLI check.
- `cliVersionRange` must contain `fixturesVersion`; the daemon computes `inVersionRange = semver.satisfies(detectedCliVersion, cliVersionRange)` (via `BinaryRegistry`, M1-04). Out of range ⇒ commands `verified: false` and every prompt-kind state downgraded to `unverified`. In range does **not** upgrade a state — a record's state comes from the manifest + evidence matrix, never from the version check alone.
- Discovered commands never override native ones with the same name; collision ⇒ discovered command renamed `<name> (workspace)` and a warning event.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/manifest.ts (additions)
export interface TypedCommand {
  name: string; label: string; description?: string;
  args: CommandArg[];                                  // {name, type: 'string'|'enum'|'model'|'path'|'number', required, enum?: string[]}
  transport: 'keys' | 'rpc' | 'slash';
  effects: CommandEffect[];
  approval: 'none' | 'confirm';
  ackEvent: string | 'none';                           // normalized event type that confirms receipt
  origin?: 'native' | 'workspace' | 'user';            // set by discovery, absent in manifest.json
  verified?: boolean;                                  // set by daemon from cliVersionRange
}
export type CapabilityState = 'verified' | 'limited' | 'manual-only' | 'unsupported' | 'unverified';
export type ExecutionMode  = 'interactive-pty' | 'headless' | 'app-server' | 'acp' | 'wire';
export type PromptAnswerState = 'pending' | 'submitted' | 'acknowledged' | 'expired' | 'cancelled' | 'delivery_uncertain';

export interface AckSource { kind: 'hook-response' | 'rpc-response' | 'mcp-result' | 'event'; event?: string; }

export interface PromptKindSupport {
  state: CapabilityState;                    // keyed by provider + cliVersionRange + executionMode
  executionMode: ExecutionMode;
  requestSource: 'hook' | 'app-server-rpc' | 'stream-json' | 'mcp-elicitation' | 'none';
  answerTransport?: AnswerTransport;         // absent ⇒ no supported answer channel ⇒ manual-only
  ackSource?: AckSource;                     // required iff answerTransport is present; only this moves a prompt to `acknowledged`
  reachableStates: PromptAnswerState[];      // asserted against answerTransport/ackSource by CT-M2-03-03
  fallback?: { keys: Record<string, string>; ackSource: AckSource };  // authored only where a documented ack event exists
  timeoutMs: number;                         // on expiry the prompt becomes `expired`, not `acknowledged`
  evidence: { source: 'vendor-docs' | 'evidence-matrix'; ref: string; checkedAt: string };
}
export interface PromptProtocol {
  // Partial on purpose: a kind a provider does not expose is declared `unsupported`, or omitted and
  // defaulted to `{ state: 'unverified', requestSource: 'none' }` by the loader — never assumed answerable.
  kinds: Partial<Record<PromptKind, PromptKindSupport>>;
}
export interface UpdateSources { releases: string; changelog?: string; docs?: string; }  // https URLs, read by M6-05 only

// packages/sdk/src/commands-discovery.ts
export interface CommandsDiscovery {
  discover(ctx: { worktreePath: string; homeDir: string }): Promise<Result<TypedCommand[], AdapterError>>;
}
// packages/core ports
export interface ManifestPort { get(provider: ProviderId): Result<CapabilityManifestView, ProviderUnknown>; all(): CapabilityManifestView[]; }
// CapabilityManifestView = manifest + { detectedCliVersion, verified } — core-safe shape (no sdk import)
```
Per-provider content to author (facts from `05 §3` only; everything marked *(verify)* is checked against the vendor docs at step start):

| Field | claude (required) | codex (required) | agy (optional, only if enabled) |
|---|---|---|---|
| `cliVersionRange` | `>=2.1.216 <2.2.0` | version installed in M1-06, from ENVIRONMENT.md log *(verify)* | `>=1.2.1 <1.3.0` |
| `features` | subagents hooks mcp skills planMode sandbox streamJsonInput elicitation vision websearch *(verify list)* | appServer sandbox mcp hooks *(verify)* | hooks mcp streamJsonInput *(verify)* |
| `sandboxProfiles` | permission modes *(verify names)* | `read-only`, `workspace-write`, `full` | `request-review`, `always-proceed` |
| `commands` (native) | `prompt`, `model`, `clear`, `compact`, `help`, plan-mode toggle *(verify)* — transport `keys`/`slash` | `prompt` (`turn/start` rpc), `model` (rpc), `approve/deny` (rpc) *(verify method names against generated schema)* | `prompt` (stream-json stdin), `usage` (`/usage`), `credits` *(verify)* |
| `promptProtocol` (capability record per kind; all states authored `unverified` until an M0-09 row exists) | permission / question / planApproval → `requestSource: hook` with `answerTransport: hook-response` + `ackSource: hook-response`, mode `interactive-pty` — note these are **tools** handled through hooks (e.g. `PreToolUse`) and a programmatic answer needs the correct `updatedInput` payload; the headless record is separate and needs a permission host *(verify against Claude Code hooks docs at step start, M0-09)*. login / error → `requestSource: none`, no `answerTransport` ⇒ `manual-only`. | permission → `requestSource: app-server-rpc`, `answerTransport: app-server-rpc` (`requestApproval`, `execCommandApproval`, `applyPatchApproval`), `ackSource: rpc-response`, mode `app-server` *(verify method names against the pinned generated schema)*. `exec` mode is a **separate record set**. Kinds with no documented rpc ⇒ `manual-only`. | permission → *(verify)*; headless docs reject `control_request`/`control_response` input events, so no generic control protocol is assumed. Every kind ships `unverified` or `manual-only` until ADR-008's terms resolution and an M0-09 row exist. |
| `headless` | `-p`, `--input-format stream-json`, `--output-format stream-json` | `exec --json --output-schema` | `-p --input-format stream-json --output-format stream-json` |
| `paths` | `CLAUDE.md`, `.claude/skills`, `.claude/commands`, hooks + mcp config *(verify)* | `AGENTS.md`, skills dir *(verify)*, mcp config *(verify)* | instruction file, `.agents/skills`, mcp config files *(verify)* |
| `updateSources` | official releases + changelog + docs URLs *(verify)* | same *(verify)* | same *(verify)* |
| `tos` | — | — | `requiresAcknowledgement: true`, url *(verify)* |

### 4.3 Data / schema changes
- `providers.manifest_version` (existing) now written from `manifestVersion`; add column `commands_verified BOOLEAN` (migration `m2_03_providers_verified`).
- Event `session.commands_discovered {sessionId, counts:{native,workspace,user}, collisions[]}` (new type; extension of `04 §3`).
- No new tables; the merged per-session command list lives in memory (`SessionCommandsRegistry`) and is rebuilt on restart from the worktree path in `sessions`.

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- Discovery reads only the filesystem (worktree + `$HOME` subpaths named by `manifest.paths`); no process spawn, no network (C2). File reads capped at 64 KB each, max 200 entries per dir.
- Front-matter parsing for skill/command files is best-effort: a file that fails to parse is listed with `description: undefined`, never dropped.
- Executed in `SessionSupervisor.start()` after worktree creation and before launch (so the Chat palette is ready at first frame); on restart re-run for every `running` session during reconcile (M1-02).
- Manifests remain JSON files in each provider package; hot reload via the existing `ManifestLoader` (M0-03) watcher.

### 4.5 API / UI surface
- `GET /api/providers/:id/manifest` (exists from M1-04/10) now returns the full manifest incl. `verified` and `detectedCliVersion`.
- `GET /api/sessions/:id/commands` → `{ commands: TypedCommand[], discoveredAt }` (used by M2-08).
- Fleet screen: provider row gains "manifest 1.0.0 · verified ✓ / unverified (cli 2.3.0 ∉ range)" text, plus a per-prompt-kind support chip row (`permission verified · question limited · login manual-only`) sourced from `promptProtocol.kinds[*].state`.
- **`manual-only` card** (shared component in `packages/ui`, consumed by Attention (M1-11) and Chat (M2-08)): when a prompt's kind record has no `answerTransport`, the UI renders "This provider has no supported answer channel for this prompt — answer in the terminal" with a *Open pane* action and the reason (`requestSource: none` / `no ack event documented` / `state: unverified`). No answer form and no send-keys button is offered for that kind; the prompt's answer state stays `pending` until the agent moves on, then `expired`.
- No new screen.

### 4.6 Flow / sequence
```
StartSession ─▶ worktree ready ─▶ adapter.commandsDiscovery.discover({worktree, home})
   ─▶ merge(manifest.commands (origin native) ∪ discovered) with collision rule
   ─▶ mark verified per cliVersionRange ─▶ SessionCommandsRegistry.set(sessionId, list)
   ─▶ emit session.commands_discovered ─▶ launch
Chat (M2-08) ─▶ GET /api/sessions/:id/commands ─▶ palette
```

## 5. Tasks
- [ ] Finalise `CapabilityFlag`, `CommandEffect`, `PromptKind`, `AnswerTransport` enums in `packages/sdk` (+ core-safe mirrors) and regenerate JSON Schema.
- [ ] Extend `manifest.ts` Zod schema: `TypedCommandSchema`, `PromptProtocolSchema` (incl. `CapabilityState`, `ExecutionMode`, `AckSource`, `reachableStates`, `evidence`), `UpdateSourcesSchema`, `tos`; add refinements from §4.1 — `answerTransport ⇒ ackSource`, `fallback ⇒ fallback.ackSource`, `!answerTransport ⇒ state === 'manual-only' | 'unsupported'`, `state === 'verified' ⇒ evidence.source === 'evidence-matrix'`, `acknowledged ∈ reachableStates ⇒ ackSource present`.
- [ ] Loader default: a `PromptKind` absent from `promptProtocol.kinds` materialises as `{ state: 'unverified', requestSource: 'none', reachableStates: ['pending','expired','cancelled'] }` — absence is never read as support.
- [ ] `packages/ui`: `ManualOnlyPromptCard` + the Fleet per-kind support chips (§4.5); wire into Attention (M1-11) and leave the Chat hook for M2-08.
- [ ] Record/refresh fixtures on the pinned CLI versions (`orch fixtures record`, M1-08) for the required adapters (claude, codex) plus any enabled optional adapter; record `keys/*.yaml` **only** for kinds whose record declares a documented ack event. Update each `RECORDED.md` with the kinds that were left `manual-only` and why.
- [ ] Author `packages/providers/claude/manifest.json` v1.0.0 (table above); verify every *(verify)* item against docs and note sources in the provider README.
- [ ] Author `packages/providers/codex/manifest.json` v1.0.0; regenerate app-server schema fixture (`codex app-server generate-json-schema`) and reference rpc method names from it.
- [ ] *(only when the optional agy adapter is enabled — ADR-008 amended requires a recorded terms resolution and an M0-09 row first)* Author `packages/providers/agy/manifest.json` v1.0.0 incl. `tos` block; confirm the ToS acknowledgement flow (M1-07) reads `tos.url` from the manifest. This task is skippable; nothing in M2 blocks on it.
- [ ] Implement `CommandsDiscovery` per provider (shared helper in `packages/sdk/src/discovery/fs-commands.ts` for front-matter parsing) + FakeProvider discovery over `fixtures/workspace/`.
- [ ] Daemon: `SessionCommandsRegistry`, hook into `SessionSupervisor.start()` and reconcile; emit `session.commands_discovered`.
- [ ] Daemon: compute `verified` from `BinaryRegistry` version; migration for `providers.commands_verified`; Fleet row text.
- [ ] Contract specs: extend `manifest.contract.spec.ts`; add `commands-discovery.contract.spec.ts` and `prompt-protocol.contract.spec.ts` to the SDK harness so every adapter (incl. FakeProvider) runs them.
- [ ] `GET /api/sessions/:id/commands` controller + OpenAPI.
- [ ] Update `docs/plugin-guide` draft: "Manifest v1 field reference" (used by M10-06).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M2-03-01 | contract | `manifest.contract.spec.ts` on each provider | validates; `models` non-empty; `fixturesVersion` satisfies `cliVersionRange`; `updateSources.releases` is https |
| CT-M2-03-02 | contract | every command with `writes-fs`/`spends-quota` effect | `approval === 'confirm'` |
| CT-M2-03-03 | contract | `prompt-protocol.contract.spec.ts` — **record presence and shape**, per `provider + cliVersionRange + executionMode` | every `PromptKind` resolves to a record (authored or loader-defaulted) with a legal `state`, `requestSource`, `reachableStates` and `evidence`; `answerTransport ⇒ ackSource`; `fallback ⇒ fallback.ackSource` and a fixture under `keys/`; a kind with no `answerTransport` is `manual-only`/`unsupported`. The spec **asserts the record, it never sets or promotes a state** |
| CT-M2-03-03a | contract | same spec run against `FakeProvider` and against fixture-backed adapters | no record ends the run at `state: 'verified'`; any record whose `evidence.source !== 'evidence-matrix'` that claims `verified` fails the spec. Passing on fixtures proves the manifest is well-formed, not that the CLI behaves that way |
| CT-M2-03-03b | contract | kind declaring `answerTransport: 'send-keys-acked'` with no documented ack event | spec fails; the authored manifest must instead declare `manual-only` (and `delivery_uncertain ∈ reachableStates` where keys are still offered as an explicit user-driven escape hatch) |
| CT-M2-03-04 | contract | `commands-discovery.contract.spec.ts` with fixture workspace containing 2 custom commands + 1 skill, one colliding with a native name | 3 discovered, collision renamed, warning present, native list untouched |
| UT-M2-03-01 | unit | front-matter parser on malformed file | entry kept with `description: undefined`; no throw |
| UT-M2-03-02 | unit | version inside/outside `cliVersionRange` | inside: commands `verified: true`, prompt-kind states unchanged (no upgrade). outside: commands `verified: false`, every prompt-kind state downgraded to `unverified` |
| UT-M2-03-03 | unit | loader default for an omitted `PromptKind` | `{ state: 'unverified', requestSource: 'none' }`; `acknowledged ∉ reachableStates` |
| UT-M2-03-04 | unit | answer-state machine fed a transcript echo of the answer text with no `ackSource` event | stays `submitted`, then `delivery_uncertain`/`expired` at `timeoutMs`; never `acknowledged` |
| IT-M2-03-01 | integration | start FakeProvider session in temp worktree with custom commands | `session.commands_discovered` emitted before `session.launched`; `GET /commands` lists them |
| IT-M2-03-02 | integration | restart daemon with a running session | registry rebuilt for that session during reconcile |
| IT-M2-03-03 | integration | FakeProvider session raising a prompt of a `manual-only` kind | Attention + Chat render the `ManualOnlyPromptCard` with the reason; no answer form, no send-keys control; API refuses an answer POST for that kind with `Err(PromptKindManualOnly)` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-03-01 | Manifests load on real CLIs | 1. Start daemon 2. Open Fleet | claude and codex rows (plus any enabled optional adapter) show `manifest 1.0.0` with the detected CLI version and the per-kind support chips; a kind shows `verified` only where an M0-09 evidence-matrix row backs it, otherwise `limited` / `unverified` / `manual-only` | ⬜ |
| TC-M2-03-02 | Workspace command discovery (Claude) | 1. In `~/orchestra-scratch` add a custom command file under the manifest's `commandsDir` named `orch-hello` 2. Start an interactive Claude session from Fleet 3. `GET /api/sessions/:id/commands` | List contains `orch-hello` with `origin: workspace` plus native commands; event visible in the WS stream | ⬜ |
| TC-M2-03-03 | `manual-only` prompt kind | 1. Start a Claude session 2. Force a `login`-kind prompt (e.g. run with a temporarily logged-out profile) 3. Open Attention | The item renders the "answer in the terminal" card with the reason (`requestSource: none`); no answer form is offered; opening the pane and answering there clears the item. No answer state is reported as `acknowledged` | ⬜ |
| TC-M2-03-07 | Structured prompt kind round-trip | 1. Start a Claude session 2. Trigger a `permission`-kind prompt (ask the agent to run `ls`) 3. Answer from Attention | The answer goes through the declared `answerTransport` and the prompt reaches `acknowledged` only when the declared `ackSource` arrives; the recorded transport/ack pair matches the manifest record. If the `updatedInput` payload shape differs from the manifest, the record is corrected and the row is logged for the M0-09 matrix | ⬜ |
| TC-M2-03-08 | Negative: no ack, no upgrade | 1. Pick a kind whose record declares `send-keys-acked` with an ack event 2. Answer it 3. Kill the provider before the ack event arrives | The prompt ends `delivery_uncertain` (not `acknowledged`, not `failed`); Attention shows the uncertain badge and the reason | ⬜ |
| TC-M2-03-04 | Negative: version outside range | 1. Temporarily set `cliVersionRange` to `>=9.0.0` in the claude manifest 2. Restart daemon | Fleet row shows *unverified*; `GET /commands` for a new session has `verified: false` on every command; no crash. Revert. | ⬜ |
| TC-M2-03-05 | Codex commands over app-server | 1. Start a Codex session 2. `GET /commands` | `prompt` and `model` commands have `transport: rpc` and an `ackEvent`; rpc method names match the pinned schema fixture | ⬜ |
| TC-M2-03-06 | Restart / resilience | 1. With TC-03-02 session running, `kill -9` daemon 2. Restart | Session reconciled; `GET /commands` returns the same list including `orch-hello` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] The required manifests (claude, codex) — plus any enabled optional adapter — validate at `manifestVersion 1.0.0` and pass CT-M2-03-01…04 on fixtures recorded from the pinned CLI versions. Nothing in this step blocks on the optional adapter.
- [ ] Every `PromptKind` resolves to a **capability record** for each provider + execution mode, with `state`, `requestSource`, `reachableStates` and `evidence`; kinds with a supported answer channel additionally have an `ackSource` and a fixture round-trip (extends `prompt.contract.spec.ts` from M0-03). Kinds without one are declared `manual-only`, and that is a passing outcome.
- [ ] No capability record is `verified` unless an M0-09 evidence-matrix row backs it; a green FakeProvider/fixture run leaves states untouched (CT-M2-03-03a).
- [ ] A `send-keys` fallback map exists only for kinds with a documented ack event; every other send-keys answer path is declared to end in `delivery_uncertain` (CT-M2-03-03b, TC-M2-03-08).
- [ ] The `manual-only` "answer in the terminal" card is rendered in Attention for every such kind and the answer API refuses those kinds (IT-M2-03-03, TC-M2-03-03).
- [ ] Workspace commands appear in `GET /api/sessions/:id/commands` before the session's first output on real Claude Code.
- [ ] Version-range check computed correctly and shown in Fleet; out-of-range downgrades prompt-kind states to `unverified` and marks commands unverified, and an unverified capability disables only the affected feature — it never blocks a session or invalidates the provider (Doctor handles it in M6).
- [ ] No adapter imports another adapter or the daemon (dependency-cruiser).
- [ ] Every *(verify)* item in §4.2 resolved and its source URL noted in the provider README.
- [ ] All TC-M2-03-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- ENVIRONMENT.md lists Codex as a broken install with no version; the range cannot be pinned until M1-06 records the installed version *(verify at step start)*.
- Codex rpc method names for prompt/model/approvals come from the generated app-server schema (ADR-009); if the schema changes, CT-M2-03-05-related assertions fail by design (R3).
- Claude command/skill directory conventions and permission-mode names are not in `05 §3` — *(verify against Claude Code docs at step start)*; same for agy instruction-file name and MCP config locations *(verify against Antigravity docs)*.
- `AskUserQuestion` / `ExitPlanMode` are **tools** reached through hooks, not hook event names, and a programmatic answer needs the correct `updatedInput` payload; headless mode additionally needs a permission host, so `allow` alone is insufficient there. The interactive and headless records are therefore authored separately and both start `unverified` — *(verify against the Claude Code hooks reference at step start; the real-CLI check belongs to M0-09)*.
- Deciding a kind is `manual-only` is cheap to reverse (add the record fields once M0-09 proves the channel) and expensive to get wrong in the other direction — when in doubt, author `manual-only`.
- `updateSources` URLs are read only by M6-05; until then they are validated as https URLs and never fetched (C2).
- Skills listed by discovery are informational only in M2; installing/rendering them is M8-04.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
