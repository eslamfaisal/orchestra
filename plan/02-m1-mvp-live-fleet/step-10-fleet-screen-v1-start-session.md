# Step M1-10 — Fleet screen v1 + start session

| Field | Value |
|---|---|
| Milestone | M1 — MVP: Live fleet |
| Status | ⬜ Not started |
| Depends on | M1-04, M0-07 (∥) |
| Estimated effort | 2 days |
| Packages touched | `apps/web` (fleet), `apps/daemon` (sessions DTO extensions) |
| Risk | Low |
| Owner | |

## 1. Goal
The Fleet screen shows each provider as a card (installed version, verified/unverified/missing, logged in + plan, enabled toggle, ToS acknowledgement for agy, concurrency `n/max`, last detection time, "Detect now"), lists sessions (state, model, worktree, uptime, actions), and offers **Start session**: provider → model (from manifest) → repository path (recent list + picker) → worktree (new from HEAD / existing / none) → mode (interactive/managed/headless where supported) → sandbox/permission profile (safe defaults, dangerous ones flagged) → optional initial prompt → preview of the exact command and files that will be written → Start.

## 2. Why
G1, C10 (preview before spend/keys), C11 (agy ack), `12-ux-principles.md` zero-surprise control.

## 3. Scope
### In scope
- Provider cards from `GET /providers` + `fleet` WS topic; actions: detect, enable/disable, acknowledge ToS (dialog with link), copy diagnostics.
- Sessions table (all states, filter, sort) with Stop/Kill/Open in Terminals.
- Start-session wizard (5 steps, keyboard-friendly) with validation from manifest (models, modes, sandbox profiles) and a **Preview** step calling `POST /sessions/preview` that returns `{argv, cwd, env (redacted keys only), filesToWrite[]}` without launching.
- Recent repos list (localStorage; M8-01 moves to settings); repo validation (`git rev-parse`) via `GET /repos/validate?path=`.
- Safe defaults: Claude `default` permission mode; Codex `workspace-write`; agy `request-review`; dangerous profiles require an extra confirm with explanation.
- Empty states + "coming in M4" placeholders for windows/forecasts.
### Out of scope (deferred)
- Windows/forecast/KPIs → M4-07. Multi-host → M7-05. Role/policy-driven defaults → M8-02.

## 4. Design
### 4.1 Domain
`StartSessionSpec` (application DTO) validated against the manifest: `{provider, model, repoPath, worktree: {mode:'new'|'existing'|'none', existingId?, baseRef?, slug?}, mode, sandbox, initialPrompt?}`.
### 4.2 Interfaces / contracts
```ts
POST /sessions/preview  → { argv: string[]; cwd: string; envKeys: string[]; filesToWrite: { path: string; purpose: string }[]; warnings: string[] }
POST /sessions          → 201 Session   (same body as preview)
GET  /repos/validate?path=… → { ok: boolean; head?: string; branch?: string; dirty?: boolean; reason?: string }
```
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
Preview reuses `Launcher.interactive/headless` + `preLaunchFiles` in dry-run (no writes).
### 4.5 API / UI surface
Route `/fleet`; wizard as a Sheet; command palette entry "Start session".
### 4.6 Flow
`wizard → preview → confirm → POST /sessions → navigate to Terminals with the new pane focused`.

## 5. Tasks
- [ ] `POST /sessions/preview` + `GET /repos/validate` endpoints (+ audit for start).
- [ ] Provider cards + actions + ToS dialog (EN/AR copy) + diagnostics copy.
- [ ] Sessions table + actions + confirmations.
- [ ] Wizard steps with manifest-driven options; dangerous-profile confirm; recent repos.
- [ ] Preview rendering (argv, cwd, files) + warnings (e.g. dirty repo, unverified CLI version).
- [ ] Post-start navigation + toast; error envelope mapping (429 concurrency, 503 unavailable, 401 auth).
- [ ] Playwright E2E with FakeProvider through the wizard.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| IT-M1-10-01 | integration | preview for fake provider | argv/cwd/files returned; nothing written; no session row |
| IT-M1-10-02 | integration | start with model not in manifest | 400 with path `model` |
| IT-M1-10-03 | integration | start agy without ToS ack | 403 `PROVIDER_DISABLED` |
| E2E-M1-10-04 | e2e | wizard end-to-end with fake | pane appears in Terminals |
| E2E-M1-10-05 | e2e | dangerous profile requires confirm | second dialog shown; cancel keeps safe default |
| E2E-M1-10-06 | e2e | disabled provider card | start button disabled with reason tooltip |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M1-10-01 | Cards reflect machine | 1. open Fleet | claude verified/logged in; codex status per install; agy needs ack; kimi "no adapter yet" | ⬜ |
| TC-M1-10-02 | Start Claude in new worktree | 1. wizard: Claude, Sonnet, scratch repo, new worktree, interactive, default 2. Preview 3. Start | preview lists `.claude/settings.json` to be written; pane opens; worktree branch shown | ⬜ |
| TC-M1-10-03 | Existing worktree | 1. start Codex in the worktree from TC-02 | both sessions share the branch; warning about shared worktree shown | ⬜ |
| TC-M1-10-04 | Invalid repo path | 1. enter `/tmp/not-a-repo` | inline error from validate endpoint | ⬜ |
| TC-M1-10-05 | Concurrency limit | 1. set claude max 1 in config 2. start a second Claude | friendly 429 message naming the limit | ⬜ |
| TC-M1-10-06 | Stop from Fleet | 1. Stop a session | confirm → state stopping → stopped; Terminals badge updates | ⬜ |

## 7. Acceptance criteria
- [ ] Fleet cards, sessions table, wizard with preview implemented.
- [ ] Manifest-driven validation; dangerous profiles gated.
- [ ] Preview never writes or launches.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Repo picker in a browser has no native FS dialog: text input + recent list in M1; Tauri native picker in M7-01.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
