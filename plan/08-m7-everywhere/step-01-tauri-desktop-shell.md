# Step M7-01 — Tauri desktop shell

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M1-13 (MVP acceptance), M1-09 (`/term` raw WS), M1-10 (Fleet start-session wizard), M1-11 (Attention queue), M1-02 (pane reconcile/adoption), M0-04 (daemon config/token/single-instance lock) |
| Estimated effort | 4 days |
| Packages touched | `apps/desktop` (`src-tauri/`, `capabilities/`, `binaries/`, `resources/`), `apps/daemon` (bundle script, `--port`/`--adopt` flags, `desktop.*` config), `apps/web` (shell bridge, folder picker, quit-behaviour setting), `packages/sdk` (shell bridge DTOs), `tools/scripts` (`build-sidecar.sh`), `.github/workflows` (desktop build job, wired fully in M7-02) |
| Risk | High (R7 — native modules vs packaging; ADR-005 is resolved here) |
| Owner | |

## 1. Goal
Orchestra becomes a macOS application. `Orchestra.app` launches, starts `orchestrad` as a bundled sidecar (or adopts an already-running healthy one), opens a window that loads the existing web UI straight from the local daemon URL, installs a menu-bar tray showing live fleet status, raises native notifications for high-priority `AgentPrompt`s that deep-link back into the app through `orchestra://attention/<promptId>`, replaces the Fleet wizard's typed repository path with a native folder picker, and keeps agents running when the window is closed. Terminal traffic continues to flow over the raw `/term` WebSocket and never through Tauri IPC. ADR-005 (how the Node daemon is packaged inside the app) is decided and recorded here.

## 2. Why
- **D1**: "headless daemon + web UI, wrapped in a Tauri 2 macOS app" — this is the step that makes the *wrapped* half real; without it the product is a localhost bookmark.
- **G1** ("see, control and talk to every agent in one place, on any device"): a tray badge and an OS notification are what turn a prompt into something you notice within seconds instead of the next time you alt-tab; G4 ("never blocked") depends on the same latency.
- **D9/D12**: the app must ship the same Node 22 daemon, not a reimplementation — hence the ADR-005 recommendation below.
- **03-architecture.md §5**: `/term` is a binary channel with backpressure and a 40 MB/pane budget; routing it through a JSON IPC bridge would break both the encoding and the budget, so the shell deliberately keeps the webview pointed at the daemon's own origin.
- **C10**: the folder picker and the quit-behaviour setting are "zero-surprise control" surfaces — choosing a repo and killing agents are both actions the user must see before they happen.
- **C1/C2**: the shell launches only `orchestrad`; it never talks to a vendor endpoint. The only egress the shell itself performs is the update check (M7-02), which C2 allows explicitly.

## 3. Scope
### In scope
- **ADR-005 resolution** (written as `plan/adr/ADR-005-daemon-packaging.md`, status Accepted) — see §4.4.
- `apps/desktop` Tauri 2 project: `src-tauri/` (Rust), `tauri.conf.json`, capability files, icons, `Info.plist` additions for the `orchestra://` URL scheme.
- Sidecar lifecycle manager (Rust): endpoint discovery, port selection, spawn, health-wait, adopt-existing, **coordinated upgrade of an incompatible running daemon** (§4.7, ADR-020), graceful stop, crash restart with backoff, log tee to `~/.orchestra/logs/orchestrad.log`.
- Endpoint discovery file `~/.orchestra/daemon.endpoint` written by the daemon and read by the app, `orch` (M7-06) and the PWA host (M7-03) — §4.7.
- Daemon `POST /api/v1/daemon/drain` + `draining` state, so the upgrade protocol can stop new work without killing agents.
- Main window loading `http://127.0.0.1:<port>/` with an injected `window.__ORCHESTRA_SHELL__` descriptor; navigation confined to the daemon origin.
- Tray menu: fleet status line (`running / waiting / blocked`), Show Orchestra, Attention (n), Start session…, Open in browser, Restart daemon, Quit; tray icon template image reflecting the worst state.
- Native notifications for `prompt.opened` with `priority ≤ 2`, coalesced, deep-linked; `orchestra://` deep-link handler (cold start + running app).
- Native folder picker command (`pick_repo_folder`) surfaced in the M1-10 wizard, replacing the text input; recent repos still local to the web app.
- `desktop.*` settings in `~/.orchestra/config.yaml`: `quitBehaviour`, `startAtLogin`, `notifications`, `port`, `adoptExisting`, `dataDir`, `autoUpgradeDaemon`, `drainTimeoutMs`.
- Dev loop: `pnpm --filter desktop dev` runs Vite + daemon from source; `pnpm --filter desktop build` produces an unsigned `.app`.
- A shell-neutral `ShellBridge` in `apps/web` so every call degrades gracefully in a plain browser (feature detection, never `if (isTauri)` scattered through components).
### Out of scope (deferred to …)
- Code signing, hardened runtime, notarization, DMG, updater — **M7-02**.
- Windows and Linux builds — **M10-07** (release engineering); nothing in this step may hard-code macOS paths outside `src-tauri/`.
- Global hotkey, Spotlight-style quick delegate, menu-bar-only mode — **M8-08** (notification channel editors) at the earliest.
- Replacing `node-pty` with `tauri-plugin-pty` / a Rust PTY — explicitly rejected for v1 (see ADR-005 options) and not revisited before **M10**.
- Push notifications to other devices — **M7-03**. Multi-host in the tray — **M7-05**.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new core entities. The shell consumes existing read models: the `fleet` and `prompts` WS topics (M0-06, M1-11). Two shell-local value objects, both in Rust and mirrored in `packages/sdk`:

```ts
// packages/sdk/src/shell/bridge.ts
export type DaemonMode = 'spawned' | 'adopted' | 'upgraded';
export interface ShellDescriptor {
  readonly shell: 'tauri';
  readonly appVersion: string;      // Orchestra.app version
  readonly daemonUrl: string;       // http://127.0.0.1:<port>
  readonly daemonMode: DaemonMode;
  readonly platform: 'macos';
  readonly capabilities: ReadonlyArray<'folderPicker' | 'nativeNotifications' | 'tray' | 'deepLinks'>;
}
export interface TrayStatus { running: number; waiting: number; blocked: number; attention: number }
```

Rule: the web app must treat `window.__ORCHESTRA_SHELL__` as optional. `ShellBridge.pickRepoFolder()` returns `Result<string, 'unsupported' | 'cancelled'>`; on `unsupported` the wizard falls back to the M1-10 text input. No component imports `@tauri-apps/api` directly — only `apps/web/src/shell/bridge.ts` does, behind a dynamic import so the browser bundle never loads it.

### 4.2 Interfaces / contracts
```rust
// apps/desktop/src-tauri/src/daemon.rs
pub struct DaemonHandle { pub url: String, pub mode: DaemonMode, pub pid: Option<u32> }

pub enum DaemonError {
    PortUnavailable, SpawnFailed(String), HealthTimeout,
    VersionMismatch { running: String, bundled: String },
    /// Another process owns this data directory's lock and did not release it.
    LockHeld { pid: u32, data_dir: String },
    /// The user declined the coordinated upgrade (§4.7).
    UpgradeDeclined,
    /// The running daemon is NEWER than the bundled one — never downgraded automatically.
    BundledOlderThanRunning { running: String, bundled: String },
    DrainTimeout,
}

pub trait DaemonSupervisor {
    /// Read `<data-dir>/daemon.endpoint`, probe `GET /health` on the URL it names
    /// (falling back to `cfg.port` once if the file is absent).
    ///   healthy + compatible version + adoptExisting → adopt it (mode = adopted)
    ///   healthy + incompatible version               → `upgrade` (§4.7), never a second daemon
    ///   nothing healthy                              → acquire the data-dir lock, spawn, wait for health
    fn ensure_running(&self, cfg: &DesktopConfig) -> Result<DaemonHandle, DaemonError>;
    /// Coordinated upgrade of the daemon that currently owns this data directory:
    /// drain → stop → wait for lock release → spawn bundled → reconcile → publish endpoint.
    fn upgrade(&self, cfg: &DesktopConfig, running: &Endpoint) -> Result<DaemonHandle, DaemonError>;
    fn stop(&self, graceful_ms: u64) -> Result<(), DaemonError>; // SIGTERM → wait → SIGKILL
    fn restart(&self) -> Result<DaemonHandle, DaemonError>;
}
```
```rust
// Tauri commands exposed to the webview (the ONLY IPC surface in this step)
#[tauri::command] async fn pick_repo_folder(app: AppHandle) -> Result<Option<String>, String>;
#[tauri::command] fn shell_descriptor(state: State<AppState>) -> ShellDescriptor;
#[tauri::command] fn set_quit_behaviour(state: State<AppState>, v: QuitBehaviour) -> Result<(), String>;
#[tauri::command] fn restart_daemon(state: State<AppState>) -> Result<String, String>; // returns new url
```
Deliberately **not** commands: anything terminal-related, anything that reads or writes vendor files, anything that takes a shell string. There is no `execute`/`shell` plugin in the capability set.

### 4.3 Data / schema changes
None in SQLite. New config block, validated by the existing Zod config schema (M0-04):
```yaml
desktop:
  dataDir: ~/.orchestra   # the runtime namespace this app owns (ADR-020)
  port: 4300              # PREFERRED port when this app spawns; discovery still wins (§4.7)
  adoptExisting: true
  autoUpgradeDaemon: false     # true = run the §4.7 upgrade protocol without asking
  drainTimeoutMs: 10000        # drain + lock-release budget before SIGKILL
  quitBehaviour: keep-daemon   # keep-daemon | stop-daemon | ask
  startAtLogin: false
  notifications:
    enabled: true
    minPriority: 2        # AgentPrompt priority 1..5 (M1-11)
    coalesceWindowMs: 3000
```

### 4.4 Infrastructure (ADR-005: how the daemon is packaged)
| Option | Size | Native modules | Effort | Verdict |
|---|---|---|---|---|
| **A — Node SEA single executable** (`node --experimental-sea-config`) | ~95 MB, one Mach-O | `better-sqlite3` and `node-pty` are `.node` addons; SEA cannot embed them, they must be extracted to disk at runtime and `dlopen`'d from a writable path — which fights the hardened runtime and library validation | medium, but the failure modes are discovered at notarization time | **Rejected for v1**: the exact combination (SEA + native addons + hardened runtime) is the least-documented path and R7 is already the milestone's top risk |
| **B — Bundled Node 22 runtime + esbuild-bundled daemon + prebuilt `.node` files** | ~110 MB per arch | shipped as ordinary `.node` files inside `Contents/Resources`, each one signed like any other Mach-O | low; every piece is a normal file | **Recommended — accepted** |
| **C — Rust port of the terminal plane** | smallest | none | very high; forks the codebase in two languages, contradicts D9 | **Rejected for v1**; revisit only if budgets fail |

**Accepted: Option B.** Layout inside the bundle:
```
Orchestra.app/Contents/
  MacOS/Orchestra                                   (Tauri binary)
  Resources/
    binaries/orchestrad-aarch64-apple-darwin        (Tauri `externalBin`, = the Node 22 executable renamed)
    binaries/orchestrad-x86_64-apple-darwin
    daemon/orchestrad.cjs                           (esbuild bundle of apps/daemon, --platform=node --target=node22, CJS)
    daemon/native/<arch>/better_sqlite3.node
    daemon/native/<arch>/pty.node  + spawn-helper   (node-pty ships an auxiliary Mach-O; it must be signed too)
    daemon/migrations/*.js                          (Kysely migrations are read from disk, not bundled)
    web/                                            (built apps/web, served by the daemon as today)
```
Notes and constraints:
- Tauri's `externalBin` requires the target-triple suffix; the build script downloads the **official Node 22 LTS** macOS tarball per arch, verifies its SHASUMS, and copies `bin/node` to that name. The sidecar is launched as `orchestrad-<triple> <resources>/daemon/orchestrad.cjs --port <p> --resources <dir>`.
- Native addons are rebuilt/downloaded per arch with `prebuild-install` (or `pnpm rebuild` on a matching runner) into `daemon/native/<arch>/`; the daemon resolves them via an explicit `require(path.join(resourcesDir,'native',process.arch,…))` shim rather than `bindings`/`node-gyp-build` path guessing.
- **Universal binaries are not used.** Two separate `.app` builds (arm64, x64) are produced; the DMG in M7-02 ships arm64 by default with an x64 build available. Rationale: `lipo`-ing native addons plus two Node runtimes doubles the notarization surface for a user base that is arm64 first.
- `tauri.conf.json` keys that matter here:
```jsonc
{
  "productName": "Orchestra",
  "identifier": "dev.orchestra.app",
  "build": { "frontendDist": "../placeholder", "beforeBuildCommand": "pnpm run build:sidecar" },
  "app": {
    "windows": [{ "label": "main", "title": "Orchestra", "width": 1440, "height": 900,
                  "minWidth": 900, "minHeight": 600, "url": "http://127.0.0.1:4300/",
                  "titleBarStyle": "Overlay", "visible": false }],
    "security": { "csp": null, "capabilities": ["local-daemon"] },
    "trayIcon": { "id": "main", "iconPath": "icons/tray.png", "iconAsTemplate": true }
  },
  "bundle": {
    "active": true, "targets": ["app", "dmg"], "category": "DeveloperTool",
    "externalBin": ["binaries/orchestrad"],
    "resources": ["resources/daemon/**/*", "resources/web/**/*"],
    "macOS": { "minimumSystemVersion": "14.0" }
  },
  "plugins": { "deep-link": { "desktop": { "schemes": ["orchestra"] } } }
}
```
  The window `url` is rewritten at runtime when the port is not 4300 (`WebviewWindowBuilder` with the resolved URL; the static entry stays for the dev loop). `"visible": false` + show-on-ready avoids the white flash. `"minimumSystemVersion": "14.0"` is the OS floor that M7-02's updater also enforces.
- **Remote-origin IPC**: the window loads `http://127.0.0.1:<port>`, which is a *remote* origin to Tauri. A single capability file scopes IPC to that origin and to four commands:
```jsonc
// apps/desktop/src-tauri/capabilities/local-daemon.json
{ "identifier": "local-daemon", "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:*", "http://localhost:*"] },   // (verify key name against Tauri 2 docs at step start)
  "permissions": ["core:event:default", "dialog:allow-open", "notification:default",
                  { "identifier": "core:window:allow-set-focus" },
                  "allow-pick-repo-folder", "allow-shell-descriptor",
                  "allow-set-quit-behaviour", "allow-restart-daemon"] }
```
  No `shell:allow-execute`, no `fs:*`, no `http:*` permission is granted to the webview. `dialog:allow-open` is the folder picker only (directory mode).
- The injected descriptor uses `initialization_script` so it is present before the first paint on a remote URL.
- Logs: the sidecar's stdout/stderr are tee'd to `~/.orchestra/logs/orchestrad.log` and to the Tauri log plugin; a tray item opens the folder.
- Crash policy: sidecar exit with a non-zero code → restart with backoff 1 s, 2 s, 5 s, 15 s (max 4 attempts in 5 min); after that the tray goes red and the window shows a "daemon stopped" screen with the last 50 log lines and a Retry button. Agents are unaffected — they live in tmux (D2).

### 4.5 API / UI surface
- New daemon flags: `--port <n>`, `--data-dir <dir>`, `--resources <dir>`, `--adopt-check` (prints the endpoint record and exits 0 if healthy).
- New daemon routes: `GET /api/v1/shell/status` → `{ running, waiting, blocked, attention }` (cheap aggregate for the tray; the tray otherwise consumes the `fleet` WS topic); `POST /api/v1/daemon/drain` → `{ state: 'draining', inFlight: n }` (§4.7), idempotent, token-authenticated, refuses nothing else.
- Web: `apps/web/src/shell/bridge.ts` (`ShellBridge`), `useShell()` hook; Fleet wizard step 3 gets a **Choose repository…** button when `capabilities` includes `folderPicker`; Settings → Desktop pane (quit behaviour radio, start at login, notification min-priority, "Open logs folder").
- Deep links: `orchestra://attention/<promptId>`, `orchestra://session/<sessionId>`, `orchestra://terminals`. Handler maps to the web route and calls `window.location.assign(daemonUrl + route)` on the existing webview (no new window).
- Tray menu items as listed in scope; the status line is a disabled item refreshed on every `fleet`/`prompts` delta, throttled to 1 Hz.

### 4.6 Flow / sequence
```
app launch
 → load DesktopConfig (~/.orchestra/config.yaml, defaults if absent)
 → DaemonSupervisor.ensure_running()
      read <data-dir>/daemon.endpoint (fall back to cfg.port once if absent)
      GET /health ──healthy & major.minor match & adoptExisting──▶ mode = adopted
                  ──healthy & incompatible version─────────────▶ coordinated upgrade (§4.7) → mode = upgraded
                                                                 (NEVER a second daemon on this data dir)
      └─ nothing healthy: acquire <data-dir>/orchestrad.lock → pick port (preferred: endpoint/cfg)
                          → spawn sidecar → poll /health (250 ms, 20 s budget) → mode = spawned
 → read ~/.orchestra/token (0600) → build window URL
 → WebviewWindow(main, url) with initialization_script(__ORCHESTRA_SHELL__ = descriptor)
 → tray init → open WS /ws?token=… from Rust (tokio-tungstenite) subscribing topics ['fleet','prompts']
 → on prompt.opened (priority ≤ minPriority): coalesce 3 s → notification(title, body, deep link)
 → user clicks notification → orchestra://attention/<id> → focus window → navigate route
window close (⌘W / red button) → hide window, app stays in tray, daemon untouched
Quit (⌘Q / tray Quit):
   quitBehaviour = keep-daemon → detach sidecar (it keeps running; next launch adopts it)
   quitBehaviour = stop-daemon → SIGTERM sidecar, wait 5 s, SIGKILL; tmux agents keep running regardless
   quitBehaviour = ask        → modal: "Keep agents' daemon running?" [Keep] [Stop] [Cancel]
```

### 4.7 Daemon ownership and the coordinated upgrade protocol (ADR-020)
**One daemon owner per data directory.** `~/.orchestra` (or `--data-dir <d>`) is a single-writer runtime namespace: the SQLite file, the tmux socket name, the recording store, the token, and the endpoint file all belong to it. M0-04's single-instance lock — now explicitly `<data-dir>/orchestrad.lock` next to `orchestrad.pid` — is held by exactly one process, and a second `orchestrad` started against the same data directory refuses to boot with exit 3 *whatever port it was given*. The shell never works around that lock, and "spawn on a different port" is not an upgrade strategy: a second supervisor on one data directory would mean two owners of the same DB, the same tmux socket and the same session rows.

**Endpoint discovery.** The daemon writes `<data-dir>/daemon.endpoint` (mode 0600, written to a temp file and `rename`d, so readers never see a half-file) once it is listening, and removes it on graceful shutdown:
```json
{ "url": "http://127.0.0.1:4317", "port": 4317, "pid": 8821, "version": "1.4.2",
  "apiVersion": "v1", "dataDir": "/Users/x/.orchestra", "tmuxSocket": "orchestra",
  "startedAt": "2026-09-15T10:03:11.412Z" }
```
`Orchestra.app`, `orch` (M7-06) and the PWA host (M7-03) all resolve the daemon through this file instead of assuming 4300; `desktop.port` is only the *preferred* port used when this app is the one spawning. **No reader caches a stale port beyond one failed health check**: on connection-refused, a health 4xx/5xx, or a `pid` that no longer exists, the reader re-reads `daemon.endpoint` exactly once, and if that still fails it declares the daemon down rather than retrying a remembered URL.

**Version mismatch runs the upgrade protocol; it never spawns a second daemon.**
```
detect mismatch: endpoint.version vs bundled version, compared on major.minor
 → desktop.autoUpgradeDaemon = false → modal: "Orchestra 1.5.0 needs to upgrade the running daemon (1.4.2).
      Agents already running stay alive. No new sessions start until the upgrade finishes."
      [Upgrade] [Open in browser instead] [Quit]     ← declining is UpgradeDeclined, not a second daemon
   desktop.autoUpgradeDaemon = true  → proceed; tray shows "upgrading daemon…"
 → DRAIN:    POST /api/v1/daemon/drain → daemon state `draining`: new session starts rejected with
             409 `daemon_draining`, in-flight HTTP/WS requests finish, the event store flushes.
             Running agents are NOT touched — they are tmux panes (D2), not daemon children.
 → STOP:     SIGTERM the old daemon → it closes the DB, removes daemon.endpoint, releases orchestrad.lock,
             and leaves the tmux server and every pane running. Budget `drainTimeoutMs` (default 10 s),
             then SIGKILL; the lock is reclaimed only after the pid is confirmed gone.
 → START:    spawn the bundled sidecar on the SAME data dir, preferring the port the old daemon used so
             helpers reconnect to the same URL → it runs Kysely migrations → waits for /health.
 → ADOPT:    M1-02 reconcile runs: panes tagged ORCH_SESSION_ID are adopted, DB-running-but-missing panes
             are marked `crashed`, orphan policy as configured. The ReconcileReport is surfaced, not swallowed.
 → PUBLISH:  the new daemon writes daemon.endpoint; `orch`, other browser tabs and the PWA pick it up on
             their next failed request (one re-read, per the discovery rule above).
 → mode = 'upgraded'; the window loads the resolved URL and shows a banner:
   "Daemon upgraded 1.4.2 → 1.5.0 · N sessions adopted · M marked crashed".
```
Compatibility rule: `major.minor` equal → adopt as-is (patch drift is adopted, not upgraded); otherwise run the protocol. **Downgrade is never automatic**: if the running daemon is newer than the bundled one (`BundledOlderThanRunning`), the app refuses to drain or stop it and tells the user to update the app — an older daemon must never be pointed at a database migrated by a newer one.

**The only supported second daemon** is a fully separate runtime namespace: its own `--data-dir`, its own tmux socket name (`tmux -L <socket>`, so panes cannot be cross-adopted), its own port and its own `daemon.endpoint`. `desktop.dataDir` exists for exactly that (a dev instance beside a production one). Two daemons sharing one data directory is not a configuration this product supports.

**Prompts across the upgrade.** The guarantee is M5-05's: durable prompts with explicit recovery outcomes, not "nothing is lost". A prompt whose answer was submitted but never structurally acknowledged stays `delivery_uncertain` (M1-11 answer states) across the restart and is re-surfaced for a human decision; it is never silently marked answered because the daemon changed.

## 5. Tasks
- [ ] Write `plan/adr/ADR-005-daemon-packaging.md` with the three options, the decision (Option B), and the consequences; update `plan/DECISIONS.md` row to Accepted and link it here.
- [ ] `rustup` install + `cargo tauri` CLI; record versions in `plan/ENVIRONMENT.md` log.
- [ ] Scaffold `apps/desktop` (Tauri 2), wire into pnpm workspace + turbo (`build:desktop` depends on `build:daemon`, `build:web`).
- [ ] `tools/scripts/build-sidecar.sh`: download + checksum Node 22 per arch, esbuild `apps/daemon` → `orchestrad.cjs`, stage native addons per arch, copy migrations + built web, emit `resources/` and `binaries/` trees; idempotent, with a manifest file listing every staged artifact (M7-02 signs from this list).
- [ ] Daemon: `--port`/`--data-dir`/`--resources`/`--adopt-check` flags; native-module resolution shim; `GET /api/v1/shell/status`; `desktop.*` config schema.
- [ ] Daemon: `<data-dir>/orchestrad.lock` (extends M0-04's single-instance lock with the data-dir identity), atomic `daemon.endpoint` write on listen + unlink on graceful stop, `POST /api/v1/daemon/drain` and the `draining` state (409 `daemon_draining` for new session starts).
- [ ] Rust `DaemonSupervisor` (discover/spawn/adopt/health-wait/**upgrade**/stop/restart/backoff) + unit tests with a stub daemon binary.
- [ ] Coordinated upgrade protocol end to end (§4.7): mismatch detection, consent modal + `autoUpgradeDaemon`, drain, stop, lock-release wait, spawn, reconcile banner, endpoint republish; downgrade refusal.
- [ ] Endpoint-discovery helper shared by the app and `orch` (M7-06): read file → health → one re-read on failure → "daemon down"; no cached port.
- [ ] Main window creation with resolved URL + `initialization_script` + show-on-ready + navigation allowlist (block any URL not on the daemon origin).
- [ ] Capability file `local-daemon.json`; four Tauri commands; assert in a test that no `shell`/`fs`/`http` permission is present.
- [ ] Tray: icon states, menu, live status from the Rust WS client, 1 Hz throttle.
- [ ] Notifications: priority filter, coalescing, deep-link payload, "Open Attention" fallback when the prompt is already answered.
- [ ] `orchestra://` scheme registration (`Info.plist` `CFBundleURLTypes`) + cold-start and warm-start handlers.
- [ ] `apps/web` `ShellBridge` + `useShell()` + Fleet wizard folder picker + Settings → Desktop pane (EN/AR strings).
- [ ] Verify terminals still use `/term` in the shell: add a dev-panel counter for Tauri IPC messages and assert it stays 0 while a pane streams.
- [ ] Unsigned `.app` build on both arches; smoke-run each under Rosetta/native as available; record app size and cold-start time in `evidence/`.
- [ ] CI job `desktop-build` (unsigned, artifact upload only) so packaging breakage is caught before M7-02.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-01-01 | unit (Rust) | `DaemonSupervisor::ensure_running` with a healthy stub on the configured port | `mode = adopted`, no process spawned |
| UT-M7-01-02 | unit (Rust) | `ensure_running` when `/health` reports an incompatible daemon version (`autoUpgradeDaemon = false`, consent declined) | `UpgradeDeclined`; **no second daemon spawned on the same data dir**; the old daemon is still listening on its port and still owns the lock |
| UT-M7-01-03 | unit (Rust) | health poll never answers within 20 s | `HealthTimeout`; child killed; no orphan process (`ps` assertion in the test harness) |
| UT-M7-01-04 | unit | `ShellBridge.pickRepoFolder()` in a plain browser (no `__ORCHESTRA_SHELL__`) | `err('unsupported')`; wizard renders the text input |
| UT-M7-01-05 | unit | notification coalescing: 5 `prompt.opened` within 3 s | one notification, body "5 prompts need you", deep link `/attention` |
| IT-M7-01-06 | integration | `build-sidecar.sh` output tree | manifest lists `orchestrad.cjs`, both `.node` files for the host arch, `spawn-helper`, migrations, web assets; `node orchestrad.cjs --adopt-check` exits 0 against a running daemon |
| IT-M7-01-07 | integration | capability file audit | parsed `local-daemon.json` contains none of `shell:`, `fs:`, `http:` permissions; command list equals the four allowed commands |
| IT-M7-01-08 | integration | deep-link parser | `orchestra://attention/01J…` → route `/attention/01J…`; unknown host → `/attention`; path traversal (`orchestra://attention/../../etc`) → rejected |
| UT-M7-01-14 | unit (Rust) | endpoint discovery: `daemon.endpoint` names port 4317, nothing listens there | one re-read of the file, then `daemon down`; the stale port is not retried and is not cached for the next probe |
| UT-M7-01-15 | unit (Rust) | `upgrade()` happy path against a stub daemon | order is drain → SIGTERM → lock released → spawn → health → reconcile → endpoint written; `mode = upgraded`; the stub records exactly one drain call |
| UT-M7-01-16 | unit (Rust) | `upgrade()` when the stub ignores SIGTERM | SIGKILL after `drainTimeoutMs`; the new daemon is spawned only after the lock file's pid is confirmed gone; never two live pids on the data dir |
| UT-M7-01-17 | unit (Rust) | bundled version older than the running daemon | `BundledOlderThanRunning`; no drain, no stop, no spawn; user-facing message says to update the app |
| IT-M7-01-18 | integration | second `orchestrad` started with the same `--data-dir` on a different port | exits 3 `already running (pid N)`; no DB write, no `daemon.endpoint` overwrite, no tmux socket touched |
| IT-M7-01-19 | integration | two daemons with separate `--data-dir` + tmux socket + port | both boot, each writes its own `daemon.endpoint`, neither adopts the other's panes (`ORCH_SESSION_ID` lookups are socket-scoped) |
| IT-M7-01-20 | integration | drain semantics | during `draining`: `POST /sessions` → 409 `daemon_draining`; an in-flight request completes; live tmux panes still present after the daemon exits |
| E2E-M7-01-09 | e2e | built `.app` + FakeProvider: launch, start a fake session, stream output | pane renders; Tauri IPC message counter = 0 for the duration; app exit leaves no orphan node process when `quitBehaviour = stop-daemon` |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-01-01 | Cold launch, spawned daemon | 1. `pkill orchestrad` 2. launch `Orchestra.app` 3. watch tray 4. `pgrep -lf orchestrad` | Window appears < 3 s with Attention loaded; tray shows `0 running`; exactly one `orchestrad` child whose parent is the app | ⬜ |
| TC-M7-01-02 | Adopt an already-running daemon | 1. `pnpm --filter daemon start` in a terminal 2. launch the app | No second daemon spawned (`pgrep -c orchestrad` = 1); Settings → Desktop shows "daemon: adopted"; sessions started from the terminal-run daemon are visible | ⬜ |
| TC-M7-01-03 | Terminals over raw WS | 1. start a Claude session 2. open Terminals 3. type a long paste 4. open the dev panel IPC counter | Output streams; echo feels instant; IPC counter stays 0; `lsof -p <app pid>` shows no extra sockets beyond the daemon origin | ⬜ |
| TC-M7-01-04 | Native folder picker | 1. Fleet → Start session 2. click **Choose repository…** 3. pick `~/orchestra-scratch` 4. Cancel on a second attempt | Picker is the macOS directory sheet; path fills the field and validates (`/repos/validate` ok); cancel leaves the previous value untouched | ⬜ |
| TC-M7-01-05 | Window close keeps agents | 1. with a live pane, press `⌘W` 2. `tmux -L orchestra ls` 3. `pgrep orchestrad` 4. tray → Show Orchestra | tmux window and daemon both alive; reopened window shows the pane still streaming with replayed scrollback | ⬜ |
| TC-M7-01-06 | Quit behaviour: keep vs stop | 1. set `keep-daemon`, `⌘Q`, check `pgrep orchestrad` 2. set `stop-daemon`, relaunch, `⌘Q`, check again 3. `tmux -L orchestra ls` after both | Case 1: daemon alive. Case 2: daemon gone within 5 s, no orphan. tmux agents alive in **both** cases | ⬜ |
| TC-M7-01-07 | Notification deep link (cold start) | 1. quit the app with `stop-daemon` 2. start the daemon from a terminal 3. trigger a Claude permission prompt 4. `open "orchestra://attention/<promptId>"` | App launches, adopts the daemon, and lands directly on the prompt card (not the queue root) | ⬜ |
| TC-M7-01-08 | Notification coalescing + stale prompt | 1. trigger 4 prompts quickly 2. answer them all in the browser 3. click the notification | One notification for the burst; clicking it opens `/attention` with an "already answered" toast, no error screen | ⬜ |
| TC-M7-01-09 | **Negative** — daemon crash loop | 1. replace `resources/daemon/orchestrad.cjs` with a script that exits 1 immediately 2. launch the app | 4 restart attempts with visible backoff, then red tray + "daemon stopped" screen with the last log lines and a Retry button; the app itself does not crash or spin the CPU | ⬜ |
| TC-M7-01-10 | **Negative** — port already taken by something else | 1. `nc -l 4300` in a terminal 2. launch the app | Health probe fails fast (not a 20 s hang), a free port is chosen, the window loads on it, Settings shows the actual port | ⬜ |
| TC-M7-01-11 | **Negative** — missing native addon | 1. rename `resources/daemon/native/<arch>/better_sqlite3.node` 2. launch | Daemon exits with a readable error; the app shows the "daemon stopped" screen naming the missing module; nothing silently falls back to an in-memory DB | ⬜ |
| TC-M7-01-12 | **Resilience** — daemon killed while the app is open | 1. with a pane streaming, `kill -9` the daemon 2. watch | Tray goes amber → daemon restarts → the web app reconnects over WS (`sinceEventId`, M5-05) and the pane resumes; no lost prompt; restore banner appears | ⬜ |
| TC-M7-01-14 | Coordinated daemon upgrade (consent) | 1. run daemon v(n-1) from a terminal with 2 live sessions 2. launch an app bundling v(n) 3. accept the upgrade 4. `pgrep -c orchestrad` throughout 5. `tmux -L orchestra ls` | Modal explains the upgrade and that agents stay alive; count never exceeds 1; both panes still alive and adopted; banner reports "N adopted"; `~/.orchestra/daemon.endpoint` now names the new pid/version | ⬜ |
| TC-M7-01-15 | Upgrade declined | 1. same setup 2. choose **Open in browser instead** | No drain, no kill, no second daemon (`pgrep -c orchestrad` = 1); the browser opens the old daemon's URL; the app quits or stays in the tray without owning a daemon | ⬜ |
| TC-M7-01-16 | Helpers re-read the endpoint | 1. open `orch fleet --watch` in a terminal against the old daemon 2. run the upgrade 3. watch the CLI | The CLI's request fails once, it re-reads `daemon.endpoint`, reconnects to the new daemon and keeps streaming; it never hangs on the old port | ⬜ |
| TC-M7-01-17 | **Negative** — two daemons, one data dir | 1. daemon running 2. `orchestrad --data-dir ~/.orchestra --port 4399` | Exits 3 with "already running (pid N)"; `daemon.endpoint` still names the first daemon; no DB corruption, no new tmux server | ⬜ |
| TC-M7-01-18 | Separate namespace side-by-side | 1. `orchestrad --data-dir ~/.orchestra-dev --port 4399` with tmux socket `orchestra-dev` 2. launch the app (prod data dir) | Both run; each tray/CLI sees only its own sessions; killing one leaves the other's panes untouched | ⬜ |
| TC-M7-01-19 | Prompt across an upgrade | 1. trigger a permission prompt 2. run the upgrade before answering 3. open Attention | The prompt is still there after the upgrade with its original text and generation; if an answer had been submitted but not acknowledged it shows `delivery_uncertain` and asks for a decision — it is never auto-resolved | ⬜ |
| TC-M7-01-13 | Both architectures | 1. build and launch the arm64 `.app` 2. on an x64 Mac (or `arch -x86_64` where possible) launch the x64 build | Both start their own sidecar, load native addons, and run a FakeProvider session; record app sizes in `evidence/` | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] ADR-005 written, status Accepted, linked from `DECISIONS.md`, and the chosen option is the one actually implemented.
- [ ] `Orchestra.app` (unsigned) builds for `darwin-arm64` and `darwin-x64` from a clean checkout with one command, including the sidecar staging script.
- [ ] Daemon lifecycle: discover, spawn, adopt, health-wait, graceful stop, crash backoff — all implemented and covered by UT-M7-01-01..03.
- [ ] **One daemon owner per data directory (ADR-020)**: the app never runs a second daemon against a data directory that already has one; a version mismatch resolves through the §4.7 protocol (drain → stop → start bundled → reconcile → republish endpoint) or through an explicit refusal; downgrade is refused. Covered by UT-M7-01-15..17, IT-M7-01-18, TC-M7-01-14/15/17.
- [ ] `daemon.endpoint` is written atomically by the daemon and is the only way the app, `orch` and the PWA resolve the daemon URL; no component caches a port past one failed health check (UT-M7-01-14, TC-M7-01-16).
- [ ] Tray shows live fleet status; native notifications fire for priority ≤ configured threshold and deep-link to the exact prompt.
- [ ] Terminals demonstrably use `/term` only — IPC counter 0 during streaming (TC-M7-01-03), and the capability audit test (IT-M7-01-07) passes.
- [ ] Native folder picker replaces the M1-10 text input inside the shell and degrades to the text input in a plain browser.
- [ ] Closing the window never stops agents; quit behaviour is configurable and honoured; tmux agents survive every quit path.
- [ ] Cold start to interactive window ≤ 3 s on the dev machine, recorded in `evidence/`; app bundle size recorded.
- [ ] All TC pass; no new lint/dependency-cruiser violations (`apps/desktop` added to the depcruise config with a rule that it imports nothing from `apps/daemon` source).
- [ ] `plan/ENVIRONMENT.md` updated with Rust/Tauri versions; `apps/desktop/README.md` documents the dev loop and the bundle layout.

## 8. Risks / open questions
- **R7**: `node-pty`'s `spawn-helper` is a separate Mach-O inside the addon and is easy to miss when signing; it is listed explicitly in the build manifest so M7-02 signs it. Whether the hardened runtime needs `com.apple.security.cs.disable-library-validation` for these addons is decided in M7-02 — "(verify)" by experiment, and the answer determines whether Option B survives.
- The exact Tauri 2 capability key for remote-origin IPC (`remote.urls`) and its wildcard syntax must be checked against the Tauri version pinned at step start — "(verify)". If wildcards are not allowed on ports, the window must be built after the port is known and the capability generated at runtime, or the port must be fixed to 4300.
- The upgrade protocol has a window between "old daemon exited" and "new daemon healthy" in which no daemon is accepting prompts. Agents keep running (tmux), but a vendor prompt raised in that window is only captured when the agent re-emits it or the hook retries — this is the M5-05 "capture during daemon downtime" guarantee, and the banner must state the window length rather than implying nothing could have been missed.
- `drainTimeoutMs` is a guess; measure the real drain time with a loaded event store before fixing the default, and never let SIGKILL precede a confirmed flush of the event store.
- Whether the consent modal should offer "upgrade later, keep using the old daemon read-only" is an open UX question; v1 offers Upgrade / Open in browser / Quit only.
- Tray status derived from a Rust WS client duplicates the web app's subscription; if this proves flaky, fall back to polling `GET /api/v1/shell/status` at 2 s — measured, not assumed.
- `titleBarStyle: Overlay` interacts with the web app's own header layout; if it looks wrong, fall back to the default title bar rather than spending time here.
- macOS 14.0 as the floor is a guess aligned with the plan's "macOS 14+" note; confirm against the actual `objc2`/WebKit requirements of the pinned Tauri version — "(verify)".

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
