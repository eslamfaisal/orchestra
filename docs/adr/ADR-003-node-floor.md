# ADR-003 — Node 22 toolchain

| Field | Value |
|---|---|
| Status | Accepted for M0-01 under the approved plan default |
| Date | 2026-09-15 |
| Deciders | Plan-specified default; implementation by Codex |
| Related steps | M0-01 |

## Context
The scaffold needs a reproducible runtime. The existing shell uses Node 26; the approved plan specifies Node 22.

## Options considered
Node 22 as specified, or raising the supported major to 24/26 before native-module evidence exists.

## Decision
Require Node >=22.12.0 <23 (Vitest's supported Node 22 floor), pin `.nvmrc` to 22, pin pnpm to 10.17.1, and enforce engines on installation. Do not change the user's global Node selection.

## Consequences
Use a version manager or the Homebrew node@22 bin directory when running commands. Compatibility with node-pty, SQLite and desktop packaging must still be demonstrated in their implementation steps; installing this toolchain does not prove it.

Use pnpm `minimumReleaseAge: 4320` (minutes), and Vitest `test.projects` instead of the deprecated workspace file. All selected dependency versions and transitives are locked.

## Compliance / security impact
Dependency build scripts are restricted to the plan's reviewed allowlist. A runtime major upgrade requires a new compatibility decision.
