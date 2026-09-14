# Step M0-01 — Monorepo scaffold & toolchain

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | — |
| Estimated effort | 1.5 days |
| Packages touched | repo root, `apps/*`, `packages/*` (empty shells), `tools/`, `.github/` |
| Risk | Low |
| Owner | |

## 1. Goal
A pnpm + Turborepo monorepo exists with every app and package from `11-repo-layout.md` as a compiling (empty) TypeScript project, strict compiler settings, ESLint + Prettier, `dependency-cruiser` rules that already encode the layer boundaries, Node 22 pinned, conventional-commit linting, and the license/governance placeholder files. `pnpm build && pnpm lint && pnpm test` passes on an empty tree.

## 2. Why
D9 (one language, Clean Architecture per package), D12 (Node floor), C2/C7 (lint bans are security controls — the rule scaffolding must exist before any adapter code), G7 (open-source hygiene from commit one).

## 3. Scope
### In scope
- Workspace layout, shared `tsconfig.base.json`, per-package `tsconfig.json` with project references.
- Turborepo pipelines: `build`, `test`, `lint`, `depcruise`, `typecheck`, `dev`.
- ESLint flat config (typescript-eslint strict, import ordering, `no-explicit-any`, `no-floating-promises`, `consistent-type-imports`), Prettier, EditorConfig.
- `dependency-cruiser` config with the rules from `11-repo-layout.md`.
- Node pin (`.nvmrc` = 22, `engines`, `packageManager` field), `pnpm-workspace.yaml` with `minimumReleaseAge: 3d` and `onlyBuiltDependencies` allowlist.
- Husky + commitlint (conventional commits) + lint-staged.
- Placeholder files: `LICENSE` (Apache-2.0 for now; ADR-001 may change core), `CONTRIBUTING.md` (DCO sign-off), `CODE_OF_CONDUCT.md`, `SECURITY.md` stub, `CODEOWNERS`, `docs/adr/ADR-001-license.md` (Proposed), `docs/adr/ADR-003-node-floor.md`.
- `plan/` folder committed as-is.
### Out of scope (deferred)
- Custom ESLint rules implementation → M0-08 (config slot is created here).
- Any runtime code → M0-02+.
- Release tooling (semantic-release) → M0-08 config, M10-07 usage.

## 4. Design
### 4.1 Domain
None.
### 4.2 Interfaces / contracts
Root `package.json` scripts:
```json
{
  "scripts": {
    "build": "turbo run build", "test": "turbo run test", "lint": "turbo run lint",
    "typecheck": "turbo run typecheck", "depcruise": "depcruise --config .dependency-cruiser.cjs apps packages",
    "dev": "turbo run dev --parallel", "format": "prettier --write ."
  },
  "engines": { "node": ">=22 <23" }, "packageManager": "pnpm@10.17.1"
}
```
`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `moduleResolution: bundler`, `target: ES2022`, `verbatimModuleSyntax`.

Package names: `@orchestra/core`, `@orchestra/sdk`, `@orchestra/catalog`, `@orchestra/ui`, `@orchestra/provider-claude|codex|agy|kimi|opencode`, apps `orchestrad`, `@orchestra/web`, `@orchestra/desktop`, `orch` (CLI). (Rename later if ADR-002 changes the brand — keep the scope in one constant.)
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
`.dependency-cruiser.cjs` rules (names used in CI output):
- `core-imports-nothing`: `packages/core/**` may not import outside itself.
- `sdk-only-core`: `packages/sdk/**` → only `packages/core`.
- `providers-only-sdk`: `packages/providers/*/**` → only `packages/sdk` (+ own package).
- `daemon-layering`: `apps/daemon/src/core|application/**` ↛ `infrastructure|interface`.
- `web-no-daemon`: `apps/web/**` ↛ `apps/daemon`.
- `no-child-process-outside-infra`: `node:child_process` only in `apps/daemon/src/infrastructure/**`, `packages/sdk/src/fake/**`, `apps/cli/**`.
### 4.5 API / UI surface
None.
### 4.6 Flow
`pnpm install` → husky installs hooks → `pnpm build` compiles empty packages via project references → `pnpm depcruise` passes with 0 violations.

## 5. Tasks
- [ ] `git init`, `.gitignore` (node, dist, `.orchestra/`, `~` files), `.editorconfig`, `.nvmrc` = `22`.
- [ ] Root `package.json`, `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `packages/providers/*`), `turbo.json`.
- [ ] `tsconfig.base.json` + per-package `tsconfig.json` with `references`; `pnpm typecheck` passes.
- [ ] Create each app/package with `src/index.ts` exporting a version constant and a `README.md` one-liner.
- [ ] ESLint flat config + Prettier; `pnpm lint` passes; add empty `tools/eslint-rules/` package wired into config (rules added in M0-08).
- [ ] `.dependency-cruiser.cjs` with the six rules; add a deliberate violation in a scratch file, confirm it fails, remove it.
- [ ] Vitest workspace config (`vitest.workspace.ts`), one trivial test per package so `pnpm test` runs everywhere.
- [ ] Husky + commitlint (`@commitlint/config-conventional`) + lint-staged (eslint --fix, prettier).
- [ ] `pnpm-workspace.yaml`: `minimumReleaseAge`, `onlyBuiltDependencies: [better-sqlite3, node-pty, esbuild]`.
- [ ] Governance files: `LICENSE`, `CONTRIBUTING.md` (DCO text + how to run), `CODE_OF_CONDUCT.md`, `SECURITY.md` (stub, filled in M0-08), `CODEOWNERS` (core, sdk, providers, eslint config, SECURITY.md).
- [ ] `docs/adr/ADR-001-license.md` (Proposed) and `docs/adr/ADR-003-node-floor.md` (Accepted: 22) from `plan/templates/ADR_TEMPLATE.md`.
- [ ] Copy `plan/` into the repo root; first commit `chore: scaffold monorepo (M0-01)`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-01-01 | unit | each package has a passing smoke test | `pnpm test` green, 12 packages reported |
| AT-M0-01-02 | architecture | `pnpm depcruise` on clean tree | 0 violations |
| AT-M0-01-03 | architecture | scratch file in `packages/core` importing `node:fs` | `core-imports-nothing` violation reported, exit ≠ 0 |
| AT-M0-01-04 | architecture | scratch import of `apps/daemon` from `apps/web` | `web-no-daemon` violation |
| IT-M0-01-05 | toolchain | `pnpm build` from clean clone on Node 22 | success; `dist/` per package |
| IT-M0-01-06 | toolchain | commit with message `bad message` | commitlint rejects |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-01-01 | Clean clone builds | 1. `git clone` to a temp dir 2. `fnm use` 3. `pnpm install` 4. `pnpm build && pnpm lint && pnpm test && pnpm depcruise` | all four green, no warnings about Node version | ⬜ |
| TC-M0-01-02 | Wrong Node version refused | 1. `fnm use 26` 2. `pnpm install` | pnpm/engines check fails with a clear message naming Node 22 | ⬜ |
| TC-M0-01-03 | Layer violation caught | 1. add `import fs from 'node:fs'` in `packages/core/src/index.ts` 2. `pnpm depcruise` | fails, rule `core-imports-nothing` named; revert | ⬜ |
| TC-M0-01-04 | Commit hooks | 1. stage a badly formatted file 2. `git commit -m "feat: x"` | lint-staged formats it; commit succeeds; `git commit -m "x"` is rejected | ⬜ |
| TC-M0-01-05 | Governance files present | 1. open repo root | LICENSE, CONTRIBUTING (DCO), CODE_OF_CONDUCT, SECURITY, CODEOWNERS, docs/adr/ADR-001, ADR-003 exist and render | ⬜ |

## 7. Acceptance criteria
- [ ] All packages from `11-repo-layout.md` exist and compile with strict settings.
- [ ] `pnpm build/lint/test/typecheck/depcruise` green locally.
- [ ] Six dependency-cruiser rules present and proven by negative tests.
- [ ] Node 22 pinned in `.nvmrc`, `engines`, `packageManager` set.
- [ ] Conventional commits enforced by hook.
- [ ] Governance placeholders + ADR-001/ADR-003 committed.
- [ ] All TC pass; no lint/arch violations.

## 8. Risks / open questions
- Turborepo vs Nx: Turborepo chosen for simplicity; revisit only if remote caching needs grow.
- `exactOptionalPropertyTypes` can be noisy with some libraries; keep it, add targeted `// eslint-disable` never — use proper types.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
