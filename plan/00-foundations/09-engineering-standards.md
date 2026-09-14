# 09 — Engineering standards

## Code
- TypeScript strict everywhere; ESLint `no-explicit-any`, `no-floating-promises`, `consistent-type-imports`; Prettier.
- **One use case per class** in `application/`; constructor-injected ports; no static singletons.
- **Strategies, not switches:** providers, roles, storage drivers, remediations, answer transports are registered in DI maps keyed by id. `switch (provider)` in `core`/`application` fails review.
- **Result, not throw:** `neverthrow` `Result<T, DomainError>` inside core/application. Interface layer maps to HTTP/WS/CLI errors.
- **Domain errors** are typed unions (`SessionNotFound | ProviderUnavailable | QuotaExhausted | AckTimeout | …`) with a stable `code` for the UI.
- **Validation at edges:** every inbound payload (HTTP, WS, hook, RPC, file) passes a Zod schema before touching a use case.
- **Idempotency:** hook/stream ingestion keyed by external id; API mutations accept `Idempotency-Key`.
- **Concurrency:** one actor (`SessionSupervisor`) owns tmux; all other modules message it. No shared mutable state across modules.
- **Time & ids:** `Clock` and `IdGenerator` ports (ULID) injected; never `Date.now()`/`crypto.randomUUID()` inside core.
- **Config:** single Zod schema, loaded once, fails fast; env + `~/.orchestra/config.yaml` + CLI flags; secrets only via env/keychain, never config files.
- **Logging:** pino, JSON, `level`, correlation ids; redaction serializer for `authorization|token|cookie|apiKey|secret`.
- **Feature flags:** `features.*` in config; new milestones ship behind flags until their acceptance passes.

## Git & delivery
- Conventional commits (`feat(daemon): …`, `fix(providers/claude): …`); scope = package.
- Branch per step: `m1-03-worktree-manager`. PR title starts with step id.
- PR checklist: tests added · fixtures updated · docs/ADR touched if contract changed · `PROGRESS.md` row updated.
- CODEOWNERS on `packages/core`, `packages/sdk`, `packages/providers/*`, `.eslintrc*`, `SECURITY.md`.
- No direct pushes to `main`; squash merges; semantic-release from `main`.

## Security hygiene
- `pnpm` `minimumReleaseAge: 3d`, lockfile committed, `pnpm audit` in CI, Renovate with grouped weekly PRs.
- No `postinstall` scripts from untrusted packages (`pnpm.onlyBuiltDependencies` allowlist).
- Daemon file permissions: `~/.orchestra` 0700, token 0600.
- Child processes: explicit `env` allowlist (PATH, HOME, TERM, LANG, provider-required vars); never inherit the daemon's full env.

## Definition of Done for any step
1. Automated tests pass locally and in CI.
2. Manual test cases in the step file executed and recorded.
3. No new ESLint/dependency-cruiser violations.
4. Docs updated (README of the package, ADR if needed).
5. `PROGRESS.md` updated.

## Feature flag registry (`features.*` in config)
Add a row when you introduce a flag. A flag is removed (and its row deleted) when its milestone is ✅ — either in the milestone's last step or in the next release, whichever the step file says. Nested keys (e.g. `maintenance.registry.enabled`) are sub-flags of the row's flag.

| Flag | Introduced | Default | Gates |
|---|---|---|---|
| `runner` (`process`\|`tmux`) | M1-02 | `tmux` | session runner implementation |
| `providers.<id>.enabled` | M1-04 | claude/codex `true`, agy `false` | adapter availability |
| `autoAnswer.readOnlyTools` | M1-11 | `false` | auto-approve read-only tools |
| `intelligence` | M2-04 | `false` until M2 ✅ | assignment engine auto-assign |
| `mcp` | M2-05 | `false` until M2 ✅ | Lead MCP server |
| `missions` | M3-02 | `false` until M3 ✅ | mission lifecycle |
| `quota`, `budgets`, `leadHandoff`, `dryRun` | M4 | `false` until M4 ✅ | quota features |
| `recording`, `history` | M5 | `false` until M5 ✅ | recorder, search, replay |
| `maintenance` | M6 | `false` until M6 ✅ | doctor, drift, remediation |
| `pwa`, `push`, `multiHost` | M7 | `false` until M7 ✅ | surfaces |
| `skills`, `learningLoop` | M8 | `false` until M8 ✅ | skills, scorecard adjustments |
| `rbac`, `oidc`, `gates`, `automations` | M9 | `false` (single-user mode) | enterprise |
| `repairAgent`, `communityDrift`, `pluginRegistry` | M10 | `false` | ecosystem (plugin/skill registry; distinct from `maintenance.registry` = manifest registry) |
| `devTools` | M0-06 | `true` in dev, `false` in release | dev endpoints (`/dev/*`, `orch dev *`) |
