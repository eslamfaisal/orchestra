# Orchestra

A local-first coding-agent orchestration platform, currently at the **M0-01 monorepo scaffold**. The 13 application/library shells compile; no daemon, UI, provider adapter or agent workload is implemented yet. The ESLint tooling plugin is a separate workspace package.

## Setup

Use Node 22 (at least 22.12) and pnpm 10.17.1. With nvm: `nvm install && nvm use`. On macOS with Homebrew node@22: `export PATH="$(brew --prefix node@22)/bin:$PATH"`. This changes the current shell only.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm depcruise
pnpm format:check
```

`pnpm test` runs package entry-point tests, architecture boundary regression tests and the plan verifier tests. Husky runs lint-staged before commits and commitlint on the commit message. M0-08 adds CI and the custom compliance rules.

## Structure

- `apps/`: daemon, web, desktop and CLI shells.
- `packages/`: core domain, SDK, catalog, UI and five provider shells.
- `tools/`: local architecture tests and reserved ESLint compliance plugin.
- `plan/`: requirements, execution graph, review response and progress.
- `docs/adr/`: architecture decisions; license remains provisional.

Domain production code may import only itself, Zod and neverthrow. SDK-to-core imports are type-only; provider packages depend only on the SDK among workspace packages. Application and UI layers cannot import daemon infrastructure. Tests live outside production source boundaries.

Start with [the delivery plan](plan/README.md) and [progress tracker](plan/PROGRESS.md). Antigravity is an empty optional shell; its adapter remains disabled behind the plan's technical and terms gates.
