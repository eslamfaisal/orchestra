# M7 — Everywhere

| | |
|---|---|
| Steps | 7 (M7-01 … M7-07) |
| Effort | ~15 days |
| Status | ⬜ |
| Entry | M1-13 ✅ (MVP tag `mvp-1`); M5-05 ✅ (restore with zero lost prompts, `sinceEventId` WS protocol); Rust toolchain installed (`rustup`, ENVIRONMENT.md says **missing**); Apple Developer Program membership active with a Developer ID Application certificate |
| Exit | a signed and notarized Orchestra.app installs on a clean Mac with **zero Gatekeeper dialogs**, updates itself through a verified round-trip, and the same fleet is reachable from an installed PWA on a phone over a private tunnel where an `AgentPrompt` can be **approved from the lock-screen notification**, from any of several hosts, and scripted from `orch` |

## Goal
Take the single-browser-tab MVP and put it on every surface the first persona actually uses: a real macOS application (Tauri 2 shell, tray, native notifications, `orchestra://` deep links, the daemon shipped as a signed sidecar), a distribution story that survives Gatekeeper and can safely update itself, an installable PWA with Web Push so a permission prompt can be approved from a phone in seconds, a documented and hardened remote-access path (Tailscale / Cloudflare Tunnel in front of a daemon that still binds `127.0.0.1` only), one UI that talks to several daemons at once, and a single consolidated `orch` CLI with machine-readable output. M7-07 (cloud-session aggregation) is explicitly optional and may be dropped without affecting the milestone exit.

## Why this milestone now
D1 says the product is a headless daemon plus one web UI wrapped in a Tauri app with a PWA for phone — M0/M1 delivered the daemon and the browser UI, and everything since (M2–M6) has been depth, not reach. G1's measurable target ("live terminal + chat for 100 % of sessions; **phone approve/answer**") is still unmet, and G4 ("never blocked") is only half true while the only way to unblock an agent is to be sitting at the machine that runs it. M7 waits for M5 because the offline answer queue and the multi-host merge both reuse the `subscribe { topics, sinceEventId } → snapshot + delta` protocol and the prompt re-derivation semantics built in M5-05; shipping push notifications on top of a session layer that loses prompts on restart would notify the user about work items that then vanish. It also resolves ADR-005 (daemon packaging inside Tauri), which has been open since the tech stack was pinned and which blocks any distributable build.

## Entry criteria
- [ ] M1-13 ✅ and tagged `mvp-1`; M5-05 ✅ (restore metric `restore_lost_prompts = 0` on the soak run).
- [ ] `rustup` installed; `rustc --version` and `cargo --version` recorded in ENVIRONMENT.md; `cargo tauri --version` (Tauri 2 CLI) works.
- [ ] Apple Developer Program membership active; Developer ID Application + Developer ID Installer certificates in the login keychain; an App Store Connect API key (Issuer ID, Key ID, `.p8`) available for `notarytool`.
- [ ] A second machine or VM available for M7-05 (a Linux box or a second Mac running `orchestrad`) and a clean macOS VM/user account for the M7-02 Gatekeeper test.
- [ ] A phone (iOS 16.4+ or Android) on the same Tailscale tailnet or able to reach a Cloudflare Tunnel hostname — iOS requires the PWA to be **installed to the Home Screen** before Web Push works "(verify against the current iOS release at step start)".
- [ ] ADR-003 (Node floor) accepted — the bundled runtime version is fixed by it.

## Exit criteria
- [ ] `Orchestra.app` built from `apps/desktop` launches, starts the bundled `orchestrad` sidecar, and shows the web UI from `http://127.0.0.1:<port>` with live terminals over the raw `/term` WS (never Tauri IPC).
- [ ] Tray icon shows fleet status (running / waiting / blocked counts) and a native notification for a new high-priority `AgentPrompt` opens the app on `/attention/<promptId>` via `orchestra://attention/<promptId>`.
- [ ] Closing the window leaves agents running; quit behaviour is a setting and is honoured (verified by `pgrep orchestrad` + `tmux ls`).
- [ ] **Zero Gatekeeper dialogs**: a clean macOS user account downloads the released `.dmg` over HTTPS, mounts it, drags the app to `/Applications`, launches it — no "unidentified developer", no "downloaded from the internet" prompt beyond the standard first-open *Open* confirmation for a quarantined app, and `spctl -a -vvv Orchestra.app` reports `accepted, source=Notarized Developer ID`.
- [ ] **Updater round-trip**: from version N the app detects N+1, downloads it, verifies the updater signature **before** replacing anything, installs, relaunches on N+1, and a tampered artifact is rejected with the old version left intact and runnable.
- [ ] **Approve a prompt from phone**: with the phone offline from the LAN and connected only via the tunnel, a Claude Code permission prompt raises a Web Push notification on the phone within 5 s of `prompt.opened`; tapping **Allow** in the notification action answers it without opening the app; the agent continues; Events show `prompt.opened → prompt.answered → prompt.delivered` with `actor.kind = user`.
- [ ] PWA installs (manifest + service worker), history is readable offline, and an answer submitted while offline is queued and delivered exactly once on reconnect (idempotency verified by a single `prompt.answered` event).
- [ ] Daemon still binds `127.0.0.1` only (`lsof -nP -iTCP -sTCP:LISTEN | grep orchestrad` shows no `0.0.0.0`/`*`); remote access works through Tailscale Serve and through Cloudflare Tunnel following the shipped recipes; `orch token rotate` invalidates the old token within one request.
- [ ] Two hosts registered in one UI: Fleet lists both, Attention merges both queues with host badges, and a prompt from host B is answerable while host A is offline.
- [ ] `orch sessions|delegate|fleet|doctor|replay|attention|token|fixtures|catalog` all work locally and against a remote host URL; `--json` output validates against the SDK DTO schemas; documented exit codes.
- [ ] All manual TCs in M7-01 … M7-06 ✅ (M7-07 optional); no new lint/dependency-cruiser violations; `PROGRESS.md` updated.

## Steps
| ID | File | Title | Effort | Depends |
|---|---|---|---|---|
| M7-01 | [step-01](step-01-tauri-desktop-shell.md) | Tauri desktop shell | 3 d | M1-13 |
| M7-02 | [step-02](step-02-signing-notarization-updater.md) | Signing, notarization, updater | 2.5 d | M7-01 |
| M7-03 | [step-03](step-03-pwa-and-web-push.md) | PWA & Web Push | 2.5 d | M0-07, M5-05 (∥ with M7-01/02) |
| M7-04 | [step-04](step-04-remote-access-and-auth.md) | Remote access & auth | 1.5 d | M0-04 (∥) |
| M7-05 | [step-05](step-05-multi-host.md) | Multi-host | 2.5 d | M7-04 |
| M7-06 | [step-06](step-06-orch-cli.md) | `orch` CLI | 2 d | M0-06 (∥) |
| M7-07 | [step-07](step-07-cloud-session-aggregation-optional.md) | Cloud-session aggregation (optional, P3) | 1 d | M7-05 |

## What you can test after this milestone
- Orchestra as a real Mac app in the dock and the menu bar, not a browser tab you have to remember to open.
- Installing the released build on a machine that has never seen your code, without disabling any security setting.
- Being notified on your phone that Claude wants to run `rm -rf build/`, and denying it from the lock screen while walking.
- Losing signal in a lift, answering three queued prompts anyway, and watching them all deliver exactly once when the phone reconnects.
- Running the same fleet view over a laptop and a home server, with one Attention queue across both.
- `orch fleet --json | jq '.providers[] | select(.authStatus != "ok")'` in a shell script.

## Demo script (end of M7)
1. Launch `Orchestra.app` from `/Applications` on the clean test account. Tray icon appears; window opens on Attention; `orch doctor --json | jq .exitCode` → 0.
2. Fleet → **Start session** → provider Claude Code → **Choose repository…** opens the native macOS folder picker → pick `~/orchestra-scratch` → Start. Terminals shows the live pane; type in it; echo is instant (raw `/term` WS, IPC untouched — verify with the Tauri IPC counter in the dev panel reading 0 for terminal traffic).
3. Close the window with `⌘W`. `pgrep orchestrad` still returns a pid; `tmux -L orchestra ls` still lists the window. Click the tray icon → **Show Orchestra** → window returns with the pane still streaming.
4. On the phone: open `https://<host>.<tailnet>.ts.net` (or the Cloudflare hostname), **Add to Home Screen**, launch the PWA, sign in with the paired token, allow notifications.
5. Back on the Mac, in the Claude pane ask it to delete a directory. Within 5 s the phone shows a push notification: "Claude · scratch — run `rm -rf build/`" with **Allow** / **Deny** actions.
6. Tap **Deny** on the phone without opening the app. The Mac's Attention card flips to answered → delivered; Claude reports the denial in the pane.
7. Put the phone into airplane mode. Open the PWA: History and the last Attention snapshot still render. Answer a queued question prompt → card shows "queued (offline)". Turn airplane mode off → within 2 s the card shows delivered, and `orch replay --prompt <id> --json` shows exactly one `prompt.answered` event.
8. `orch token rotate` on the Mac → the phone's next request 401s and the PWA shows the re-pair screen; re-pair with the new token from the desktop app's Settings → Remote access → **Pair a device** QR code.
9. Start `orchestrad` on the second host. Desktop app → Settings → Hosts → **Add host** → name `server`, URL, token. Fleet now shows two host sections; Attention merges both queues with `mac` / `server` badges. Stop host A's daemon → its rows grey out with "unreachable"; a prompt from host B is still answerable.
10. Release: push tag `v0.7.0` → CI builds, signs, notarizes, staples, uploads the `.dmg` + `latest.json` with the updater signature. On the clean account the running app detects the update, shows the release notes, and **Install and relaunch** brings it up on 0.7.0. Repeat with a manifest whose signature was corrupted on purpose → update refused, old version still runs.

## Milestone risks
- **R7 (native modules vs packaging)** is the dominant risk and lands in M7-01: `better-sqlite3` and `node-pty` must be present as prebuilt binaries for `darwin-arm64` **and** `darwin-x64`, signed individually, and loadable from inside the app bundle. ADR-005 is resolved inside M7-01 rather than deferred.
- Notarization rejections are slow to diagnose (each round-trip is minutes): the entitlements list and the "sign every Mach-O, inside-out" ordering are written down in M7-02 before the first submission, and a `scripts/verify-bundle.sh` runs `codesign --verify --deep --strict` locally first.
- Web Push on iOS is the least stable surface in the milestone: it requires an installed Home Screen PWA, permission can only be requested from a user gesture, and behaviour has changed between OS releases. Every iOS-specific claim in M7-03 is marked "(verify)" and re-checked at step start; Android is the fallback proof for the exit criterion.
- Remote access invites the worst failure mode in the product (an exposed daemon). M7-04 ships recipes and defaults, not a built-in tunnel; the daemon's `127.0.0.1` bind is an architectural invariant (03-architecture.md §7) and there is an automated test asserting it.
- **R16 (bandwidth)**: M7-07 is P3 and explicitly droppable; M7-05 can also be cut to "read-only second host" if the milestone runs long.
- Updater keys are a permanent liability: the Tauri updater private key never enters the repo, never enters CI logs, and rotating it requires shipping a new app version that trusts both keys — documented in M7-02's open questions.

## Parallelization
Three independent lanes after the entry gate:
- **Lane A (desktop)**: M7-01 → M7-02. Longest lane (5.5 d); start it first.
- **Lane B (mobile/remote)**: M7-04 → M7-03 in practice (the PWA is only useful over a tunnel, though M7-03 depends formally on M0-07 + M5-05 and can be developed on the LAN), then M7-05 after M7-04.
- **Lane C (CLI)**: M7-06 depends only on M0-06 and can be done any time; it is the natural filler while waiting on notarization round-trips in M7-02.
M7-05 needs M7-04's auth strategy interface and M7-06's host-URL flag conventions; do M7-06 before M7-05 if both lanes are free. M7-07 last, and only if the milestone is ahead of schedule.

## Evidence
Screenshots (tray, notification, phone lock screen, Gatekeeper-free install), `spctl`/`codesign` output, notarization log URLs, updater round-trip recording and the offline-queue event dump go in `evidence/` (create the folder at M7-01).
