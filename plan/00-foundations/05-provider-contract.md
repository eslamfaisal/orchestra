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
  promptProtocol: PromptProtocol;                   // kinds + answerTransport per kind + keystroke maps for send-keys fallback
  headless: { flags: string[]; inputFormat?: 'stream-json'; outputFormat?: 'json'|'stream-json'; outputSchema?: boolean };
  paths: { instructionFile: string; skillsDir?: string; commandsDir?: string; hooksConfig?: string; mcpConfig?: string };
  updateSources: { releases: string; changelog?: string; docs?: string };
  tos?: { requiresAcknowledgement: boolean; url: string; note: string };
}
```

Discovery merges workspace custom commands/skills at session start. CLI version outside `cliVersionRange` ⇒ commands marked *unverified* and Doctor opens a RepairCase (M6-02).

## 3. Verified provider facts (2026-09) — adapter design inputs

| Provider | Control surface | Prompts / approvals | Quota signal | Constraints |
|---|---|---|---|---|
| **Claude Code** | interactive PTY; `-p` + stream-json; Agent SDK; ~30 hooks; `--worktree`; `remote-control`; `--cloud/--teleport` | `PreToolUse` (allow/deny/ask/defer), `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`, `Elicitation*`, `Notification` (`agent_needs_input`, `agent_completed`, `permission_prompt`, `elicitation_dialog`, `quota_auto_resume_*`) | usage in stream-json + session JSONL + `/usage`; 5-h + weekly windows | in plain `-p`, automated decisions go through `PreToolUse`; Fable metered on Max |
| **Codex** | `codex exec --json --output-schema`; **`codex app-server`** JSON-RPC (threads/turns/items, approvals, model switch, token notifications); Codex SDK; `remote-control` | app-server `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval` | app-server token/usage notifications; `turn.completed` usage | `codex mcp-server` **removed** — never depend on it; app-server experimental ⇒ pin schema fixture via `codex app-server generate-json-schema` |
| **Antigravity `agy`** | `-p` + `--input-format stream-json --output-format stream-json` over stdio (official multi-turn); 5 hooks (`PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop`); MCP via config files | hook decisions; approval prompts in PTY (ack via events) | `-p "/usage"` structured, quota-free; `/credits` | no JSON-RPC/app-server/ACP; `remote-control` is Google-hosted relay, not a local API; ToS §6 ⇒ **opt-in adapter with in-product ToS acknowledgement**; only launch the official binary |
| **Kimi Code** | open-source CLI; hooks; MCP; ACP; skills/plugins with trust levels | hooks/ACP | local logs | first-class adapter (M10-04) |
| **OpenCode** (DeepSeek / any OpenAI-compatible) | headless/JSON/MCP/hooks | hooks | local logs | one adapter covers all API-backed models (M10-05) |

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
