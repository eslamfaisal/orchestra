# Step M0-03 — SDK, contract harness, FakeProvider

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-02 |
| Estimated effort | 3 days |
| Packages touched | `packages/sdk`, `packages/providers/fake` (lives inside sdk as `src/fake`) |
| Risk | High (this is the plugin contract every adapter and every test depends on) |
| Owner | |

## 1. Goal
`@orchestra/sdk` publishes the segregated adapter interfaces, the Capability Manifest Zod schema, the normalized telemetry event types, the contract-test harness (`defineAdapterContract(adapter, fixtures)`), and a fully working `FakeProvider`: a scripted agent (Node script launched as a real child process / later a tmux pane) driven by YAML scenarios that emits output, hook-style telemetry, every prompt kind, rate-limit signals, model switches and exit codes. From now on every automated test that "runs an agent" runs the FakeProvider.

## 2. Why
D5 (every provider is a plugin; core knows no vendor), C9 (CI never touches real accounts), `10-testing-strategy.md` (contract tests + FakeProvider as the backbone), G7 (third parties implement this same contract in M10).

## 3. Scope
### In scope
- Interfaces from `05-provider-contract.md` §1 exactly: `ProviderAdapter`, `AuthProbe`, `Launcher`, `TelemetryParser`, `RateLimitParser`, `PaneController`, `WorktreeHooks`, `SkillsInstaller`, `QuotaProbe` + supporting types (`LaunchPlan`, `RawTelemetry`, `NormalizedEvent`, `RateLimitSignal`, `TypedCommand`, `Ack`, `PromptAnswer`, `AdapterError`).
- `CapabilityManifest` Zod schema (§2) + JSON-schema export for docs.
- `NormalizedEvent` catalog: `agent.output`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `agent.prompt_opened`, `agent.prompt_answered`, `agent.usage`, `agent.rate_limited`, `agent.model_switched`, `agent.exit`, `agent.unknown` (with raw payload for Doctor).
- Contract harness: seven spec factories from §5 runnable via `defineAdapterContract()` inside any adapter's Vitest.
- `FakeProvider`: adapter + manifest + `fake-agent` script + scenario schema + 8 shipped scenarios (`hello-exit0`, `hello-prompt` (permission), `question-multi`, `plan-approval`, `tool-calls-stream`, `rate-limit-429`, `model-switch`, `crash-exit137`).
- Fixture folder conventions and `RECORDED.md` template.
### Out of scope (deferred)
- tmux launching of the fake agent → M1-02 (here it runs as a child process via a `ProcessRunner` port).
- Real adapters → M1-05..07. Full manifests → M2-03. Skills types beyond a stub → M8-04.

## 4. Design
### 4.1 Domain
`NormalizedEvent` is the boundary between vendor payloads and `DomainEvent`s: adapters produce `NormalizedEvent`s; the daemon's telemetry pipeline (M1-08) maps them to domain events and prompts.
### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/telemetry.ts
export type RawTelemetry =
  | { channel: 'hook'; provider: ProviderId; sessionId: string; name: string; body: unknown; externalId?: string }
  | { channel: 'stream-json'; provider: ProviderId; sessionId: string; line: string }
  | { channel: 'app-server'; provider: ProviderId; sessionId: string; message: unknown }
  | { channel: 'session-log'; provider: ProviderId; sessionId: string; entry: unknown }
  | { channel: 'process'; provider: ProviderId; sessionId: string; exitCode: number; stderrTail: string };

export type NormalizedEvent = { sessionId: string; ts: string; externalId?: string } & (
  | { kind: 'output'; text: string }
  | { kind: 'message'; role: 'assistant'|'user'|'system'; content: string; messageId?: string }
  | { kind: 'tool_call'; tool: string; args: unknown; callId: string }
  | { kind: 'tool_result'; callId: string; summary: string; ok: boolean }
  | { kind: 'prompt_opened'; prompt: PromptDraft }          // → AgentPrompt in M1-11
  | { kind: 'prompt_answered'; promptExternalId: string }
  | { kind: 'usage'; input: number; output: number; model?: string; window?: Partial<WindowState> }
  | { kind: 'rate_limited'; signal: RateLimitSignal }
  | { kind: 'model_switched'; model: string }
  | { kind: 'exit'; code: number }
  | { kind: 'unknown'; raw: unknown; reason: string });

export interface PromptDraft { externalId: string; kind: 'permission'|'question'|'planApproval'|'confirm'|'login'|'error';
  title: string; options: { id: string; label: string; default?: boolean }[]; payload: unknown;
  answerTransport: 'hook-response'|'permission-tool'|'app-server-rpc'|'elicitation'|'mcp-result'|'send-keys-acked'|'none'; deadlineMs?: number }

// packages/sdk/src/contract/index.ts
export function defineAdapterContract(opts: { adapter: ProviderAdapter; fixturesDir: string; cliVersion: string }): void; // registers describe() blocks

// packages/sdk/src/fake/scenario.ts  (YAML)
export const ScenarioSchema = z.object({ name: z.string(), steps: z.array(z.union([
  z.object({ print: z.string(), delayMs: z.number().optional() }),
  z.object({ prompt: PromptDraftSchema.omit({externalId:true}), expectAnswer: z.string().optional() }),
  z.object({ toolCall: z.object({ tool: z.string(), args: z.unknown() }) }),
  z.object({ usage: z.object({ input: z.number(), output: z.number() }) }),
  z.object({ rateLimit: z.object({ resetInSec: z.number() }) }),
  z.object({ switchModel: z.string() }),
  z.object({ exit: z.number() }) ])) });
```
FakeProvider transports: prompts are emitted as hook-style HTTP POSTs to `ORCH_HOOK_URL` (mirrors Claude hooks) and answered via the HTTP response body (`hook-response`) **and** optionally via stdin keystrokes (`send-keys-acked`) so both transports get exercised.
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
`fake-agent.mjs` is a dependency-free Node script (so it can run inside tmux in M1 unchanged). It reads `ORCH_SCENARIO`, `ORCH_HOOK_URL`, `ORCH_SESSION_ID` from env.
### 4.5 API / UI surface
None.
### 4.6 Flow
```
Launcher.interactive(spec) → LaunchPlan{argv:[node, fake-agent.mjs], env:{ORCH_SCENARIO…}}
fake-agent prints, POSTs hook {name:'prompt', body:{…}} → daemon answers in response → agent continues → exit(code)
```

## 5. Tasks
- [ ] `packages/sdk/src/adapter.ts`: interfaces verbatim from `05-provider-contract.md` §1 with TSDoc on every member (this is public API).
- [ ] `manifest.ts`: Zod schema + `CapabilityManifest` type + `toJsonSchema()`; unit tests with valid/invalid manifests.
- [ ] `telemetry.ts`: `RawTelemetry`, `NormalizedEvent`, `PromptDraft`, `RateLimitSignal`, `WindowState` types + schemas.
- [ ] `errors.ts`: `AdapterError` union (`AUTH_REQUIRED`, `BINARY_MISSING`, `UNSUPPORTED_VERSION`, `PARSE`, `ACK_TIMEOUT`, `RPC`, `UNKNOWN`).
- [ ] `contract/`: seven spec factories from §5; `defineAdapterContract()`; fixture loader with `RECORDED.md` check.
- [ ] `fake/fake-agent.mjs` script implementing every scenario step type; deterministic timing via `ORCH_FAKE_SPEED`.
- [ ] `fake/adapter.ts`: `FakeProvider` implementing every interface (`QuotaProbe` returns scripted windows; `PaneController.answerPrompt` implements both transports; `sendCommand` acks on echo).
- [ ] `fake/manifest.json` + 8 scenarios under `fake/scenarios/`.
- [ ] `fake/fixtures/1.0.0/` recorded from the fake agent itself (hooks, exits) so the FakeProvider passes its own contract suite.
- [ ] `ProcessRunner` port (spawn with env allowlist) used by tests to launch the fake agent outside tmux.
- [ ] README: "Write an adapter in 30 minutes" using FakeProvider as the reference (seed for the Plugin Author Guide, M10-06).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| CT-M0-03-01 | contract | `defineAdapterContract(FakeProvider)` | all seven specs pass |
| UT-M0-03-02 | unit | manifest schema rejects: empty models, bad semver range, unknown feature flag | `ZodError` paths correct |
| UT-M0-03-03 | unit | `AuthProbe` result serialized contains no `/token|secret|key|cookie|authorization/i` keys | passes for fake; harness reusable |
| IT-M0-03-04 | integration | run every scenario via `ProcessRunner`; collect NormalizedEvents | each scenario yields its expected event sequence (golden files) |
| IT-M0-03-05 | integration | `rate-limit-429` scenario | `rate_limited` event with `resetAt` ≈ now+resetInSec |
| IT-M0-03-06 | integration | prompt answered via `send-keys-acked` transport | agent proceeds; `prompt_answered` emitted; ack resolved |
| UT-M0-03-07 | fuzz | `FakeProvider.telemetry.parse` with random JSON | never throws; returns `unknown` events |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-03-01 | Run fake agent by hand | 1. `ORCH_SCENARIO=hello-prompt ORCH_HOOK_URL=http://127.0.0.1:9999 node packages/sdk/src/fake/fake-agent.mjs` with a tiny `nc -l 9999` responder | prints hello, POSTs prompt, waits, exits 0 after response | ⬜ |
| TC-M0-03-02 | Scenario validation | 1. add a step `{ bogus: 1 }` to a scenario 2. run contract suite | fails with Zod path to the bad step | ⬜ |
| TC-M0-03-03 | Golden event sequences | 1. run IT-M0-03-04 2. open one golden file | readable sequence; matches scenario intent | ⬜ |
| TC-M0-03-04 | Harness reuse | 1. create `packages/providers/dummy` with an adapter that throws in `parse` 2. run contract | `telemetry.contract` fails with "must not throw"; delete dummy | ⬜ |
| TC-M0-03-05 | JSON schema export | 1. `pnpm --filter @orchestra/sdk run schema` | `dist/manifest.schema.json` generated; validates `fake/manifest.json` with a generic validator | ⬜ |

## 7. Acceptance criteria
- [ ] All interfaces and types from `05-provider-contract.md` §1–§2 implemented with TSDoc.
- [ ] Contract harness with seven specs; FakeProvider passes it.
- [ ] Eight scenarios covering every prompt kind, rate limit, model switch, crash.
- [ ] Both `hook-response` and `send-keys-acked` transports exercised by tests.
- [ ] Fuzz test proves parsers never throw.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Interface churn once real adapters land (M1-05..07): expected; bump `sdk` minor and keep FakeProvider in lock-step. Record every change in `packages/sdk/CHANGELOG.md`.
- `send-keys-acked` in a child process (stdin) differs from tmux `send-keys`; M1-02 re-validates.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
