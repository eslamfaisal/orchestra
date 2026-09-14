# Step M7-05 — Multi-host

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M7-04 (device tokens, origin rules, remote recipes), M0-06 (WS gateway, snapshot+delta), M5-05 (`sinceEventId` resubscribe), M1-10 (Fleet), M1-11 (Attention), M7-06 (`--host` flag conventions — do M7-06 first if both lanes are free) |
| Estimated effort | 2.5 days |
| Packages touched | `apps/web` (host registry store, per-host clients, host switcher, merged Attention/Fleet), `apps/daemon` (`hosts` identity endpoint, `GET /api/v1/hosts/me` enrichment, worktree claim advisory), `packages/sdk` (host DTOs, multi-host client), `packages/ui` (host badge), `apps/desktop` (tray aggregation) |
| Risk | Medium (a UI-side fan-out; the failure mode is confusion, not data loss) |
| Owner | |

## 1. Goal
One UI, several daemons. The user registers additional hosts (a home server, a second Mac) in Settings with a name, URL and token reference; the web app opens an independent WS + HTTP client per host, Fleet renders a section per host, the Attention queue merges every host's prompts into one prioritised list with a host badge on every card, Terminals and Chat are scoped by an explicit host switcher in the nav, and a host that is unreachable degrades visibly instead of blanking the screen. Each daemon reports a stable identity (`hostId`, name, OS, daemon version, repos it currently has worktrees in) so the UI can detect and warn about the one genuinely dangerous overlap: the same repository being worked on from two hosts.

## 2. Why
- **Source plan §14** lists "multiple hosts (Mac + server) in one UI" as part of the multi-device story; **04-domain-model.md** already models `Host` as an aggregate root that owns ProviderAccounts and Sessions, so the domain has always assumed more than one.
- **G1** ("see, control and talk to every agent **in one place**"): once a second machine runs agents, one place stops being true unless the UI merges. **G4** ("never blocked"): a prompt on the server is exactly as blocking as one on the laptop, and must land in the same queue.
- **D1**: the daemon runs where the CLIs run — which is plural, because vendor CLIs are licensed per user but installed per machine. The architecture deliberately puts one `orchestrad` per host (03-architecture.md §2), so aggregation belongs in the client.
- **C4** (one account per provider, no rotation/pooling): multi-host must not become a way to multiply a subscription. The UI shows provider accounts per host and never aggregates quota windows into a single number; the conflict rules below exist partly to keep that honest.
- **C6/C10**: concurrency limits are per host and per vendor manifest; merging queues must not merge limits, and any cross-host action (stop a session on another machine) is previewed and audited on the host that executes it.

## 3. Scope
### In scope
- Host registry in the web app's settings store: `{ id, name, url, tokenRef, color, enabled, isLocal }`; the local daemon is always entry zero and cannot be removed.
- Token storage: tokens live in IndexedDB (same store as M7-03's `auth`), keyed by host; never in `localStorage`, never in the URL. Add-host flow supports paste, and QR scan when the other host's UI is open.
- `MultiHostClient` in `packages/sdk`: one `HostConnection` per enabled host (HTTP client + WS with `sinceEventId` resubscribe), independent reconnect/backoff, per-host health state, and a merged event stream tagged with `hostId`.
- Host identity: `GET /api/v1/hosts/me` returns `{ hostId, name, os, arch, daemonVersion, startedAt, capabilities, repos: RepoClaim[] }`; a `hosts` row per daemon already exists (M0-04) and gains `name` editing.
- Fleet: a collapsible section per host (providers, versions, auth, concurrency `n/max`, sessions) with per-host health; totals shown as "3 hosts · 7 sessions", never as summed quota.
- Attention: one merged, prioritised queue; each card carries a host badge (name + colour); answering routes to the owning host; a host that is down shows its last-known cards greyed with "host unreachable — answers will fail" and disables their actions.
- Host switcher in the nav (⌘K entry "Switch host"): scopes Terminals, Chat, Board, Missions, History to one host; Attention and Fleet stay merged. The current host is in the URL (`?host=<hostId>`) so links are shareable and reloads are stable.
- Conflict rules for the same repo on two hosts (§4.1) with a warning banner and an advisory claim record — advisory, not a lock.
- Desktop tray (M7-01) aggregates counts across hosts and labels notifications with the host name.
- Degraded behaviour: a host that fails to connect after backoff is marked `unreachable` with the reason (`network`, `unauthenticated`, `version-incompatible`) and a Retry action; the rest of the UI keeps working.
### Out of scope (deferred to …)
- Daemon-to-daemon communication of any kind (no clustering, no leader election, no cross-host job scheduling). Aggregation is strictly client-side in M7.
- Cross-host delegation / assigning a task to whichever host has quota — **M8** at the earliest (it needs the routing policy work from M2-09 plus a cross-host transport that does not exist).
- Cross-host mission execution or review — **M9-07** (automations) territory; missions stay host-local.
- Shared storage between hosts (one Postgres for several daemons) — **M9-05** decides whether that is even desirable.
- Multi-host in the `orch` CLI beyond `--host <url>` and a named-host config — **M7-06** owns the CLI surface.
- RBAC per host / different users per host — **M9-01**.
- Automatic host discovery (mDNS, tailnet enumeration) — not planned; hosts are added explicitly.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
```ts
// packages/sdk/src/hosts/host-registry.ts  (client-side registry; the daemon keeps only its own identity)
export interface HostEntry {
  id: string;            // the daemon's hostId once verified; a temp ULID before first contact
  name: string;          // user label, defaults to the daemon's reported name
  url: string;           // https://server.tailnet.ts.net  — origin only, no path
  tokenRef: string;      // IndexedDB key; never the token itself
  color: HostColor;      // assigned from a fixed palette, used for badges (never colour-only: the name is always shown)
  enabled: boolean;
  isLocal: boolean;
}
export type HostHealth =
  | { state: 'connecting' }
  | { state: 'online'; daemonVersion: string; latencyMs: number; lastEventAt: string }
  | { state: 'unreachable'; reason: 'network' | 'unauthenticated' | 'origin-blocked' | 'version-incompatible'; since: string; detail: string };

export interface RepoClaim { repoPath: string; repoIdentity: string; branches: string[]; sessionIds: string[]; updatedAt: string }
```
`repoIdentity` is `sha256(first-commit-hash + ':' + normalized-remote-url)` — stable across clones and independent of the local path, so "the same repo on two hosts" is detectable without sharing paths. Computed by each daemon from `git rev-list --max-parents=0 HEAD` + `git remote get-url origin`; absent remote → first-commit hash alone; not a git repo → no claim.

**Conflict rules** (pure, unit-tested, evaluated client-side over the merged `RepoClaim` sets):
| Situation | Severity | UI behaviour |
|---|---|---|
| Same `repoIdentity` on two hosts, disjoint branches | info | a small "also active on `server`" chip on the Fleet repo row |
| Same `repoIdentity`, **same branch** on two hosts | warning | banner on Fleet and on the Start-session wizard: "branch `orch/task-x` is also checked out on `server`"; start is still allowed after an explicit confirm |
| Same `repoIdentity`, same **base ref** and both hosts have uncommitted worktrees | warning | same banner plus a "merge conflicts likely" note linking the docs |
| Same `repoIdentity` and the repo is on a shared network volume (both hosts report the same device id for the path) | **blocking** | starting a session is refused with `code: REPO_CLAIMED_ELSEWHERE`; git worktrees on a shared volume from two machines corrupt `.git` state |
The claim is **advisory**: nothing locks, because there is no daemon-to-daemon channel and a stale claim must never be able to block work. Claims older than 24 h without an update are ignored.

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/hosts/multi-host-client.ts
export interface HostConnection {
  readonly entry: HostEntry;
  readonly health: Observable<HostHealth>;
  http: ApiClient;                                   // same generated client as single-host, base-url bound
  subscribe(topics: string[], sinceEventId?: string): Observable<TaggedEvent>;  // TaggedEvent = DomainEvent & { hostId }
  close(): void;
}
export interface MultiHostClient {
  hosts(): HostEntry[];
  connection(hostId: string): HostConnection | undefined;
  /** Merged, priority-ordered view across every online host; unreachable hosts contribute their last snapshot, flagged. */
  attention(): Observable<{ items: (AgentPromptDto & { hostId: string; stale: boolean })[]; degraded: string[] }>;
  fleet(): Observable<{ perHost: Record<string, FleetSnapshot>; health: Record<string, HostHealth> }>;
  answer(hostId: string, promptId: string, answer: PromptAnswerDto): Promise<Result<void, DomainError | 'host-unreachable'>>;
}
```
```ts
// daemon: GET /api/v1/hosts/me
{ hostId: '01J…', name: 'macbook', os: 'darwin 26.6.2', arch: 'arm64',
  daemonVersion: '0.7.0', startedAt: '…', apiVersion: 'v1',
  capabilities: ['terminals','missions','replay','push'],
  repos: [{ repoPath: '/Users/…/orchestra-scratch', repoIdentity: 'sha256:…', branches: ['orch/task-a'], sessionIds: ['…'], updatedAt: '…' }] }
// PATCH /api/v1/hosts/me { name }   → rename this daemon (audited)
```
Merge ordering for the Attention queue: the existing M1-11 priority first, then `openedAt` ascending, then `hostId` for a stable sort. Host is **never** a sort key above priority — a low-priority local prompt must not outrank a blocking remote one.

### 4.3 Data / schema changes
Daemon: none required beyond using the existing `hosts` table; migration `00NN_hosts_name.ts` adds `name text` and `repo_claims_cache` is **not** a table — claims are computed on request from `worktrees` + `sessions` (already present, M1-03) and cached in memory for 10 s. New audit events: `host.renamed`. Client: the host registry and per-host tokens live in IndexedDB (`hosts`, `auth` stores), versioned with a small migration helper; nothing host-related goes into `localStorage` (M8-01 moves the registry into layered settings).

### 4.4 Infrastructure (network, connections)
- One WS per host, opened lazily when the host is enabled and the app is visible; closed after 60 s hidden, reopened with `sinceEventId` on visibility (this is the M5-05 protocol, reused verbatim).
- Per-host reconnect backoff 1 s → 2 s → 5 s → 15 s → 30 s cap, jittered; independent per host so one dead server does not slow the local connection.
- Version compatibility: the client compares `apiVersion` and `daemonVersion`; a **minor** mismatch shows an amber badge ("host runs 0.6.2, this UI is 0.7.0 — some screens may be limited"), a **major/apiVersion** mismatch marks the host `version-incompatible` and connects nothing (no best-effort parsing of an unknown shape).
- Every remote host must be reached over a tunnel from M7-04; the UI validates that a non-local host URL is `https:` (or a `.ts.net`/loopback exception) and refuses plain `http:` to a non-loopback address with an explanation.
- Latency measurement: `GET /health` timing sampled every 30 s per host; shown on Fleet; used only for display.
- Terminals across hosts: each `TerminalPane` opens `/term` **on its own host's origin** with that host's token — there is no proxying of PTY bytes through another daemon (that would violate 03-architecture.md §5's direct-channel design and the 40 MB/pane budget).

### 4.5 API / UI surface
- Settings → **Hosts**: table (name, URL, status, daemon version, sessions, last seen), **Add host** dialog (name, URL, token paste or QR scan, Test connection → shows the reported identity before saving), Edit, Disable, Remove (local entry is not removable), colour picker.
- Nav: host switcher next to the logo — a `cmdk` popover listing hosts with status dots **and** text; `⌘K → "Switch host"`; keyboard `⌃1..9`.
- Fleet: one collapsible section per host with its own provider cards and session table; a header row "3 hosts · 7 sessions · 1 unreachable"; quota windows stay strictly per host with no aggregate number anywhere.
- Attention: merged list; each card gets a host chip (colour + name); a "Filter: host" control; a degraded strip at the top naming unreachable hosts; actions disabled with a tooltip on stale cards.
- Terminals / Chat / Board / Missions / History: scoped to the current host, with the host name in the page header and in the URL.
- Desktop tray: "2 waiting (macbook) · 1 waiting (server)"; notifications prefixed with the host name.
- Errors: `host-unreachable` renders as an inline card with Retry and a link to the M7-04 troubleshooting section, never as a toast that disappears.

### 4.6 Flow / sequence
```
ADD A HOST
 Settings → Add host → {name, url, token}
 → Test connection: GET {url}/api/v1/hosts/me with the token
      401 → "token rejected"   403 → "origin not allowed — add this UI's origin to remote.allowedOrigins on that host"
      version-incompatible → refuse to save with the two versions named
      ok → show {hostId, name, os, daemonVersion} for confirmation → save (token → IndexedDB, entry → registry)
 → MultiHostClient opens a connection → topics ['fleet','prompts','sessions'] with sinceEventId = none (first time)

MERGED ATTENTION
 per host: WS 'prompts' snapshot + deltas → tag with hostId
 → merge(priority, openedAt, hostId) → render
 → answer(card) → connection(card.hostId).http.POST /prompts/:id/answer  (Idempotency-Key as in M7-03)
      host offline → the action is disabled; if it fails mid-flight → inline error + Retry, never a silent queue
        (offline queueing exists only for the *local* host's own PWA session, M7-03)

HOST GOES DOWN
 WS close → backoff reconnect → after 3 failures mark unreachable{reason}
 → its Fleet section collapses to a status row; its Attention cards go stale/grey; the switcher shows the dot
 → on recovery: resubscribe with sinceEventId → snapshot + delta → cards refresh; any card answered elsewhere disappears

REPO CONFLICT
 every 30 s (and on Fleet open): collect repos[] from each online host → group by repoIdentity
 → evaluate conflict rules → info chip | warning banner | blocking refusal in the Start-session wizard
```

## 5. Tasks
- [ ] `GET /api/v1/hosts/me` enrichment (`os`, `arch`, `daemonVersion`, `apiVersion`, `capabilities`, `repos` with `repoIdentity`) + `PATCH` rename + migration `00NN_hosts_name`.
- [ ] `repoIdentity` computation in the worktree/git infrastructure module (first-commit + remote URL, cached 10 s), plus the shared-volume device-id check used by the blocking rule.
- [ ] Conflict-rules module in `packages/sdk` (pure, 100 % branch) with the four cases in §4.1.
- [ ] `HostConnection` + `MultiHostClient` in `packages/sdk`: per-host HTTP client, WS with `sinceEventId`, backoff, health state machine, version gate.
- [ ] IndexedDB stores `hosts` + per-host tokens with a version migration; reuse the M7-03 `auth` store shape.
- [ ] Settings → Hosts UI: table, Add dialog with **Test connection** preview, QR scan, edit/disable/remove, colour picker (EN/AR).
- [ ] Host switcher in the nav + `⌘K` entry + `⌃1..9` + `?host=` URL param + route guards for scoped screens.
- [ ] Fleet: per-host sections, header totals, per-host health rows, "no aggregate quota" assertion in the component test.
- [ ] Attention: merged selector with the documented ordering, host chips, host filter, degraded strip, disabled actions on stale cards.
- [ ] Terminals: `/term` connects to the pane's own host origin with that host's token; verify no cross-host proxying.
- [ ] Desktop tray aggregation + host-prefixed notification titles (M7-01 integration).
- [ ] Error surfaces for `unauthenticated` / `origin-blocked` / `version-incompatible` with links into `docs/deployment/remote-access.md`.
- [ ] Playwright E2E against two FakeProvider daemons on two ports (the CI stand-in for two machines).
- [ ] Manual run against a real second host; record in `evidence/`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-05-01 | unit | Attention merge ordering: priority-1 remote prompt vs priority-4 local prompt, equal timestamps | remote first; sort is stable across re-renders; host is never a tiebreaker above priority |
| UT-M7-05-02 | unit | conflict rules over four claim sets (disjoint branches / same branch / same base + dirty / shared volume) | info / warning / warning / blocking exactly as specified; claims older than 24 h ignored |
| UT-M7-05-03 | unit | host health state machine: connect → 3 failures → unreachable → recover | correct reasons; backoff sequence 1/2/5/15/30 with jitter within bounds |
| UT-M7-05-04 | unit | version gate: apiVersion mismatch, minor daemon mismatch, exact match | `version-incompatible` (no connection) / amber badge (connected) / clean |
| UT-M7-05-05 | unit | URL validation: `http://192.168.1.5:4300`, `http://127.0.0.1:4300`, `https://x.ts.net` | rejected with an explanation / allowed (loopback) / allowed |
| IT-M7-05-06 | integration | `GET /hosts/me` `repoIdentity` for a clone of the same repo at two different paths | identical identity; a repo with no remote still yields a stable identity; a non-git path yields no claim |
| IT-M7-05-07 | integration | two daemons on two ports, prompt opened on each | merged queue shows both with correct host tags; answering routes to the right daemon (verified by each daemon's event log) |
| IT-M7-05-08 | integration | host B killed mid-session | B's cards go stale within one backoff cycle; A's WS stream is uninterrupted (event timestamps show no gap) |
| E2E-M7-05-09 | e2e | add-host flow with a wrong token, then a bad origin, then a good token | distinct, actionable errors for each; only the last saves; the token never appears in the DOM or a URL |
| E2E-M7-05-10 | e2e | host switcher scoping | Terminals shows only the current host's panes; `?host=` survives a reload; Attention stays merged throughout |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-05-01 | Add a real second host | 1. Run `orchestrad` on the server behind Tailscale 2. Settings → Add host → paste URL + token 3. Test connection 4. Save | Identity preview shows the server's hostname, OS and daemon version before saving; after saving, Fleet shows two sections | ⬜ |
| TC-M7-05-02 | Merged Attention across hosts | 1. Trigger a permission prompt on the Mac and a question prompt on the server 2. Open Attention | Both cards present with correct host chips; the destructive one ranks first; answering each reaches the right agent (verify in both panes) | ⬜ |
| TC-M7-05-03 | Host-scoped terminals | 1. Switch to `server` 2. Open Terminals 3. Switch back | Only that host's panes render; switching does not tear down the other host's WS (check the network panel); `/term` connects to the server origin directly | ⬜ |
| TC-M7-05-04 | **Negative — host offline** | 1. Stop the server's daemon 2. Watch Attention and Fleet 3. Try to answer one of its cards 4. Restart the daemon | Cards grey with "host unreachable"; the action is disabled with a tooltip; Fleet shows the reason and a Retry; on restart everything refreshes via `sinceEventId` with no duplicate cards | ⬜ |
| TC-M7-05-05 | **Negative — expired/revoked token on host B** | 1. `orch token revoke <id>` on the server 2. Observe the UI | Host B goes `unauthenticated` (not "network"); the Hosts table offers "Update token"; host A is entirely unaffected | ⬜ |
| TC-M7-05-06 | **Negative — version incompatible** | 1. Run an older daemon build on the server 2. Add/refresh that host | Host is marked `version-incompatible` with both versions named; no partial data is rendered from it; the rest of the UI works | ⬜ |
| TC-M7-05-07 | **Negative — plain http to a LAN address** | 1. Try to add `http://192.168.1.50:4300` | Refused at the dialog with an explanation and a link to the tunnel recipes; nothing is saved | ⬜ |
| TC-M7-05-08 | Same repo, different branches | 1. Clone the scratch repo on both hosts 2. Start a session on a different branch on each 3. Open Fleet | Info chip "also active on `<host>`"; no warning banner; both sessions run normally | ⬜ |
| TC-M7-05-09 | Same repo, same branch | 1. Start a session on branch `orch/task-x` on both hosts | Warning banner on Fleet and in the second Start-session wizard naming the other host and branch; start proceeds only after an explicit confirm | ⬜ |
| TC-M7-05-10 | **Blocking** — shared volume | 1. Mount the same repo over SMB/NFS on both hosts 2. Attempt to start a session on the second host | Refused with `REPO_CLAIMED_ELSEWHERE` and an explanation that git worktrees on a shared volume corrupt state; no worktree is created | ⬜ |
| TC-M7-05-11 | **Resilience** — tunnel flaps | 1. With both hosts connected, drop and restore the server's tunnel three times in two minutes | Each flap shows a brief "reconnecting", recovers with `sinceEventId`, and produces no duplicated prompts or events; backoff is visible but never exceeds 30 s | ⬜ |
| TC-M7-05-12 | Desktop tray aggregation | 1. With prompts open on both hosts, check the tray 2. Trigger a new prompt on the server | Tray reads "2 waiting (macbook) · 1 waiting (server)"; the notification title is prefixed with `server`; clicking it deep-links to the merged Attention with that card focused | ⬜ |
| TC-M7-05-13 | Phone with two hosts | 1. On the PWA, add the server as a second host 2. Trigger prompts on both | Merged queue on the phone with host chips; push notifications still come from each host independently (each has its own subscription) and are labelled | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] Hosts can be added, tested, renamed, disabled and removed; the local host is always present and unremovable; tokens are stored per host in IndexedDB and never appear in a URL or the DOM.
- [ ] Fleet renders a section per host with independent health; no screen anywhere shows an aggregated quota number across hosts (C4).
- [ ] Attention merges all hosts with the documented ordering and a visible host badge on every card; answering routes to the owning host.
- [ ] Terminals, Chat, Board, Missions and History are host-scoped with a switcher, a URL parameter and keyboard access.
- [ ] A host that is unreachable, unauthenticated or version-incompatible degrades with a specific, actionable reason and does not affect other hosts (TC-04/05/06).
- [ ] Repo-conflict rules implemented: info, warning and the blocking shared-volume case (TC-08/09/10).
- [ ] Recovery after a host outage uses `sinceEventId` and produces no duplicate or lost prompts (TC-11).
- [ ] Desktop tray and push notifications are host-labelled.
- [ ] All TC pass; no new lint/dependency-cruiser violations (`packages/sdk` gains no daemon import); `PROGRESS.md` updated.

## 8. Risks / open questions
- Client-side fan-out means N connections, N snapshots and N token lifetimes in one tab; memory and reconnect storms are the realistic failure mode. Budget: ≤ 20 MB additional per host with a 200-item queue — measured in TC-11 and recorded, not assumed.
- `repoIdentity` from first-commit + remote URL is stable for normal clones but wrong for repos that share history via forks, and absent for repos with no commits. The blocking rule therefore also requires the shared-volume signal, so a fork false-positive can only produce a warning — acceptable, but "(verify)" the device-id comparison works over SMB and NFS on macOS.
- Advisory claims can be stale (a host that died without cleanup). The 24 h expiry plus "warnings never block" keeps a stale claim from stopping work; the blocking case is the only exception and is derived from live filesystem facts, not from a claim record.
- Quota is deliberately not merged, which will *look* like a missing feature. Document it in Fleet's empty/overview copy: one account per provider per C4, and a second host does not add quota.
- Whether the host registry should live in the daemon (so it syncs across devices) instead of the client is an open question; M8-01's layered settings engine is the natural home, and doing it here would duplicate that work. Recorded as a deliberate deferral.
- Answering a remote prompt has no offline queue (M7-03's outbox is local-host only). If a user regularly answers server prompts from a flaky phone connection this will be felt; extending the outbox to remote hosts is a candidate follow-up, not in scope here.
- Cross-host clock skew affects the merge's `openedAt` tiebreaker. Sort within a 2 s window by host order rather than trusting sub-second remote timestamps — "(verify the skew observed between the two real hosts and adjust the window)".

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
