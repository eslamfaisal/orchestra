# Step M0-07 — Web shell

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-06 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/web`, `packages/ui` |
| Risk | Medium |
| Owner | |

## 1. Goal
A React 19 + Vite app served by the daemon with the full information architecture (13 nav entries, most as "coming in M<N>" placeholders), the design system from `12-ux-principles.md` (dark-first tokens, semantic status, fonts, RTL via logical properties, WCAG AA), a resilient WS client with auth + auto-reconnect + topic subscriptions, TanStack Query for REST, Zustand for UI state, a `⌘K` command palette shell, and a dev "Events" panel that shows live domain events. Perf budgets are measured and recorded as the baseline.

## 2. Why
D1 (one UI codebase, three surfaces), `12-ux-principles.md` (RTL from day one, budgets enforced from M1-09), G1.

## 3. Scope
### In scope
- Vite + React 19 + TypeScript strict; Tailwind 4; shadcn/ui components copied into `packages/ui` with tokens; `cmdk` palette; `lucide` icons with RTL-mirror list.
- Routing (`react-router`), layout: left nav (IA order), top bar (host, connection status pill, theme, language/direction toggle), content area.
- Screens: all IA entries as placeholders except: **Fleet** (providers list from `GET /providers` — read-only), **Attention** (open prompts list from `GET /prompts` + answer buttons via `POST /prompts/:id/answer`), **Dev › Events** (live WS event log with filter).
- WS client: `?token=` auth, exponential reconnect with jitter, subscribe/unsubscribe, snapshot handling, event dispatch to Zustand slices; offline indicator.
- API client generated from OpenAPI (or typed fetch wrappers using sdk DTOs); token stored in `localStorage` (local mode) with "paste token" first-run screen.
- i18n scaffold (`react-i18next`): `en`, `ar` with RTL; `dir` set on `<html>`; logical CSS properties lint (`stylelint-use-logical`).
- Accessibility: focus rings, skip-link, `prefers-reduced-motion`, colour + icon + text for statuses; axe checks in Playwright.
- Perf baseline: Lighthouse/`web-vitals` script recording cold start and first WS frame into `plan/01-m0-foundation/evidence/perf-baseline.md`.
### Out of scope (deferred)
- Terminals (M1-09), real Fleet actions (M1-10), full Attention (M1-11), Chat/Board (M2), PWA (M7-03).

## 4. Design
### 4.1 Domain
n/a (UI). State slices: `connection`, `sessions`, `prompts`, `events` (ring buffer 2000), `ui` (theme, dir, palette).
### 4.2 Interfaces / contracts
```ts
// apps/web/src/lib/ws.ts
export class OrchestraSocket { constructor(url: string, token: string); subscribe(topics: string[]): void; on<T extends WsServerMessage['type']>(t: T, h: (m: Extract<WsServerMessage,{type:T}>)=>void): Unsubscribe; close(): void; readonly state: 'connecting'|'open'|'reconnecting'|'closed' }
// packages/ui/src/tokens.css — CSS variables: --bg, --fg, --muted, --accent, --status-running, --status-waiting, --status-blocked, --status-done, --status-error; font stacks; radius; spacing scale
```
Status rendering contract: every status shows icon + text; colour is additive (`<StatusBadge status="waiting_for_input" />`).
### 4.3 Data / schema changes
None.
### 4.4 Infrastructure
Built assets copied to `apps/daemon/public` at build (`turbo` pipeline `web#build` → `daemon#build`). Dev: Vite proxy `/api` and `/ws` to 4300.
### 4.5 API / UI surface
Routes: `/attention`, `/chat`, `/board`, `/missions`, `/terminals`, `/review`, `/models`, `/skills`, `/fleet`, `/timeline`, `/history`, `/health`, `/settings`, `/dev/events`.
### 4.6 Flow
App boot → read token (or first-run screen) → `GET /hosts/me` → open WS → subscribe `sessions`,`prompts` → render.

## 5. Tasks
- [ ] Scaffold Vite app, Tailwind 4, `packages/ui` with tokens + 10 base shadcn components (Button, Badge, Dialog, Sheet, Tabs, Table, Command, Tooltip, Toast, Input).
- [ ] Layout + nav + top bar + theme (dark default, light) + direction toggle (`dir="rtl"`), fonts (JetBrains Mono, Inter, Noto Sans Arabic) self-hosted.
- [ ] Router with all IA routes; placeholder component shows the milestone that delivers the screen (links to plan file).
- [ ] `OrchestraSocket` with reconnect/backoff/jitter + tests (mock server); connection pill.
- [ ] API client from sdk DTOs (`fetchJson` with token, error envelope → typed error).
- [ ] Zustand slices; event ring buffer; devtools in dev only.
- [ ] Fleet (read-only), Attention (list + answer), Dev › Events (filterable live log).
- [ ] `⌘K` palette with navigation commands + "Start fake session" dev command.
- [ ] i18n (`en`, `ar`) with 30 base strings; RTL visual check; stylelint logical-properties rule.
- [ ] a11y: axe in Playwright, keyboard nav test, reduced-motion.
- [ ] Perf script + baseline evidence file.
- [ ] Build pipeline into daemon `public/`; daemon serves SPA fallback.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-07-01 | unit | `OrchestraSocket` reconnects with backoff after server drop | reconnects ≤ 5 tries, resubscribes topics |
| UT-M0-07-02 | unit | StatusBadge renders icon + text for every status | snapshot; no colour-only |
| E2E-M0-07-03 | e2e (Playwright, FakeProvider) | start fake session via palette → prompt appears in Attention → answer → disappears | passes in CI |
| E2E-M0-07-04 | e2e | axe on every route | 0 serious/critical violations |
| E2E-M0-07-05 | e2e | RTL toggle | `html[dir=rtl]`, nav mirrored, no horizontal overflow |
| E2E-M0-07-06 | e2e | offline: kill daemon | pill shows "reconnecting"; restore → "connected", data refreshed |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-07-01 | First run | 1. clear localStorage 2. open `http://127.0.0.1:4300` | token screen; paste token from `~/.orchestra/token`; app loads; pill green | ⬜ |
| TC-M0-07-02 | Live events | 1. open Dev › Events 2. `curl` start fake session | events appear live in order; filter by type works | ⬜ |
| TC-M0-07-03 | Answer prompt from UI | 1. start `hello-prompt` 2. Attention shows card 3. click "Yes" | card disappears; session ends; event log shows `prompt.answered` | ⬜ |
| TC-M0-07-04 | RTL + Arabic | 1. toggle language to AR | UI mirrored, Arabic font, no clipped text; toggle back | ⬜ |
| TC-M0-07-05 | Reconnect | 1. stop daemon 2. wait 10 s 3. start daemon | pill: connected → reconnecting → connected; Fleet list reloads without page refresh | ⬜ |
| TC-M0-07-06 | Perf baseline | 1. run `pnpm --filter web perf` | cold start ≤ 1.5 s, first WS frame ≤ 500 ms recorded in evidence file | ⬜ |
| TC-M0-07-07 | Keyboard only | 1. unplug mouse mentally; Tab/Enter/⌘K through nav and answer a prompt | everything reachable; visible focus | ⬜ |

## 7. Acceptance criteria
- [ ] All 13 IA routes exist; Fleet/Attention/Dev-Events functional against the daemon.
- [ ] WS client resilient (tests + TC-05).
- [ ] Dark/light, EN/AR, RTL working; a11y checks green.
- [ ] Perf baseline recorded and within budgets.
- [ ] Served by the daemon at `/`.
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Tailwind 4 + shadcn compatibility churn — pin versions.
- Bundle size: keep xterm/asciinema out until M1-09/M5-04 (lazy routes).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
