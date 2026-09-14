# 11 — Repository layout (monorepo)

```
orchestra/
  plan/                        ← this delivery plan (kept in repo)
  apps/
    daemon/                    orchestrad — NestJS
      src/{core,application,infrastructure,interface}/…
    web/                       React 19 + Vite
    desktop/                   Tauri 2 (src-tauri/, sidecar config)
    cli/                       `orch` (scaffolded M0-01; subcommands accrue per step; consolidated M7-06)
  packages/
    core/                      pure domain (entities, VOs, rules, ports)
    sdk/                       adapter/manifest/skill/playbook types + contract harness + FakeProvider
    catalog/                   taxonomy/ models/ playbooks/ skill-packs/ + schemas/
    ui/                        design system (tokens, shadcn components, RTL utils)
    providers/
      claude/  codex/  agy/  kimi/  opencode/     each: src/ manifest.json fixtures/<cliVersion>/ README.md
  docs/                        Starlight site: adr/ plugin-guide/ skill-guide/ deployment/ (EN + AR)
  examples/                    policies/ playbooks/ skill-packs/
  deploy/                      Dockerfile · helm/ · compose/ · grafana/ (M9-05..08)
  .github/workflows/           ci.yml release.yml scorecard.yml fixtures-matrix.yml
  tools/                       eslint-rules/ (no-vendor-endpoints, no-pty-regex) · scripts/
  LICENSE  CONTRIBUTING.md (DCO)  CODE_OF_CONDUCT.md  SECURITY.md  CODEOWNERS
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  .nvmrc  .dependency-cruiser.cjs
```

## Dependency rules (dependency-cruiser)
- `packages/core` → nothing (not even `sdk`).
- `packages/sdk` → `core` types only.
- `packages/providers/*` → `sdk` only (never `daemon`, never each other).
- `apps/daemon/core|application` → `packages/core`, `packages/sdk` types; never `infrastructure`.
- `apps/web` → `packages/ui`, `packages/sdk` (types) only; talks to daemon over HTTP/WS.
- No package imports `node:child_process` except `apps/daemon/infrastructure/**` and `packages/sdk/fake/**`.
- `fetch`/`http` usage outside an allowlisted egress module fails the `no-vendor-endpoints` rule.

## Runtime directories (user machine)
```
~/.orchestra/
  config.yaml   token   orchestra.db   recordings/   logs/   plugins/   catalog-overrides/   manifests-cache/
<repo>/.orchestra/
  worktrees/<taskId>/    (git worktrees; gitignored)
  workspace.yaml         (workspace-scoped settings: policies, playbooks, skills)
```
