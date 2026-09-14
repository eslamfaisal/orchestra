# Step M2-03 — Capability manifests v1 (full)

| Field | Value |
|---|---|
| Milestone | M2 — Delegation & intelligence |
| Status | ⬜ Not started |
| Depends on | M1-05, M1-06, M1-07 (∥ with M2-01/M2-02) |
| Estimated effort | 2.5 days |
| Packages touched | `packages/sdk`, `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy`, `apps/daemon` |
| Risk | Medium |
| Owner | |

## 1. Goal
After this step each of the three adapters ships a complete `CapabilityManifest` (`05-provider-contract.md §2`): full `models[]`, `limits`, `features[]`, `sandboxProfiles[]`, native `commands[]` with transport/effects/approval/ackEvent, a `promptProtocol` entry for every prompt kind with its answer transport and send-keys fallback map, `headless` flags, `paths`, `updateSources`, and `cliVersionRange` pinned to the versions in `ENVIRONMENT.md`. A `CommandsDiscovery` service merges workspace custom commands and skills into the session's command list at session start. New contract specs make any gap a failing test.

## 2. Why
- D5: core knows no vendor; everything the engine (M2-04), Chat palette (M2-08) and MCP `capabilities()` (M2-05) need must be declared in the manifest.
- D6 / G6: `updateSources` and `cliVersionRange` are the inputs for release watchers (M6-05) and drift detection (M6-02).
- D14: `promptProtocol` per kind is what makes every prompt answerable through a typed transport, with `send-keys-acked` as the declared fallback.
- C1, C8: commands and headless flags are typed data verified by contract tests, never ad-hoc strings.

## 3. Scope
### In scope
- Complete `manifest.json` for `claude`, `codex`, `agy` (fields in §4.2), each with `manifestVersion` bumped to `1.0.0`.
- SDK schema additions: `TypedCommandSchema` (args as JSON-Schema-like Zod descriptor), `PromptProtocolSchema`, `UpdateSourcesSchema`; `CapabilityFlag` enum finalised.
- `CommandsDiscovery` (adapter-side, in `packages/providers/<id>/src/commands-discovery.ts`) reading `manifest.paths.commandsDir` / `skillsDir` from the worktree and user home; merge with `origin: native|workspace|user`.
- Daemon: `SessionCommandsRegistry` populated at session start; `GET /api/sessions/:id/commands`; event `session.commands_discovered`.
- Contract specs: `commands-discovery.contract.spec.ts`, `prompt-protocol.contract.spec.ts`, extended `manifest.contract.spec.ts`.
- Unverified marking: CLI version outside `cliVersionRange` ⇒ every command `verified: false` (Doctor consumes in M6-02).
### Out of scope (deferred to …)
- Fetching signed manifests from a registry and rollback → M6-03.
- Release feed polling and canary verification → M6-05.
- Skills installation and trust levels (only *listing* skills here) → M8-04.
- Kimi and OpenCode manifests → M10-04, M10-05.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `TypedCommand` rules: `transport ∈ {keys, rpc, slash}`; `effects ⊆ {none, reads-fs, writes-fs, spends-quota, changes-model, exits}`; `approval ∈ {none, confirm}` — any command with `writes-fs` or `spends-quota` must be `approval: confirm` (C10, zero-surprise); `ackEvent` is a `NormalizedEvent` type name or `none` (UI shows *sent, no ack available*).
- `PromptProtocol` rules: every `PromptKind` (`permission question planApproval confirm login error`) has exactly one primary `answerTransport` from `{hook-response, permission-tool, app-server-rpc, elicitation, send-keys-acked}` and, when primary ≠ `send-keys-acked`, a `fallback.keys` map from `fixtures/<ver>/keys/*.yaml`.
- `cliVersionRange` must contain `fixturesVersion`; the daemon computes `verified = semver.satisfies(detectedCliVersion, cliVersionRange)` (via `BinaryRegistry`, M1-04).
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
export interface PromptProtocol {
  kinds: Record<PromptKind, { answerTransport: AnswerTransport; fallback?: { keys: Record<string, string> }; timeoutMs: number }>;
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

| Field | claude | codex | agy |
|---|---|---|---|
| `cliVersionRange` | `>=2.1.216 <2.2.0` | version installed in M1-06, from ENVIRONMENT.md log *(verify)* | `>=1.2.1 <1.3.0` |
| `features` | subagents hooks mcp skills planMode sandbox streamJsonInput elicitation vision websearch *(verify list)* | appServer sandbox mcp hooks *(verify)* | hooks mcp streamJsonInput *(verify)* |
| `sandboxProfiles` | permission modes *(verify names)* | `read-only`, `workspace-write`, `full` | `request-review`, `always-proceed` |
| `commands` (native) | `prompt`, `model`, `clear`, `compact`, `help`, plan-mode toggle *(verify)* — transport `keys`/`slash` | `prompt` (`turn/start` rpc), `model` (rpc), `approve/deny` (rpc) *(verify method names against generated schema)* | `prompt` (stream-json stdin), `usage` (`/usage`), `credits` *(verify)* |
| `promptProtocol` | permission→`hook-response` (PreToolUse/PermissionRequest), question→`hook-response` (AskUserQuestion), planApproval→`hook-response` (ExitPlanMode), login/error→`send-keys-acked` | permission→`app-server-rpc` (`requestApproval`, `execCommandApproval`, `applyPatchApproval`), others→`send-keys-acked` | permission→`hook-response` (PreToolUse), others→`send-keys-acked` |
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
- Fleet screen: provider row gains "manifest 1.0.0 · verified ✓ / unverified (cli 2.3.0 ∉ range)" text.
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
- [ ] Extend `manifest.ts` Zod schema: `TypedCommandSchema`, `PromptProtocolSchema`, `UpdateSourcesSchema`, `tos`; add refinements from §4.1.
- [ ] Record/refresh fixtures on the pinned CLI versions (`orch fixtures record`, M1-08) including `keys/*.yaml` per prompt kind for all three providers; update each `RECORDED.md`.
- [ ] Author `packages/providers/claude/manifest.json` v1.0.0 (table above); verify every *(verify)* item against docs and note sources in the provider README.
- [ ] Author `packages/providers/codex/manifest.json` v1.0.0; regenerate app-server schema fixture (`codex app-server generate-json-schema`) and reference rpc method names from it.
- [ ] Author `packages/providers/agy/manifest.json` v1.0.0 incl. `tos` block; confirm ToS acknowledgement flow (M1-07) reads `tos.url` from the manifest.
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
| CT-M2-03-03 | contract | `prompt-protocol.contract.spec.ts` | every `PromptKind` present; non-send-keys kinds have `fallback.keys`; each keys map has a fixture under `keys/` |
| CT-M2-03-04 | contract | `commands-discovery.contract.spec.ts` with fixture workspace containing 2 custom commands + 1 skill, one colliding with a native name | 3 discovered, collision renamed, warning present, native list untouched |
| UT-M2-03-01 | unit | front-matter parser on malformed file | entry kept with `description: undefined`; no throw |
| UT-M2-03-02 | unit | `verified` computation for version inside/outside range | true / false |
| IT-M2-03-01 | integration | start FakeProvider session in temp worktree with custom commands | `session.commands_discovered` emitted before `session.launched`; `GET /commands` lists them |
| IT-M2-03-02 | integration | restart daemon with a running session | registry rebuilt for that session during reconcile |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M2-03-01 | Manifests verified on real CLIs | 1. Start daemon 2. Open Fleet | claude, codex (and agy if opted in) rows show `manifest 1.0.0 · verified ✓` with the detected CLI version | ⬜ |
| TC-M2-03-02 | Workspace command discovery (Claude) | 1. In `~/orchestra-scratch` add a custom command file under the manifest's `commandsDir` named `orch-hello` 2. Start an interactive Claude session from Fleet 3. `GET /api/sessions/:id/commands` | List contains `orch-hello` with `origin: workspace` plus native commands; event visible in the WS stream | ⬜ |
| TC-M2-03-03 | Prompt protocol fallback map | 1. Start a Claude session 2. Force a `login`-kind prompt (e.g. run with a temporarily logged-out profile) 3. Answer from Attention | Answer goes through `send-keys-acked` using the manifest keys map; ack recorded; agent proceeds | ⬜ |
| TC-M2-03-04 | Negative: version outside range | 1. Temporarily set `cliVersionRange` to `>=9.0.0` in the claude manifest 2. Restart daemon | Fleet row shows *unverified*; `GET /commands` for a new session has `verified: false` on every command; no crash. Revert. | ⬜ |
| TC-M2-03-05 | Codex commands over app-server | 1. Start a Codex session 2. `GET /commands` | `prompt` and `model` commands have `transport: rpc` and an `ackEvent`; rpc method names match the pinned schema fixture | ⬜ |
| TC-M2-03-06 | Restart / resilience | 1. With TC-03-02 session running, `kill -9` daemon 2. Restart | Session reconciled; `GET /commands` returns the same list including `orch-hello` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All three manifests validate at `manifestVersion 1.0.0` and pass CT-M2-03-01…04 on fixtures recorded from the pinned CLI versions.
- [ ] Every `PromptKind` has a transport and a fixture round-trip for each provider (extends `prompt.contract.spec.ts` from M0-03).
- [ ] Workspace commands appear in `GET /api/sessions/:id/commands` before the session's first output on real Claude Code.
- [ ] `verified` flag computed correctly and shown in Fleet; unverified never blocks a session (Doctor handles it in M6).
- [ ] No adapter imports another adapter or the daemon (dependency-cruiser).
- [ ] Every *(verify)* item in §4.2 resolved and its source URL noted in the provider README.
- [ ] All TC-M2-03-* pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- ENVIRONMENT.md lists Codex as a broken install with no version; the range cannot be pinned until M1-06 records the installed version *(verify at step start)*.
- Codex rpc method names for prompt/model/approvals come from the generated app-server schema (ADR-009); if the schema changes, CT-M2-03-05-related assertions fail by design (R3).
- Claude command/skill directory conventions and permission-mode names are not in `05 §3` — *(verify against Claude Code docs at step start)*; same for agy instruction-file name and MCP config locations *(verify against Antigravity docs)*.
- `updateSources` URLs are read only by M6-05; until then they are validated as https URLs and never fetched (C2).
- Skills listed by discovery are informational only in M2; installing/rendering them is M8-04.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
