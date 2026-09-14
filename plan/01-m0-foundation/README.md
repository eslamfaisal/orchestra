# M0 — Foundation (MVP part 1)

| | |
|---|---|
| Steps | 8 (M0-01 … M0-08) |
| Effort | ~17 days |
| Status | ⬜ |
| Entry | none — first milestone |
| Exit | daemon boots with SQLite, web shell loads and connects over WS, a `FakeProvider` session runs end-to-end through the API in CI, all quality gates green |

## Goal
Stand up the skeleton every later milestone builds on: the monorepo and its guardrails, the pure domain package, the plugin SDK with a scripted `FakeProvider`, the NestJS daemon with config/logging/storage/auth/audit, the append-only event store, the HTTP + WS API, the web shell with the design system, and CI that enforces architecture, coverage, compliance rules and supply-chain hygiene. No real vendor CLI is touched in M0 — that is M1.

## Why this milestone now
Everything in the product plan depends on three things being right from day one: the layer boundaries (D9), the plugin contract (D5) and the compliance controls being *code* (D4, C1–C13). Retrofitting `dependency-cruiser`, the ESLint bans or a `FakeProvider` after adapters exist is far more expensive than starting with them.

## Entry criteria
- [ ] Node 22 installed and selected (`fnm use 22` / `.nvmrc`), pnpm 10, git ≥ 2.40, Docker running (Testcontainers).
- [ ] ADR-003 (Node floor) accepted or defaulted to 22.
- [ ] Repository created (private is fine), default branch `main`, branch protection on.

## Exit criteria
- [ ] `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm depcruise` green locally and in CI.
- [ ] `orchestrad` starts, creates `~/.orchestra/orchestra.db`, migrations applied, `GET /health` → 200 with version.
- [ ] Web shell served by daemon at `http://127.0.0.1:4300`, navigation works, dark theme, RTL toggle, WS connected indicator green.
- [ ] `POST /sessions` with `provider: fake` → session appears over WS; scripted FakeProvider emits events, a prompt, and exits; all persisted in `events`.
- [ ] `packages/core` has 100 % branch coverage on state machines; overall ≥ 80 %.
- [ ] Custom ESLint rules fail the build on a vendor-endpoint fetch and on PTY-regex parsing (proven by negative fixture tests).
- [ ] OpenSSF Scorecard workflow running; `SECURITY.md`, `CONTRIBUTING.md` (DCO), `CODEOWNERS` in place.
- [ ] All manual TCs in M0-01 … M0-08 recorded ✅ in the step files and `PROGRESS.md`.

## Steps
| ID | File | Title | Effort | Depends |
|---|---|---|---|---|
| M0-01 | [step-01](step-01-monorepo-scaffold-and-toolchain.md) | Monorepo scaffold & toolchain | 1.5 d | — |
| M0-02 | [step-02](step-02-core-domain-package.md) | Core domain package | 2 d | M0-01 |
| M0-03 | [step-03](step-03-sdk-contract-harness-fakeprovider.md) | SDK, contract harness, FakeProvider | 3 d | M0-02 |
| M0-04 | [step-04](step-04-daemon-skeleton.md) | Daemon skeleton | 2.5 d | M0-02 |
| M0-05 | [step-05](step-05-event-store-and-repositories.md) | Event store & repositories | 1.5 d | M0-04 |
| M0-06 | [step-06](step-06-http-api-ws-gateway-v1.md) | HTTP API + WS gateway v1 | 2 d | M0-05 |
| M0-07 | [step-07](step-07-web-shell.md) | Web shell | 2.5 d | M0-06 (∥ from M0-04) |
| M0-08 | [step-08](step-08-ci-and-quality-gates.md) | CI & quality gates | 2 d | M0-03 (∥ from M0-01) |

## What you can test after this milestone
- Start the daemon, open the web UI, see it connect.
- Create a fake session from the UI (Fleet placeholder) or `curl`, watch its events stream into the UI log panel, answer its fake prompt via API.
- Break a rule on purpose (add a `fetch('https://api.openai.com')` in daemon code) and watch lint fail.
- Kill the daemon, restart, see events still there.

## Demo script (end of M0)
1. `fnm use 22 && pnpm install && pnpm build`.
2. `pnpm --filter daemon start` → log line `orchestrad listening on http://127.0.0.1:4300`.
3. Open `http://127.0.0.1:4300` → nav shows all IA entries (most "coming in M1/M2"), status pill "connected".
4. `curl -H "Authorization: Bearer $(cat ~/.orchestra/token)" -X POST localhost:4300/api/sessions -d '{"provider":"fake","scenario":"hello-prompt"}'`.
5. UI "Events" dev panel shows `session.requested`, `session.launched`, `prompt.opened`.
6. `curl … -X POST localhost:4300/api/prompts/<id>/answer -d '{"option":"yes"}'` → `prompt.answered`, `session.stopped` with exit 0.
7. `pnpm test` shows core coverage 100 % branches on `state-machines/*`.
8. Push a branch; CI workflow green with Scorecard job present.

## Milestone risks
- Over-engineering the skeleton (R10): keep every module minimal; the goal is boundaries + one vertical slice, not features.
- Native module builds on Node 26 (R7): use Node 22 from the first command.
- FakeProvider fidelity: it must model prompts/429/exits the way real CLIs will (see M0-03), otherwise M1 rewrites tests.

## Parallelization
M0-03 and M0-04 can run in parallel after M0-02. M0-07 can start against a stubbed WS as soon as M0-06's message schema is agreed. M0-08 can start right after M0-01 and be completed after M0-03.
