# 08 — Tech stack (pinned)

| Area | Choice | Version policy | Why / alternative rejected |
|---|---|---|---|
| Runtime | Node | **22 LTS** (`.nvmrc`, `engines`); CI 22+24 | native module prebuilts; NestJS matrix. (D12) |
| Language | TypeScript | 5.x strict, `noUncheckedIndexedAccess`, no `any` | one language across daemon/web/plugins |
| Daemon | NestJS on Fastify + `@nestjs/websockets` | 11.x | DI, guards, interceptors, module boundaries out of the box |
| Validation | Zod | 3.x/4.x | config + payload + manifest schemas; JSON-schema export for SDK |
| DB | Kysely + better-sqlite3 (FTS5, WAL) | migrations never edited after ship | Postgres driver swap in M9-05 |
| Errors | neverthrow `Result` | | no exceptions inside core/application |
| Logging | pino | | structured, redaction serializers |
| Tracing | OpenTelemetry JS; `gen_ai.*` semconv snapshot pinned; dual-emit via `OTEL_SEMCONV_STABILITY_OPT_IN` | | conventions unstable — pin |
| Terminal | tmux ≥ 3.3 (control mode `-CC`) | pinned in `BinaryRegistry` | sessions outlive daemon |
| PTY | node-pty **1.1.0** prebuilt; abstracted behind `PtyPort` so Tauri (`tauri-plugin-pty`/Rust) can replace | | |
| Web | React 19, Vite, Tailwind 4, shadcn/ui, Zustand, TanStack Query, xterm.js + WebGL addon, asciinema-player, cmdk | | |
| Desktop | Tauri 2 (signed sidecars, hardened runtime, notarized, updater with separate signing key) | Rust stable | Electron rejected: size, memory budgets |
| Monorepo | pnpm workspaces + Turborepo | | |
| Tests | Vitest, Playwright, Testcontainers, fast-check (property/fuzz) | | |
| Arch lint | dependency-cruiser + custom ESLint rules | | |
| Release | semantic-release, conventional commits, signed tags, GitHub Releases, Homebrew cask, npm provenance | | |
| Supply chain | Sigstore/cosign, SLSA provenance, SBOM (CycloneDX), OpenSSF Scorecard | | |
| Docs | Starlight (Astro) | | EN + AR |

## Version pins to record in `M0-01`
`package.json#engines`, `.nvmrc`, `pnpm-workspace.yaml` (`minimumReleaseAge`), `.tool-versions` (tmux, rust), `BinaryRegistry` CLI ranges.
