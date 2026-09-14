# Development environment snapshot

Captured 2026-09-14 on the primary dev machine. Human-maintained snapshot; re-check at the start of each milestone. From M6-01 `orch doctor` produces the live equivalent, but this file stays as the recorded baseline and log.

| Tool | Found | Plan requires | Action |
|---|---|---|---|
| macOS | 26.6.2 (arm64) | 14+ | ok |
| node | v26.7.0 | **22 LTS** (node-pty 1.1.0 prebuilt targets; NestJS support) | Install Node 22 via `fnm`/`volta`; pin in `.nvmrc` + `engines`. Decide in ADR-003 whether to raise floor to 24 LTS. |
| pnpm | 10.17.1 | 10.x | ok |
| git | 2.52.0 | ≥ 2.40 (worktrees) | ok |
| tmux | **missing** | ≥ 3.3 (control mode `-CC`) | `brew install tmux` before M1-01 |
| Claude Code (`claude`) | 2.1.216 | manifest range pinned in M1-05 | ok, logged in? verify with `claude /status` |
| Codex (`codex`) | **broken install** — `spawn …/vendor/aarch64-apple-darwin/codex/codex ENOENT` | app-server capable version | `npm i -g @openai/codex@latest` (or brew) before M1-06 |
| Antigravity (`agy`) | 1.2.1 | stream-json stdio | ok; adapter is opt-in (ToS ack) |
| Kimi Code (`kimi`) | 0.27.0 | M10-04 | ok |
| OpenCode | missing | M10-05 | install later |
| Rust toolchain | missing | Tauri 2 (M7-01) | `rustup` before M7 |
| Docker | 29.2.1 | Testcontainers (M0-08), Postgres (M9-05) | ok |
| gh | 2.92.0 | PR creation (M3-06) | ok |

## Notes
- The daemon must never assume a CLI is installed: `BinaryRegistry` (M1-04) reports missing/unsupported versions as Fleet health, not crashes.
- Keep this table honest: when you upgrade a CLI, add a row to the log below and re-run that adapter's contract tests.

## Log
| Date | Change |
|---|---|
| 2026-09-14 | Initial snapshot |
