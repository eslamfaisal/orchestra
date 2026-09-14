# 05 — Provider plugin contract & Capability Manifest

Every vendor CLI is a plugin package `packages/providers/<id>` exporting `{ adapter, manifest, fixtures }`. Core never imports a provider. The SDK (`packages/sdk`) owns these types and the contract-test harness.

## 1. Segregated adapter interfaces (`packages/sdk/src/adapter.ts`)

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;                   // 'claude' | 'codex' | 'agy' | 'kimi' | 'opencode'
  readonly manifest: CapabilityManifest;
  auth: AuthProbe;
  launcher: Launcher;
  telemetry: TelemetryParser;
  rateLimit: RateLimitParser;
  pane: PaneController;
  worktree?: WorktreeHooks;                  // optional: provider-native worktree support
  skills?: SkillsInstaller;
  quota?: QuotaProbe;
}

export interface AuthProbe {
  /** Never returns tokens. Runs a quota-free command (e.g. `claude /status`, `codex login status`). */
  probe(ctx: HostContext): Promise<Result<AuthStatus, AdapterError>>;
}
export interface AuthStatus { loggedIn: boolean; plan?: string; accountLabel?: string; checkedAt: string; }

export interface Launcher {
  /** argv/env for an interactive PTY session in a worktree. */
  interactive(spec: InteractiveSpec): LaunchPlan;
  /** argv/env/stdin for a headless run from a typed TaskSpec (documented flags only). */
  headless(spec: HeadlessSpec): LaunchPlan;
  /** hook/MCP config the daemon must write before launch (returned as files, daemon writes them). */
  preLaunchFiles(spec: InteractiveSpec | HeadlessSpec): FileWrite[];
}
export interface LaunchPlan { argv: string[]; env: Record<string,string>; cwd: string; stdin?: AsyncIterable<string>; }

export interface TelemetryParser {
  /** vendor payload (hook body / json line / rpc notification) → zero or more normalized events. Unknown ⇒ Result.err(UnknownPayload) which the Doctor counts. */
  parse(input: RawTelemetry): Result<NormalizedEvent[], ParseError>;
  /** which raw sources this adapter subscribes to */
  sources(): TelemetrySource[];             // 'hook' | 'stream-json' | 'app-server' | 'session-log' | 'otlp'
}

export interface RateLimitParser {
  parse(input: RawTelemetry | ProcessExit): RateLimitSignal | null;   // {windowKind, resetAt?, retryAfterMs?, confidence}
}

export interface PaneController {
  /** typed commands → keystrokes or RPC; must resolve only after an ack event or timeout */
  sendCommand(pane: PaneRef, cmd: TypedCommand): Promise<Result<Ack, AdapterError>>;
  switchModel(pane: PaneRef, model: ModelId): Promise<Result<Ack, AdapterError>>;
  answerPrompt(pane: PaneRef, prompt: AgentPrompt, answer: PromptAnswer): Promise<Result<Ack, AdapterError>>;
}

export interface WorktreeHooks { onCreate?(wt: WorktreeRef): Promise<void>; onRemove?(wt: WorktreeRef): Promise<void>; nativeFlag?(wt: WorktreeRef): string[]; }
export interface SkillsInstaller { install(skill: Skill, scope: SkillScope, trust: TrustLevel): Promise<Result<void, AdapterError>>; location(scope: SkillScope): string; }
export interface QuotaProbe { probe(ctx: HostContext): Promise<Result<WindowState[], AdapterError>>; isQuotaFree: boolean; }
```

Everything returns `Result`; adapters never throw across the boundary. Every adapter must pass `packages/sdk/src/contract/*.spec.ts` against its own fixtures.

## 2. Capability Manifest (`packages/sdk/src/manifest.ts`, Zod schema; JSON files in each provider package; hot-reloadable)

```ts
export interface CapabilityManifest {
  provider: ProviderId;
  manifestVersion: string;                          // semver of this manifest
  cliVersionRange: string;                          // semver range this manifest is verified against
  fixturesVersion: string;                          // pinned fixture set
  models: ModelRef[];                               // {id, label, tier, deprecated?, aliases[]}
  limits: { maxConcurrentSessions: number; windows: WindowKind[]; maxTurns?: number; resume: boolean; fork: boolean };
  features: CapabilityFlag[];                       // subagents hooks mcp skills websearch imagegen vision nativeReview planMode sandbox appServer streamJsonInput elicitation
  sandboxProfiles: SandboxProfile[];                // e.g. codex read-only|workspace-write|full; agy request-review|always-proceed; claude permission modes
  commands: TypedCommand[];                         // native + discovered custom: {name, args, transport: 'keys'|'rpc'|'slash', effects, approval, ackEvent}
  capabilities: CapabilityRecord[];                 // evidence-keyed truth about what this CLI version can actually do (see below)
  promptProtocol: PromptProtocol;                   // kinds + answerTransport + ackSource + answer-state semantics per kind (see below)
  headless: { flags: string[]; inputFormat?: 'stream-json'; outputFormat?: 'json'|'stream-json'; outputSchema?: boolean };
  paths: { instructionFile: string; skillsDir?: string; commandsDir?: string; hooksConfig?: string; mcpConfig?: string };
  updateSources: { releases: string; changelog?: string; docs?: string };
  tos?: { requiresAcknowledgement: boolean; url: string; note: string };
}
```

```ts
export type CapabilityState = 'verified' | 'limited' | 'manual-only' | 'unsupported' | 'unverified';
export type ExecutionMode = 'interactive-pty' | 'headless' | 'app-server' | 'acp' | 'wire';

export interface CapabilityRecord {
  operation: ProviderOperation;   // launch | resume | cancel | permission-approval | question-answer | plan-approval |
                                  // elicitation | model-switch | usage-signal | rate-limit-signal | exit-status |
                                  // adopt-after-restart | mcp-registration | instruction-file | skills-location
  executionMode: ExecutionMode;
  state: CapabilityState;
  cliVersion: string;             // the exact version the state was established against
  evidence?: string;              // fixture path or evidence-matrix row id that justifies a non-`unverified` state
  limitation?: string;            // required when state is 'limited' or 'manual-only'
}
```

A `CapabilityRecord` is keyed by **provider + CLI version + execution mode** — the same operation can be `verified` in `interactive-pty` and `unsupported` in `headless` on the same binary. `unsupported` or `unverified` disables the affected *feature* for that provider/mode; it never invalidates the provider. The vocabulary and the filled table live in `14-provider-evidence-matrix.md`; the manifest is the machine-readable projection of it.

**`promptProtocol`** carries, for every prompt kind: an `answerTransport` (`hook-response` · `permission-tool` · `app-server-rpc` · `elicitation` · `mcp-result` · `send-keys-acked` · `none`), an `ackSource` naming the *structured* signal that proves delivery (hook response consumed, RPC response, MCP tool result), and the answer-state semantics: a prompt moves `pending → submitted → acknowledged` only on that structured ack. Echoed terminal text, a later unrelated message, or a process exit never prove an approval succeeded. Where a kind's only transport is `send-keys-acked` and no documented ack event exists for that provider, the terminal state is `delivery_uncertain`, and the kind's capability record must be `limited` or `manual-only` — never `verified`. Full state set (M1-11 owns the definition): `pending | submitted | acknowledged | expired | cancelled | delivery_uncertain`.

Discovery merges workspace custom commands/skills at session start. CLI version outside `cliVersionRange` ⇒ commands marked *unverified* and Doctor opens a RepairCase (M6-02).

## 3. Documented provider facts (vendor docs, 2026-09) — unverified until M0-09 records evidence

Everything in this table is read from official vendor documentation on 2026-09; **none of it is verified**. No row here may be treated as a capability state: states are established only by M0-09 running the real CLI at a pinned version and recording a fixture (`14-provider-evidence-matrix.md`). A passing `FakeProvider` test proves our code, not the vendor's behaviour. Where a fact is load-bearing for an adapter, the adapter step must re-read the vendor docs *(verify against <vendor> docs at step start)* and cite the matrix row.

| Provider | Control surface | Prompts / approvals | Quota signal | Constraints |
|---|---|---|---|---|
| **Claude Code** | interactive PTY; `-p` + stream-json; Agent SDK; ~30 hooks; `--worktree`; `remote-control`; `--cloud/--teleport` | `AskUserQuestion` and `ExitPlanMode` are **tools**, not hook events: they are intercepted by `PreToolUse`, and a programmatic answer is returned as `updatedInput` with the tool's own payload shape. Permission decisions come through `PreToolUse`/`PermissionRequest` (allow/deny/ask/defer); `Elicitation*` and `Notification` (`agent_needs_input`, `agent_completed`, `permission_prompt`, `elicitation_dialog`, `quota_auto_resume_*`) are events. **Headless `-p` additionally needs a permission host** — `--permission-prompt-tool` pointing at an MCP tool, or the SDK `canUseTool` callback; returning `allow` alone is not sufficient in non-interactive mode | usage in stream-json + session JSONL + `/usage`; 5-h + weekly windows | interactive and headless approval flows are **different contracts** and must be specified and evidenced separately; hook names and answer shapes are documented, not verified; Fable metered on Max |
| **Codex** | `codex exec --json --output-schema`; **`codex app-server`** JSON-RPC (threads/turns/items, approvals, model switch, token notifications); Codex SDK; `remote-control` | app-server `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval` | `account/rateLimits/read` (poll) and `account/rateLimits/updated` (push) are the documented quota surface and expose **multiple limit buckets per account** — read them directly rather than inferring from token counters; `turn.completed` usage is a token measurement, a different unit (M4-01) | `codex mcp-server` **removed** — never depend on it; app-server transport surfaces are **experimental and must be version-pinned** (`codex app-server generate-json-schema` fixture); reconnect behaviour is not documented as stable — evidence required. A headless app-server process whose transcript is mirrored into a pane **is not the interactive Codex TUI**: the execution mode must be labelled on the session and in the UI, and switching app-server → `exec` cannot preserve pending interactions |
| **Antigravity `agy`** | `-p` + `--input-format stream-json --output-format stream-json` over stdio (official multi-turn); 5 hooks (`PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop`); MCP via config files | headless **rejects `control_request`/`control_response` input events** — a Claude-style control protocol cannot be assumed. A tool needing an approval that is unavailable is **soft-denied while the process still exits 0**, so **exit code ≠ task success**: success needs a structured result signal | `-p "/usage"` as a structured, quota-free probe is **`unverified`** — the cited command documentation describes an interactive panel; `/credits` likewise | ToS §6 third-party-access restrictions are **unresolved** (enterprise terms may differ) and an acknowledgement checkbox does not resolve them ⇒ the adapter is **gated**, not merely opt-in: ADR-008 (amended) requires a written terms resolution in DECISIONS.md **and** an M0-09 evidence row before M1-07 may start (R17). No step, README or acceptance criterion may require it. No JSON-RPC/app-server/ACP; `remote-control` is a Google-hosted relay, not a local API; only launch the official binary |
| **Kimi Code** | open-source CLI; **documented paths are the Wire protocol and ACP** — assess those first; do not assume Claude-like hooks or a structured side channel attached to an independently running TUI | Wire / ACP | local logs | first-class adapter (M10-04); capability states established at that step, not inherited from Claude |
| **OpenCode** (DeepSeek / any OpenAI-compatible) | **local server API is the documented path**: sessions, messages, events, permission responses — evaluate that surface rather than hypothetical hook equivalents | server permission responses | local logs | one adapter can cover many configured backends, but it **cannot guarantee identical tool quality, context behaviour, quota semantics or approval semantics** across them: capability records are per backend where they differ (M10-05) |

## 4. Fixtures (per provider, per CLI version) — `packages/providers/<id>/fixtures/<cliVersion>/`
- `hooks/*.json` — one real payload per hook event kind (secrets scrubbed)
- `stream/*.jsonl` — stream-json sessions incl. a prompt, a tool call, a rate-limit error, a completion with usage
- `rpc/*.json` — app-server request/response/notification samples + generated JSON schema
- `exit/*.txt` — stderr/exit code samples for auth-missing, model-not-found, 429
- `keys/*.yaml` — prompt keystroke protocol (for `send-keys-acked` fallback)
- `RECORDED.md` — how/when captured, CLI version, redaction applied

Fixture drift = failing contract test = "vendor changed something" (M6-02 turns it into a RepairCase automatically).

## 5. Contract-test harness (`packages/sdk/src/contract/`)
- `auth.contract.spec.ts` — probe never returns fields matching `/token|secret|key|cookie|authorization/i`.
- `launcher.contract.spec.ts` — argv contains only allowlisted binary + documented flags from manifest; cwd is inside a worktree.
- `telemetry.contract.spec.ts` — every fixture parses to ≥1 NormalizedEvent; unknown-type fixtures produce `ParseError` not throws.
- `ratelimit.contract.spec.ts` — 429 fixtures produce a signal with `resetAt` or `retryAfterMs`.
- `pane.contract.spec.ts` — `sendCommand` resolves only on ack; timeout returns `Err(AckTimeout)`.
- `prompt.contract.spec.ts` — every prompt kind in manifest has an answer transport and a fixture round-trip.
- `manifest.contract.spec.ts` — manifest validates; models non-empty; `cliVersionRange` matches fixture version.
- `capability.contract.spec.ts` — every operation the adapter implements has a `CapabilityRecord` for each execution mode it claims; `limited`/`manual-only` records carry a `limitation`; any record that is not `unverified` carries `evidence` resolving to an existing fixture path or evidence-matrix row id; a record's `cliVersion` is inside `cliVersionRange`.

**The harness cannot promote a state.** A passing contract run against `FakeProvider` or recorded fixtures never flips a capability to `verified` — fixtures prove *our parsing*, not the vendor's behaviour. Only M0-09 (or a later adapter step re-running the same experiments against a real CLI) writes a `verified|limited|manual-only|unsupported` state, and CI asserts that no state changed in a commit that did not also add or update the fixture cited by its `evidence` field.
