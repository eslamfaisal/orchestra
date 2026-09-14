# Step M7-06 — `orch` CLI

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M0-06, M7-04, M1-08, M6-01, M2-01, M2-02, M5-04 |
| Estimated effort | 2 days |
| Packages touched | `apps/cli` (the whole package: command registry, commands, output, completions), `packages/sdk` (API client + DTO reuse), `apps/daemon` (a few thin endpoints listed in §4.5), `docs/` (CLI reference page) |
| Risk | Low (no new substrate; the risk is scope creep into a second UI) |
| Owner | |

## 1. Goal
One installed binary, `orch`, is the scriptable surface for everything the daemon can do: list and start and stop sessions, delegate a task, inspect the fleet, run the doctor, replay a session, answer an attention item, manage tokens, record fixtures and validate catalog artifacts. Every command supports `--json` for machine consumption (validated against the same SDK DTO schemas the web app uses), has documented exit codes, works against a remote host with `--host`, and lives in a single command registry so `orch --help` is complete and shell completions are generated rather than hand-written. Commands that earlier milestones introduced ad hoc (`orch fixtures record`, `orch doctor`, `orch dev emit`) are folded into this registry without changing their behaviour.

## 2. Why
- **03-architecture.md §3** lists `apps/cli` (`orch`) as one of the three surfaces; **source plan §14** treats scripting as part of "everywhere". Until now the CLI has accreted one command per milestone with no shared skeleton — this step pays that debt before M8 adds four more (`orch skill eval`, playbook validation, settings diff).
- **G1** ("see and control every agent in one place") includes the place where an engineer actually lives: a terminal and a shell script. **G7** (extensible and open): a plugin author needs `orch` to validate a manifest and run contract tests without opening a browser.
- **D5/D7**: catalog and manifest artifacts are data; validating them must be possible in CI and in a pre-commit hook, which means a CLI with real exit codes.
- **C9**: the CLI must be usable in CI, which never touches a real vendor account — so every command works against `FakeProvider` and no command performs vendor auth.
- **C10**: `orch delegate` spends quota. It therefore shows the same preview the Fleet wizard shows (M1-10) and requires `--yes` in non-interactive contexts; the action is audited daemon-side like any other mutation.
- **09-engineering-standards.md** "strategies, not switches": the command registry is a DI-style map, not a `switch (argv[0])`.

## 3. Scope
### In scope
- Package skeleton: `apps/cli` with a `CommandRegistry`, a shared `GlobalOptions` parser, one module per command group, and a single `main` that maps `Result` → exit code. Built with `tsup`/esbuild to a single CJS file; published later (M10-07) — here it is installed via `pnpm link` / `npm i -g` from the repo and via the desktop app's "Install CLI" helper.
- Command groups (details in §4.5): `sessions`, `delegate`, `fleet`, `doctor`, `replay`, `attention`, `token`, `fixtures`, `catalog`, plus `completion`, `config` and a hidden `dev` group.
- `--json` on every command, emitting a stable envelope validated against a Zod schema exported from `packages/sdk`; `--json` implies non-interactive and never prints prose to stdout (prose goes to stderr).
- Human output: aligned tables, colour only as an enhancement (never colour-alone status, per 12-ux-principles.md), `NO_COLOR` and non-TTY detection, `--quiet`.
- Host targeting: `--host <url>` (or `ORCH_HOST`), named hosts from `~/.orchestra/cli.yaml`, `--token`/`ORCH_TOKEN`, default to the local daemon and `~/.orchestra/token`.
- Exit codes (§4.2) and a `--wait` mode for long-running commands that streams progress from `/ws` and exits on terminal state.
- Shell completions for zsh, bash and fish, generated from the registry (`orch completion zsh`), plus a `--help` that is generated from the same metadata.
- Migration of the existing commands into the registry with their current flags preserved; a deprecation shim for any renamed flag that prints to stderr for one minor version.
- `docs/cli.md` reference generated from the registry so it cannot drift.
### Out of scope (deferred to …)
- `orch skill eval` — **M8-05**; `orch settings diff`, `orch policy …` — **M8-01/M8-02**; `orch mission …` beyond `delegate` — **M3** already owns missions in the UI and the CLI surface for them is **M9-07** (automations).
- Homebrew formula, npm publish with provenance, auto-update of the CLI — **M10-07** (this step documents `pnpm add -g` / reinstall).
- Interactive TUI (a curses-style dashboard) — not planned; `orch fleet --watch` is a re-printed table, nothing more.
- RBAC-aware output (hiding fields by permission) — **M9-01**.
- Windows shell completions (PowerShell) — **M10-07**.
- Any command that talks to a vendor CLI directly; `orch` only ever talks to the daemon over HTTP/WS (C1/C2 — the CLI has no vendor endpoint knowledge at all).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No domain changes; the CLI is an interface-layer adapter (03-architecture.md §4) and imports only `packages/sdk` types plus the generated API client. A dependency-cruiser rule is added: `apps/cli` may import `packages/sdk` and nothing else from the workspace — never `apps/daemon`, never `packages/core` internals, never a provider package.

Output envelope (the one shared "value object" the CLI owns):
```ts
// packages/sdk/src/cli/output.ts
export interface CliEnvelope<T> {
  ok: boolean;
  command: string;            // 'sessions.list'
  data?: T;                   // DTO from packages/sdk, unchanged
  error?: { code: string; message: string; details?: unknown };
  meta: { host: string; hostId?: string; daemonVersion?: string; cliVersion: string; ts: string; durationMs: number };
}
```
Rule: `--json` output is exactly one `CliEnvelope` JSON document on stdout, even on failure; nothing else is ever written to stdout in that mode. Streaming commands (`--wait`, `--watch`) emit **JSON Lines** of `CliEnvelope<Event>` instead, and say so in `--help`.

### 4.2 Interfaces / contracts
```ts
// apps/cli/src/registry.ts
export interface CommandDef<A = unknown> {
  readonly path: string;                  // 'sessions list'  → orch sessions list
  readonly summary: string;
  readonly args: z.ZodType<A>;            // parsed from argv; also drives --help and completions
  readonly requiresDaemon: boolean;
  readonly mutating: boolean;             // true ⇒ honours --yes / interactive confirm
  run(ctx: CliContext, args: A): Promise<Result<CommandOutput, CliError>>;
}
export interface CliContext {
  api: ApiClient;                         // packages/sdk, base-url + token bound
  ws: () => Promise<WsClient>;            // lazy; only for --wait/--watch
  io: { out: Writable; err: Writable; isTTY: boolean; json: boolean; quiet: boolean };
  host: { url: string; name?: string };
  confirm(prompt: string, preview?: string): Promise<boolean>;   // auto-true when --yes
}
export class CommandRegistry { register(def: CommandDef): void; resolve(argv: string[]): { def: CommandDef; rest: string[] } | NotFound; all(): CommandDef[] }
```
**Exit codes** (documented in `--help` and `docs/cli.md`):
| Code | Meaning |
|---|---|
| 0 | success (and, for `doctor`, all checks pass) |
| 1 | partial success / warnings (e.g. `doctor` has warns, `catalog validate` has non-fatal notices) |
| 2 | failure reported by the daemon (a check failed, validation failed, a task failed) |
| 3 | usage error (bad flags, unknown command) |
| 4 | cannot reach the daemon (connection refused, timeout) |
| 5 | authentication error (401/403 — token missing, rotated, revoked, origin blocked) |
| 130 | interrupted (SIGINT) |
These extend the codes M6-01 already documents for `orch doctor` (0/1/2/3) without changing them; 4 and 5 were previously folded into 3 and are now distinct — noted as a behaviour change in `docs/cli.md`.

### 4.3 Data / schema changes
No database changes. New client config file `~/.orchestra/cli.yaml` (0600):
```yaml
defaultHost: local
hosts:
  local:  { url: "http://127.0.0.1:4300", tokenFile: "~/.orchestra/token" }
  server: { url: "https://server.tailnet.ts.net", tokenEnv: "ORCH_SERVER_TOKEN" }
output:
  json: false
  color: auto        # auto | always | never
```
Precedence: flag > environment (`ORCH_HOST`, `ORCH_TOKEN`) > `cli.yaml` > local defaults. A token is **never** written to `cli.yaml`; only a `tokenFile` path or a `tokenEnv` name (`orch config set-host` enforces this and refuses an inline token with an explanation).

### 4.4 Infrastructure (network, processes)
- HTTP: the generated SDK client with `Authorization: Bearer`, a 10 s default timeout (`--timeout`), one retry on connection reset only (never on a 4xx or on a mutation without an `Idempotency-Key`), and `Idempotency-Key` generated per mutating invocation.
- WS (`--wait`, `--watch`, `attention watch`): the M7-04 subprotocol credential path, `sinceEventId` resubscribe (M5-05), heartbeat, and a hard exit on terminal state or `--timeout`.
- The CLI starts no processes. If the daemon is not running, exit 4 with a message naming how to start it (`orchestrad`, or "open Orchestra.app"); it never auto-spawns a daemon — that is M7-01's job and doing it from a script would be surprising.
- Binary: one file, no postinstall script (09-engineering-standards supply-chain hygiene), `#!/usr/bin/env node`, Node 22 floor enforced with a readable error on older runtimes.
- `orch` in the desktop app: Settings → **Install CLI** symlinks `/usr/local/bin/orch` to the bundled CLI after an explicit confirm (it writes outside the app bundle, so it is a user-approved action, not something the installer does silently).

### 4.5 API / UI surface
Command surface (`⟨⟩` required, `[]` optional; every command takes the global options `--host --token --json --quiet --yes --timeout --no-color`):
```
orch sessions list [--state running|waiting|stopped|all] [--provider <id>] [--watch]
orch sessions show ⟨id⟩
orch sessions start --provider <id> [--model <m>] --repo <path> [--worktree new|existing|none]
                   [--mode interactive|managed|headless] [--prompt <text>] [--preview] [--wait]
orch sessions stop ⟨id⟩ [--force]
orch delegate ⟨"task text"⟩ --provider <id> [--model <m>] --repo <path> [--task-type <t>]
                   [--headless] [--preview] [--wait]          # prints branch, diffstat, summary on completion
orch fleet [--watch]                                          # providers, versions, auth, concurrency, sessions
orch fleet providers                                          # detail table
orch doctor [--provider <id>] [--check <id>] [--watch]        # behaviour unchanged from M6-01
orch replay ⟨sessionId⟩ [--from <ts>] [--to <ts>] [--format cast|jsonl] [--out <file>]
orch replay list [--since <ts>] [--limit n]
orch attention list [--state open] [--priority <=n] [--watch]
orch attention show ⟨promptId⟩
orch attention answer ⟨promptId⟩ (--allow | --deny | --option <id> | --text <s>) [--reason <s>]
orch token list | create --label <l> [--expires-in-days n] | revoke ⟨id⟩ | rotate [--now|--grace <s>] | show
orch fixtures record ⟨provider⟩ --scenario <name> [--review]  # from M1-08, unchanged
orch fixtures list | verify ⟨provider⟩
orch catalog validate [--path <dir>]                          # taxonomy, model profiles, playbooks, manifests
orch catalog show models|task-types|playbooks
orch config get|set-host ⟨name⟩ --url <u> (--token-file <p>|--token-env <E>)|use ⟨name⟩|list
orch completion zsh|bash|fish
orch version [--json]                                         # cli + daemon + api versions
orch dev emit ⟨type⟩ [--payload <json>]                       # hidden, from M0-06
```
Thin daemon endpoints this step needs (everything else already exists): `GET /api/v1/version` (cli/daemon/api versions in one call), `GET /api/v1/catalog/validate` (runs the existing loaders' validation and returns findings), and `GET /api/v1/sessions/:id/replay?format=` (streams the existing recording, M5-01/M5-04) — all read-only.

Human output examples (shape only):
```
$ orch fleet
PROVIDER   VERSION    AUTH        PLAN        SESSIONS  CONCURRENCY  HEALTH
claude     2.1.216    ok          Max         2         2/4          ok
codex      0.51.0     ok          Plus        1         1/2          ok
agy        1.2.1      not-acked   —           0         0/2          opt-in required
```
```
$ orch attention list
ID        HOST      PROVIDER  KIND        PRI  RISK  AGE   TITLE
01J8…QA   macbook   claude    permission   2   high  00:14 Run `rm -rf build/` in orch/task-a
01J8…RB   server    codex     question     4   low   02:31 Which migration strategy?
```

### 4.6 Flow / sequence
```
orch <group> <cmd> [args]
 → parse global options → resolve host (flag > env > cli.yaml > local) → resolve token
 → registry.resolve(argv)
       not found → exit 3 with the nearest-match suggestion
 → args = def.args.parse(rest)             # Zod; failure → exit 3 with the field path
 → requiresDaemon → GET /health (2 s)      # unreachable → exit 4 ; 401 → exit 5
 → def.mutating && !--yes && isTTY → print preview (same payload as POST /sessions/preview) → confirm
 → def.run(ctx, args) → Result
       ok  → render (table | CliEnvelope) → exit 0|1
       err → render error (stderr text, or CliEnvelope on stdout with --json) → exit 2|3|4|5

--wait (sessions start / delegate)
 → after the mutation, open /ws, subscribe ['sessions','prompts','events:<id>'] with sinceEventId
 → stream progress lines (or JSONL envelopes) → exit on session.stopped / task done / --timeout
 → SIGINT → close socket, print "still running in the background: orch sessions show <id>" → exit 130
```

## 5. Tasks
- [ ] Scaffold `apps/cli` properly: `CommandRegistry`, `GlobalOptions`, `CliContext`, `Result`→exit-code mapper, `main` with a single `process.exit` site.
- [ ] Output layer: table renderer (alignment, truncation, `NO_COLOR`, non-TTY), `CliEnvelope` writer, JSONL streaming writer; `--quiet`.
- [ ] Host/token resolution with the documented precedence; `~/.orchestra/cli.yaml` schema (Zod) + `orch config` commands that refuse inline tokens.
- [ ] Migrate the existing commands (`doctor`, `fixtures *`, `dev emit`) into the registry with identical flags and exit codes; add deprecation shims where a flag name changes.
- [ ] `sessions list|show|start|stop` incl. `--preview` (reusing `POST /sessions/preview` from M1-10) and `--wait`.
- [ ] `delegate` incl. preview, `--wait`, and result rendering (branch, diffstat, summary) from `task_results` (M3-03 shape; M1-12 fields until then).
- [ ] `fleet` + `fleet providers` + `--watch`.
- [ ] `attention list|show|answer` with option validation against the prompt's own `options` and `Idempotency-Key` on answer.
- [ ] `replay` + `replay list`; `GET /sessions/:id/replay` streaming endpoint; `--out` writes the asciicast file.
- [ ] `token` group wired to the M7-04 endpoints; one-time secret printed to stdout only, never logged.
- [ ] `catalog validate|show` + `GET /catalog/validate` endpoint reusing the existing loaders.
- [ ] `version` command + `GET /api/v1/version`; warn (exit 1) when the CLI and daemon minor versions differ.
- [ ] Completions generator for zsh/bash/fish from the registry + a test that every registered command appears.
- [ ] `docs/cli.md` generated from the registry metadata; a CI check fails if the generated file differs from the committed one.
- [ ] dependency-cruiser rule: `apps/cli` → `packages/sdk` only.
- [ ] Desktop **Install CLI** action (symlink with confirm) in Settings (M7-01 integration).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-06-01 | unit | registry resolution: `orch sessions list`, `orch session list` (typo), unknown group | resolved; exit 3 with "did you mean `sessions list`?"; exit 3 with the group list |
| UT-M7-06-02 | unit | host/token precedence: flag vs `ORCH_HOST` vs `cli.yaml` vs default | flag wins, then env, then config, then local; `orch config set-host --token <literal>` is refused |
| UT-M7-06-03 | unit | exit-code mapper over every `CliError` kind and HTTP status | 0/1/2/3/4/5/130 exactly as §4.2; a 401 never maps to 2 |
| UT-M7-06-04 | unit | `--json` envelope on success and on failure | exactly one JSON document on stdout in both cases; schema-valid; stderr carries any human text |
| UT-M7-06-05 | unit | table renderer with a non-TTY, `NO_COLOR=1`, and a 200-char title | no ANSI codes; truncation with an ellipsis; column alignment stable |
| IT-M7-06-06 | integration | `orch sessions start --provider fake --preview --json` against a live daemon | envelope contains `argv`, `cwd`, `filesToWrite`; **no** session is created (event log unchanged) |
| IT-M7-06-07 | integration | `orch delegate … --wait` with FakeProvider | streams progress JSONL; exits 0 on completion; final envelope carries branch + diffstat + summary |
| IT-M7-06-08 | integration | `orch attention answer <id> --option nope` where `nope` is not in the prompt's options | exit 2 with `VALIDATION`; no `prompt.answered` event |
| IT-M7-06-09 | integration | daemon stopped → `orch fleet`; wrong token → `orch fleet` | exit 4 with a "daemon not reachable" message; exit 5 with a "token rejected — try `orch token show`" message |
| IT-M7-06-10 | integration | `orch catalog validate` against a deliberately broken taxonomy file | exit 2; findings list the file, the JSON path and the Zod issue; `--json` output is machine-readable |
| E2E-M7-06-11 | e2e | completions: generate for zsh and assert every registered command path is present | 1:1 with `registry.all()`; the test fails when a command is added without regenerating |
| E2E-M7-06-12 | e2e | `docs/cli.md` drift check | generated output equals the committed file |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-06-01 | Everyday read commands | 1. With two real sessions running, run `orch fleet`, `orch sessions list`, `orch attention list` | Tables are readable at 100 columns, statuses show icon + text (not colour alone), ages are relative and correct | ⬜ |
| TC-M7-06-02 | Scripting with `--json` | 1. `orch fleet --json \| jq '.data.providers[] \| select(.authStatus != "ok") \| .id'` 2. `orch sessions list --json \| jq '.data \| length'` | Valid JSON, no prose contamination on stdout, jq filters work first try | ⬜ |
| TC-M7-06-03 | Start a real session with preview | 1. `orch sessions start --provider claude --repo ~/orchestra-scratch --preview` 2. Repeat without `--preview`, answer the confirm with `n`, then rerun with `--yes` | Preview prints argv/cwd/files and starts nothing; the declined run starts nothing; `--yes` starts and prints the session id | ⬜ |
| TC-M7-06-04 | Delegate with `--wait` | 1. `orch delegate "add a --version flag to cli.js" --provider codex --repo ~/orchestra-scratch --headless --wait` | Progress streams; on completion prints branch `orch/task-…`, diffstat and summary; exit 0; `git branch` on the repo confirms it | ⬜ |
| TC-M7-06-05 | Answer a prompt from the terminal | 1. Trigger a Claude permission prompt 2. `orch attention list` 3. `orch attention answer <id> --deny --reason "not now"` | The prompt is listed with risk and age; the deny is delivered; Claude reports the reason; the web Attention card updates live | ⬜ |
| TC-M7-06-06 | Remote host | 1. `orch fleet --host https://server.tailnet.ts.net --token $(cat …)` 2. `orch config set-host server --url … --token-env ORCH_SERVER_TOKEN` then `orch fleet --host server` | Both work; the named-host form reads the token from the env var; `cli.yaml` contains no secret (`grep` proves it) | ⬜ |
| TC-M7-06-07 | **Negative — daemon down** | 1. Stop the daemon 2. `orch fleet`; `echo $?` 3. `orch fleet --json` | Message names how to start the daemon; exit 4; `--json` still emits a single valid envelope with `ok:false` and the code | ⬜ |
| TC-M7-06-08 | **Negative — rotated token** | 1. `orch token rotate --now` in one shell 2. In another shell with the old token in `ORCH_TOKEN`, run `orch sessions list` | Exit 5 with "token rotated — run `orch token show`"; not exit 2, not a stack trace | ⬜ |
| TC-M7-06-09 | **Negative — bad usage** | 1. `orch sessions start --provider claude` (no `--repo`) 2. `orch replay` (no id) 3. `orch nonsense` | Exit 3 each time with the missing field named and a one-line usage hint; no daemon call is made | ⬜ |
| TC-M7-06-10 | **Resilience — Ctrl-C during `--wait`** | 1. `orch delegate … --wait` 2. `Ctrl-C` after 10 s 3. `orch sessions list` | Exit 130 with "still running in the background: orch sessions show <id>"; the agent keeps working; the session is listed as running | ⬜ |
| TC-M7-06-11 | **Resilience — daemon restarts during `--watch`** | 1. `orch fleet --watch` 2. `kill -9` the daemon and restart it | The watcher reconnects with backoff, re-prints the table, and does not exit; no duplicate rows | ⬜ |
| TC-M7-06-12 | Completions | 1. `orch completion zsh > "${fpath[1]}/_orch"` and restart the shell 2. Type `orch att<TAB>` and `orch attention <TAB>` | Completes to `attention`; then offers `list`, `show`, `answer`; flags complete on `--<TAB>` | ⬜ |
| TC-M7-06-13 | Fixtures/doctor unchanged | 1. `orch doctor` 2. `orch fixtures verify claude` | Identical behaviour and exit codes to M6-01/M1-08; no flag regressions (compare against those step files' TCs) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] All nine command groups plus `completion`, `config`, `version` and the hidden `dev` group are registered in one `CommandRegistry`; `orch --help` and `docs/cli.md` are generated from it and cannot drift (E2E-M7-06-12).
- [ ] `--json` works on every command and emits exactly one schema-valid `CliEnvelope` (or JSONL for streaming) with nothing else on stdout.
- [ ] Exit codes 0/1/2/3/4/5/130 are implemented, documented, and distinguish "daemon unreachable" from "auth failed" from "usage error".
- [ ] `--host` works against a remote daemon over a tunnel, with named hosts from `cli.yaml` and tokens only by file or env reference — no secret is ever written to `cli.yaml`.
- [ ] Mutating commands preview and confirm interactively and require `--yes` non-interactively (C10).
- [ ] The commands introduced in M0-06, M1-08 and M6-01 behave identically after consolidation (TC-13).
- [ ] Shell completions generate for zsh, bash and fish and cover every registered command (E2E-M7-06-11).
- [ ] `apps/cli` imports only `packages/sdk` from the workspace (dependency-cruiser rule added and green); the binary has no postinstall script.
- [ ] All TC pass; no new lint/arch violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- Scope creep into "a second UI" is the real risk: every table added here is a maintenance surface. The guard is that `orch` renders DTOs the API already returns and adds no client-side aggregation (multi-host merging stays in the web app, M7-05) — `--host` targets one daemon at a time, deliberately.
- Changing `orch doctor`'s previously-documented exit codes for auth/unreachable (3 → 5/4) is a behaviour change for anyone scripting against M6; it is small and pre-1.0, but it must be called out in `docs/cli.md` and in the M6-01 step's progress log rather than slipped in.
- `--wait` duplicates a slice of the web app's state machine in the CLI; keep it dumb (print state transitions, exit on terminal state) and resist adding retry/recovery logic that belongs in the daemon.
- The name `orch` is provisional pending ADR-002 (trademark clearance); the registry keeps the binary name in one constant so a rename is a one-line change, and package internals already avoid the brand (R14).
- `catalog validate` re-implements nothing but does need the daemon running, which is awkward for a pre-commit hook on a machine with no daemon. Open question: add an offline `--local` mode that loads the catalog packages directly — it would break the "CLI only talks to the daemon" rule, so it is deferred rather than decided here.
- Streaming JSONL versus a single envelope for `--wait`/`--watch` is a real ergonomic fork; the choice is documented per command in `--help`, and a wrong guess by a script author should fail loudly (schema mismatch) rather than silently.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
