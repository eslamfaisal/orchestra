# Step M7-07 — Cloud-session aggregation (optional, P3)

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M7-05 (host registry & merged views), M2-03 (capability manifests v1), M1-04 (BinaryRegistry), M6-01 (Doctor probes) |
| Estimated effort | 1 day |
| Packages touched | `packages/sdk` (manifest `cloudSessions` block), `packages/providers/claude`, `packages/providers/codex`, `packages/providers/agy` (manifest additions + parsers + fixtures), `apps/daemon` (`src/application/cloud`, `src/infrastructure/cloud`), `apps/web` (Fleet "Cloud sessions" section), `docs/` |
| Risk | Medium (vendor-surface availability is unknown until the step starts; the compliance line is easy to cross) |
| Owner | |

> **Optional / P3.** This step is droppable without affecting the M7 exit criteria. Drop it if the milestone is behind, or if the availability check in Task 1 shows that no vendor CLI exposes a documented cloud-session listing at the time of implementation. Dropping it means setting the status to ⏸ in `PROGRESS.md` with a one-line reason — not leaving it open.

## 1. Goal
Sessions that a vendor runs in *its own* cloud — Claude Code's remote/teleport sessions, Codex cloud tasks, Antigravity's Google-hosted remote — become visible in Orchestra as **read-only** rows next to local sessions, with a "hand off to a local worktree" action that continues the work on this machine. Everything is obtained by invoking the user's own official CLI with documented commands and parsing their documented output; Orchestra makes no HTTP call to any vendor service, reads no vendor credential store, and scrapes no web UI. If a provider's CLI has no documented listing command, that provider simply contributes nothing and says so in the UI.

## 2. Why
- **Source plan §14** lists this as the last item of the multi-device story and grades it explicitly: "optional aggregation of vendors' own cloud sessions (Claude web, Codex cloud, agy remote) as monitor + handoff surfaces (**P3**)". `DECISIONS.md` carries the matching open product decision — "Depth of cloud-session aggregation: none / read-only monitor / handoff — decide by M7-07". This step is where that decision is made and recorded.
- **G1** ("see, control and talk to every agent in one place"): work started on a phone in a vendor's web UI and then forgotten is exactly the scattered-work problem in 01-vision-scope.md. Even a read-only row plus a handoff button collapses it.
- **G5** ("total recall"): a cloud session that produced a branch should at least appear in the timeline as an external origin, so history is not silently incomplete.
- **C1/C4/C7** are the reason this step is small and cautious: only official binaries (C1), no account rotation or pooling (C4), and **no screen-scraping for state** (C7) — which rules out parsing a vendor web page or an undocumented JSON endpoint. **C2** forbids direct vendor API calls outright, so the CLI is the only permitted path. **C11** additionally forbids touching Antigravity's Service backend, so `agy` participates only if a local, documented command exposes the data.
- **D4/D5**: everything a provider can do is declared in its capability manifest; adding a `cloudSessions` block keeps this feature data-driven and lets a provider opt out by omission.

## 3. Scope
### In scope
- A `cloudSessions` block in the capability manifest schema (`packages/sdk`): declares whether the provider supports listing, what argv to run, which parser to use, and what the handoff primitive is. Absent block ⇒ the provider contributes nothing, and the UI says "not available for <provider>".
- `CloudSessionProbe`: a scheduled, cheap, **quota-free** invocation of the declared command (default every 5 min while the Fleet screen is open, and on demand), with a short timeout, a circuit breaker, and no invocation at all when the provider's `AuthProbe` reports logged out.
- Normalisation into a read-only `CloudSession` view model (id, provider, title/summary, state, created/updated, repo hint, branch hint, a vendor-supplied URL if the CLI prints one) — persisted in a small table so the list survives restarts and can be diffed for change detection.
- Read-only UI: a "Cloud sessions" section on Fleet (per host, per provider), with a "not available" or "logged out" explanation where applicable, and a link that opens the vendor-supplied URL in the system browser (never in an embedded webview).
- **Handoff**: a single action, "Continue locally", that (a) creates a worktree (M1-03) on the branch or base ref the cloud session reports, (b) starts a normal local session for that provider with an initial prompt summarising the cloud session, and (c) records the provenance (`origin: {kind:'cloud', provider, externalId}`) on the local session. Handoff is one-way and never writes anything back to the vendor's cloud.
- Doctor check `cloud.listing` per provider: available / not-declared / logged-out / failed, with the last error, so an unusable integration is visible rather than silently dead.
- Documentation of exactly which command is invoked for each provider and why it is compliant.
### Out of scope (deferred to …)
- Any write action against a vendor cloud (start, stop, reply to, cancel, or approve a cloud session) — **never**, unless and until a vendor CLI documents a local command for it, which would be a new step with its own compliance review.
- Streaming a cloud session's live output into a terminal pane — **never** by scraping; only if a provider's CLI documents a local attach/tail command, which would be a new step.
- Cross-account or team-wide cloud session views — out of scope (C4).
- Merging cloud sessions into the Attention queue — deferred; a cloud session's prompts are answered in the vendor's own surface, and surfacing them here would imply a control path we do not have.
- Quota accounting for cloud sessions — deferred to **M4/M8** if a provider ever exposes it; cloud usage is not added to local window forecasts (it would corrupt them with unlabelled estimates, violating the truth-labelling principle).
- Any embedded browser, cookie jar, or credential reuse — **never** (C3).

## 4. Design
### 4.1 Domain (entities, value objects, rules)
```ts
// packages/core/src/cloud/cloud-session.ts   — a read model, not an aggregate with behaviour
export interface CloudSession {
  id: string;                    // ULID, local
  hostId: string;
  providerId: string;
  externalId: string;            // the vendor's own id, as printed by its CLI
  title: string;                 // ≤ 120 chars, from the CLI output
  state: 'running' | 'waiting' | 'completed' | 'failed' | 'unknown';
  repoHint?: string;             // repo/owner string if the CLI prints one
  branchHint?: string;
  webUrl?: string;               // only if the CLI itself printed a URL
  createdAt?: string; updatedAt?: string;
  observedAt: string;            // when our probe last saw it
  raw: unknown;                  // the parsed CLI record, for the fixture/drift path
}
export interface CloudHandoff {
  cloudSessionId: string; localSessionId: string; worktreeId: string;
  startedAt: string; initialPrompt: string;
}
```
Rules (pure, unit-tested):
- `state` is mapped from the vendor's own vocabulary by a per-provider table declared in the manifest; an unrecognised value maps to `unknown` and is **counted** (feeding the M6-02 drift detector) rather than guessed at.
- A `CloudSession` is never a `Session`: it has no pane, no worktree, no recording, and cannot be stopped from Orchestra. The type system enforces this (no shared interface, no shared table).
- A cloud session not seen by two consecutive successful probes is marked `stale` and hidden after 24 h; it is never deleted on a single failed probe, because a failed probe means "we could not look", not "it is gone".
- Handoff requires an explicit user confirm showing the worktree path, base ref and initial prompt (C10: it spends quota and writes files).

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/manifest/cloud-sessions.ts  — new optional manifest block
export const CloudSessionsCapability = z.object({
  supported: z.literal(true),
  /** Documented, quota-free listing command. argv only — never a shell string. */
  list: z.object({
    argv: z.array(z.string()),                 // e.g. ['<binary>', '<documented subcommand>', '--json']
    timeoutMs: z.number().int().max(15000).default(8000),
    parser: z.enum(['json-array', 'jsonl', 'table-columns']),
    requiresLogin: z.literal(true),
    docsUrl: z.string().url(),                 // the vendor page documenting this command
  }),
  fieldMap: z.record(z.string()),              // vendor field → CloudSession field
  stateMap: z.record(z.enum(['running','waiting','completed','failed','unknown'])),
  handoff: z.object({
    kind: z.enum(['branch-checkout', 'prompt-only']),
    /** branch-checkout: we clone/fetch the branch the listing reports and start a local session there.
     *  prompt-only: no branch information is available; we start a local session seeded with the title. */
  }).optional(),
}).or(z.object({ supported: z.literal(false), reason: z.string() }));
```
```ts
// apps/daemon/src/application/cloud/cloud-session-probe.ts
export interface CloudSessionSource {          // one per provider, DI-registered (no switch)
  readonly providerId: string;
  available(): Promise<{ ok: boolean; reason?: 'not-declared' | 'logged-out' | 'binary-missing' }>;
  list(): Promise<Result<CloudSession[], 'timeout' | 'exit-nonzero' | 'parse-failed' | 'unauthenticated'>>;
}
export class HandOffCloudSession {             // one use case per class
  execute(i: { cloudSessionId: string; repoPath: string; model?: string; actor: Actor }):
    Promise<Result<{ localSessionId: string; worktreeId: string }, DomainError>>;
}
```
**Compliance guardrails encoded in code, not prose:**
- `argv` is an array and is passed to the existing child-process runner with an explicit env allowlist (09-engineering-standards) — no shell interpolation, so a manifest cannot smuggle a pipeline.
- The first argv element must resolve through `BinaryRegistry` (M1-04) to an allowlisted, version-checked official binary; anything else is refused at manifest load.
- `apps/daemon/src/infrastructure/cloud/**` is added to the `no-vendor-endpoints` ESLint rule's **denied** set (it may not import `fetch`/`http` at all), so a future edit cannot turn this module into an API client.
- The `no-pty-regex` rule already bans regex-over-PTY in adapters; the `table-columns` parser is therefore restricted to a declared fixed-column spec over a **command's stdout**, not over pane bytes, and is only permitted when the vendor documents the column layout — otherwise `json-array`/`jsonl` only.

### 4.3 Data / schema changes
Migration `00NN_cloud_sessions.ts` (Postgres-compatible):
```
cloud_sessions(
  id text primary key, host_id text not null, provider_id text not null, external_id text not null,
  title text not null, state text not null, repo_hint text, branch_hint text, web_url text,
  created_at text, updated_at text, observed_at text not null, stale integer not null default 0,
  raw_json text not null, unique(host_id, provider_id, external_id)
)
cloud_handoffs(
  id text primary key, cloud_session_id text not null, local_session_id text not null,
  worktree_id text not null, started_at text not null, initial_prompt text not null
)
```
New events: `cloud.listed` (count per provider), `cloud.list_failed` (reason), `cloud.handoff_started`, `cloud.handoff_failed`. `sessions` gains an optional `origin_json` column (`{kind:'cloud', providerId, externalId}`) so provenance is visible in History and Replay.

### 4.4 Infrastructure (external processes)
- Probes run through the same child-process runner used by `AuthProbe` and Doctor: explicit `env` allowlist (`PATH`, `HOME`, `TERM`, `LANG` plus provider-required vars), no shell, hard timeout, SIGTERM then SIGKILL, output capped at 256 KB.
- Scheduling: only while at least one client has the Fleet screen open (a WS-topic-driven activation), plus a manual "Refresh" button and a Doctor run. Never on a fixed background timer when nobody is looking — this is someone else's service being polled with the user's account.
- Circuit breaker: 3 consecutive failures ⇒ pause that provider's probe for 30 min, surface the reason in the UI and in Doctor; reset on a successful manual refresh.
- Fixtures: each provider's listing output is recorded with `orch fixtures record <provider> --scenario cloud-list` (M1-08) into `fixtures/<cliVersion>/cloud/list.json`, redacted, and a contract test asserts the parser produces the expected `CloudSession[]`. Drift in this output is an ordinary M6-02 drift case, not a special path.
- Handoff uses only existing machinery: `WorktreeManager.create` (M1-03) with `branchHint` as the base ref when `handoff.kind = 'branch-checkout'` (falling back to the repo's default branch, with the difference shown in the confirm dialog), then the normal `StartSession` use case with the composed initial prompt.

### 4.5 API / UI surface
- `GET /api/v1/cloud/sessions?providerId=` → `CloudSession[]` + per-provider availability; `POST /api/v1/cloud/refresh` (manual probe, rate-limited to 1/min per provider); `POST /api/v1/cloud/:id/handoff` → `{ localSessionId, worktreeId }` with a `preview=true` variant returning the worktree path, base ref and initial prompt without acting.
- Fleet gains a **Cloud sessions** section per host: one group per provider with a state chip, title, age, and either a "Continue locally" button, an "Open in browser" link (system browser, `webUrl` only), or an explanation row — "not available for this CLI", "logged out", "probe failing: <reason>", "paused (circuit breaker), retry".
- Every row carries an "external — read-only" label, and the section header states in one line that Orchestra cannot control these sessions.
- `orch fleet --json` (M7-06) includes a `cloudSessions` array; no new CLI command is added.
- Doctor: `cloud.listing` check per provider as described in scope.

### 4.6 Flow / sequence
```
AVAILABILITY
 manifest load → cloudSessions block present?  no → source reports 'not-declared' → UI explains, no process ever spawned
 → BinaryRegistry resolves argv[0] to an allowlisted official binary?  no → refuse at load with a manifest error
 → AuthProbe says logged in?  no → 'logged-out', no invocation

PROBE (Fleet open, or manual, or Doctor)
 → run argv with env allowlist + timeout  [the ONLY interaction with the vendor's cloud, via their own CLI]
 → parser(stdout) → fieldMap/stateMap → CloudSession[]  (unknown state values counted → drift)
 → upsert by (hostId, providerId, externalId); mark absent rows stale after two clean probes
 → cloud.listed event → WS 'fleet' topic → UI section refreshes
 failure → cloud.list_failed{reason} → breaker++ → after 3, pause 30 min and show why

HANDOFF
 user clicks "Continue locally" → POST /cloud/:id/handoff?preview=true
 → dialog: repo, worktree path, base ref (branchHint or default, difference highlighted), provider, model,
           the composed initial prompt (editable), and "nothing is sent back to <vendor>"
 → confirm → WorktreeManager.create → StartSession(origin={kind:'cloud',…}) → cloud.handoff_started
 → the new local session appears in Terminals with an "origin: cloud" badge; the cloud row keeps its own state
```

## 5. Tasks
- [ ] **Availability check first (gate).** For each of claude, codex and agy, check the *current* official CLI documentation for a documented, local, quota-free command that lists the user's own cloud/remote sessions, and record the finding (command, docs URL, output shape, or "none") in this file's progress log. If none of the three has one, stop and set the step to ⏸. "(verify availability per CLI at step start — 05-provider-contract.md §3 records `--cloud/--teleport` and `remote-control` for Claude and `remote-control` for Codex, but does **not** document a listing command for either, and notes that agy's `remote-control` is a Google-hosted relay, not a local API.)"
- [ ] Record the outcome as a decision in `DECISIONS.md` ("Depth of cloud-session aggregation" → none / read-only monitor / handoff) with the reasoning.
- [ ] Add the `cloudSessions` manifest block to the SDK schema + JSON-schema export + manifest validation error messages.
- [ ] `CloudSessionSource` port + a DI registry + a `ManifestDrivenCloudSource` implementation (one class, driven by data, no per-vendor branches).
- [ ] BinaryRegistry enforcement at manifest load; ESLint deny-rule for `fetch`/`http` in `infrastructure/cloud/**` with a negative fixture test.
- [ ] Parsers (`json-array`, `jsonl`, `table-columns`) with property tests: no throw on any input, only `Result.err` (10-testing-strategy fuzz rule).
- [ ] Migration `00NN_cloud_sessions` + `cloud_handoffs` + `sessions.origin_json`; repositories.
- [ ] `CloudSessionProbe` with activation on Fleet visibility, manual refresh, timeout, circuit breaker, stale marking; `cloud.*` events.
- [ ] Fixtures for each participating provider (`orch fixtures record <p> --scenario cloud-list`) + contract tests + `RECORDED.md` update.
- [ ] `HandOffCloudSession` use case + preview + confirm dialog + provenance badge in Terminals/History.
- [ ] REST endpoints + Fleet "Cloud sessions" section (EN/AR), including every "not available" explanation state.
- [ ] Doctor `cloud.listing` check.
- [ ] `docs/` page: what is invoked, why it is compliant (C1/C2/C4/C7/C11), and what Orchestra deliberately cannot do with cloud sessions.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-07-01 | unit | `stateMap` with a value the manifest does not declare | maps to `unknown`, increments the unknown counter, emits no error to the user; the drift detector sees it |
| UT-M7-07-02 | unit | stale rules: a session missing from one probe, then from two, then a failed probe | not stale after one, stale after two clean probes, **never** stale because of a failed probe |
| UT-M7-07-03 | unit (property, fast-check) | `json-array` / `jsonl` / `table-columns` parsers over arbitrary bytes | never throws; always `Result`; no unbounded memory on a 256 KB input |
| UT-M7-07-04 | unit | manifest validation: `argv[0]` not in the BinaryRegistry allowlist; `argv` containing shell metacharacters as a single string | both refused at load with a named error |
| IT-M7-07-05 | integration | ESLint/dependency rule: add a `fetch()` call in `infrastructure/cloud/**` | lint fails (negative fixture, in the style of M0-08) |
| IT-M7-07-06 | integration | probe against a fake binary that exits 1 / times out / prints garbage | `exit-nonzero` / `timeout` / `parse-failed`; breaker opens after 3; no orphan child processes (`pgrep` empty after 5 s) |
| IT-M7-07-07 | integration | contract test: recorded fixture → `CloudSession[]` | exact expected rows per provider that declares support |
| IT-M7-07-08 | integration | handoff preview then execute with FakeProvider | preview creates nothing; execute creates the worktree on the reported base ref, starts a session with `origin.kind = 'cloud'`, writes `cloud_handoffs`, and makes no outbound network call (egress assertion) |
| E2E-M7-07-09 | e2e | Fleet section states: not-declared, logged-out, breaker-open, healthy with rows | each renders its own explanation; the "read-only" label is present on every row |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-07-01 | Availability finding is honest | 1. Read the progress-log entry from Task 1 2. For each provider, run the documented command by hand in a terminal 3. Compare with what the manifest declares | The manifest declares support **only** for providers where the hand-run command exists, is documented, and returns the user's own sessions; every other provider declares `supported: false` with a reason | ⬜ |
| TC-M7-07-02 | Read-only listing (participating provider) | 1. Start a cloud session in the vendor's own surface 2. Open Fleet and click Refresh | The session appears within one probe with a correct title and state; the row is labelled read-only; no control actions are offered | ⬜ |
| TC-M7-07-03 | Open in browser | 1. Click the external link on a row that has a `webUrl` | The system browser opens the vendor URL; nothing opens in an embedded webview; no cookie or token is passed by Orchestra | ⬜ |
| TC-M7-07-04 | Handoff | 1. Click **Continue locally** 2. Review the preview 3. Confirm 4. Inspect the worktree and the pane | Preview shows worktree path, base ref and the editable initial prompt plus the "nothing is sent back" note; after confirm a real local session runs in a new worktree with an "origin: cloud" badge; `git branch --show-current` matches the preview | ⬜ |
| TC-M7-07-05 | **Negative — logged out** | 1. Log out of the provider's CLI 2. Open Fleet | Row group shows "logged out — sign in with `<provider>` to see cloud sessions"; **no process is spawned** (verify with `ps`/`fs_usage` or by a debug log line); no login prompt is triggered | ⬜ |
| TC-M7-07-06 | **Negative — command removed/renamed** (drift) | 1. Edit the manifest's `list.argv` to a non-existent subcommand 2. Refresh 3. `orch doctor --check cloud.listing` | Probe fails with `exit-nonzero`, the UI shows the reason and the breaker after 3 attempts; Doctor reports the failure; a `RepairCase` is opened by the M6-02 classifier; nothing crashes | ⬜ |
| TC-M7-07-07 | **Negative — garbage output** | 1. Point the manifest at a binary that prints non-JSON 2. Refresh | `parse-failed` with the first 200 bytes shown in the diagnostic (redacted); the previous rows are kept and marked with their last `observedAt`, not deleted | ⬜ |
| TC-M7-07-08 | **Resilience — probe while offline** | 1. Disconnect the network 2. Refresh 3. Reconnect and refresh | Failure is reported as such, existing rows persist and are not marked stale, no retry storm in the logs; after reconnect the list refreshes cleanly | ⬜ |
| TC-M7-07-09 | **Compliance audit** | 1. With the feature running, capture the daemon's outbound traffic (`lsof -i` / a local proxy) for 10 minutes of Fleet use 2. `grep -rn "fetch(\|axios\|http.request" apps/daemon/src/infrastructure/cloud/` | Zero outbound connections from Orchestra to any vendor domain — the only new processes are the official CLI invocations; the grep returns nothing | ⬜ |
| TC-M7-07-10 | Quota honesty | 1. Run several probes 2. Open Fleet's windows/forecast section (M4-07) | Cloud sessions appear nowhere in local window usage or forecasts; no unlabelled estimate is introduced | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] The availability check is done first, recorded with command + docs URL (or "none") per provider, and the `DECISIONS.md` open item "Depth of cloud-session aggregation" is closed with the chosen depth.
- [ ] Support is declared **only** where a documented, local, quota-free CLI listing command exists; every other provider shows an explicit "not available" explanation and spawns no process.
- [ ] Listing is read-only: no control action on a cloud session exists in the UI, the API or the CLI.
- [ ] Handoff creates a worktree and a local session with recorded provenance, behind a preview + confirm (C10), and writes nothing back to any vendor.
- [ ] No outbound network call is made by Orchestra to any vendor service; `infrastructure/cloud/**` cannot import `fetch`/`http` (IT-M7-07-05) and the manual audit (TC-09) is clean.
- [ ] Probes are activation-driven, timeout-bounded, circuit-broken, and leave no orphan processes; failures are visible in the UI and in `orch doctor`.
- [ ] Fixtures recorded and contract tests green for every participating provider; unknown state values feed the drift detector rather than being guessed.
- [ ] Cloud usage does not enter quota windows or forecasts (TC-10).
- [ ] All TC pass; no new lint/dependency-cruiser violations; `PROGRESS.md` updated (or the step recorded as ⏸ with a reason).

## 8. Risks / open questions
- **The whole step may be unbuildable.** `05-provider-contract.md` §3 records `--cloud/--teleport` and `remote-control` for Claude Code and `remote-control` for Codex, but it does **not** document a command that *lists* a user's cloud sessions for any provider, and it explicitly notes that Antigravity's `remote-control` is a Google-hosted relay rather than a local API. Nothing here may be invented beyond that: Task 1 is a hard gate, and "none available → ⏸" is an acceptable, expected outcome. "(verify per CLI at step start)"
- The temptation to fill a gap by calling a vendor web endpoint or reusing a session cookie is exactly what C2, C3, C4 and C7 forbid. The ESLint deny-rule and the manifest's BinaryRegistry enforcement exist so that a future contributor (or the Repair Agent, C12) cannot cross that line quietly.
- Polling someone else's service with the user's own account has a rate-limit and a courtesy dimension even when it goes through their CLI; activation-only scheduling plus the circuit breaker are the mitigation, and the default interval should be raised if any vendor documents a limit.
- A cloud session's prompts cannot be answered from Orchestra, which may read as a bug to a user who sees a `waiting` row in a product whose whole premise is answering prompts. The UI must be blunt about it; if this proves confusing in TC-02, hide `waiting` cloud rows behind a "show all states" toggle rather than implying control.
- Handoff's base ref is a hint from someone else's system; if `branchHint` is absent or unfetchable the worktree silently lands on the default branch. The preview highlights the difference, but the failure mode (work continued from the wrong base) is real — consider refusing handoff without a resolvable ref if TC-04 shows the fallback is misleading.
- If a vendor later ships a documented local command for cloud *control* (reply, cancel, approve), that is a new step with its own compliance review — not an extension of this one.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
