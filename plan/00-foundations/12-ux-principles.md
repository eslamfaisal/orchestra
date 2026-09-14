# 12 — UX principles, IA, design system, budgets

## Principles
1. **Attention over information** — the first screen is what needs you, not everything that exists.
2. **Calm density** — many panes, low noise; status by shape + text, never colour alone.
3. **Keyboard-first** — `⌘K` command palette for every action; every list navigable by keys.
4. **Truth labelling** — every number says *official* or *estimate* with confidence.
5. **Zero-surprise control** — any action that spends quota or sends keystrokes shows a preview first.

## Information architecture (left nav, in this order)
Attention · Chat · Board · Missions · Terminals · Review · Models · Skills · Fleet · Timeline · History · Health · Settings

| Screen | Ships in | Core content |
|---|---|---|
| Terminals | M1-09 | xterm grid; pane header: provider · model · task · worktree · status; broadcast bar; "attach externally" copies `tmux attach` cmd |
| Fleet | M1-10 (windows/forecasts M4-07) | providers, versions, auth/plan, windows, health, concurrency |
| Attention | M1-11 | prioritised queue of AgentPrompts + provider updates; inline Approve/Deny/Answer; plan cards |
| Chat | M2-08 | rendered conversation per session; `/` command palette from manifest; prompts inline |
| Board | M2-07 | kanban of tasks across agents |
| Missions | M3-08 | plan, DAG, assignments + reasons, review rounds, cost, simulate |
| Review | M3-05 | diff per task, inline comments routed to author agent, test status, PR button |
| Models | M2-02 (scorecards M8-06) | catalog, profiles, deprecations, evidence |
| Skills | M8-04 | library, packs, evals |
| Timeline / History | M5-04 | scrubber linking replay ↔ chat ↔ events ↔ diff; search |
| Health | M6-07 | doctor results, drift cases, repairs, updates |
| Settings | v0 from M1-11 (per-feature panes: auto-answer, notifications, hosts, tokens, quit behaviour added by M1-11, M7-01, M7-03..05); full layered editors M8-01 | layered editors |

## Design system
Dark-first · semantic status tokens (`status-running`, `status-waiting`, `status-blocked`…) with icon + label · JetBrains Mono (terminal), Inter (UI), Noto Sans Arabic · **RTL from day one** (CSS logical properties, `dir` on root, mirrored icons list) · shadcn/ui base in `packages/ui` · WCAG 2.1 AA · `prefers-reduced-motion` respected.

## Reliability budgets (measured in M0-07 baseline, enforced from M1-09)
| Budget | Target |
|---|---|
| Cold start (web) | ≤ 1.5 s |
| First WS frame after connect | ≤ 500 ms |
| Idle memory | ≤ 300 MB daemon+web; ≤ 40 MB per pane |
| Scrollback | 60 fps on 10k lines |
| Input echo | ≤ 50 ms local |
| Notifications | coalesced, deep-linked |
| Offline | history readable; answers queued and delivered on reconnect |
| Restore | re-attach tmux + replay events; durable captured prompts with explicit recovery outcomes |

## Feasibility contract reconciliation (2026-09-15)
Provider capabilities are keyed by exact CLI version and execution mode; foundation 14 and M0-09 define the release gate. Mandatory unsupported capabilities block that mode; optional unsupported capabilities disable only the feature. Task success follows declared deliverables (M3-03), independent review uses model publisher identity (M3-04), and merge validation binds the exact candidate commit (M3-05). Recovery means durable captured records with explicit outcomes (M5-05), not universal capture or exactly-once effects. Budgets are admission limits (ADR-021). Learning defaults to shadow proposals (M8-06). Enterprise v1 is trusted shared-team execution (ADR-019); plugin provenance alone never authorizes untrusted execution (ADR-014). These revised contracts govern implementation; the source-plan-v0.2 snapshot is historical.
