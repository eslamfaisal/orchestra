# Step M7-03 — PWA & Web Push

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M0-07 (web shell), M5-05 (restore + `sinceEventId` WS protocol), M1-11 (AgentPrompt, Attention queue), M0-04 (config, token auth), M7-04 in practice (a tunnel hostname to install from) |
| Estimated effort | 2.5 days |
| Packages touched | `apps/web` (manifest, service worker, install prompt, offline queue, mobile layouts), `apps/daemon` (`src/application/push`, `src/infrastructure/push`, `src/interface/http/push`, migration `push_subscriptions`), `packages/core` (idempotent answer rules), `packages/sdk` (push DTOs), `packages/ui` (mobile card variants) |
| Risk | High (iOS Web Push behaviour is the least stable surface in the milestone) |
| Owner | |

## 1. Goal
The web UI becomes an installable progressive web app. On a phone it can be added to the Home Screen, launches standalone, renders Attention / Chat / History in a layout built for a 390 px screen, and — crucially — receives a **Web Push notification within seconds of an `AgentPrompt` opening**, with inline **Allow** / **Deny** notification actions that answer the prompt without opening the app. Offline, the app still renders cached history and the last Attention snapshot, queues answers locally, and delivers them exactly once when connectivity returns. Push subscriptions live in the daemon in a new `push_subscriptions` table; the VAPID keypair is generated locally on first run and never leaves the host.

## 2. Why
- **D1**: "PWA for phone/tablet" is one of the three surfaces the architecture commits to; source plan §14 names the phone's job precisely — "attention/approve/chat/replay first".
- **G1**'s measurable target includes "phone approve/answer"; it is the one part of G1 still unmet after M6.
- **G4** ("never blocked"): an agent waiting on a permission while the user is away from the desk is the most common way work stalls. A push notification with inline actions collapses that from "next time I check" to seconds.
- **D14**: prompts are durable with typed transports precisely so they can be answered "from any device via official channels" — this step is the device.
- **C2** allows Web Push egress explicitly ("Allowed egress: Web Push, OIDC, registries, update check, GitHub/GitLab PR API"). The daemon talks to the push service endpoint the *browser* gave it, never to a vendor AI API.
- **C10/C13**: a push payload is a copy of prompt content leaving the host through a third-party push service, so it is minimised and redacted before it is encrypted, and the answer path is audited like any other mutation.
- **12-ux-principles.md** reliability budgets: "Offline — history readable; answers queued and delivered on reconnect" and "Notifications — coalesced, deep-linked" are literal requirements implemented here.

## 3. Scope
### In scope
- Web app manifest (`manifest.webmanifest`), icons (192/512 + maskable), `apple-touch-icon`, theme/background colours matching the dark-first design system, `display: standalone`, `start_url: /attention`, shortcuts for Attention / Terminals / Chat.
- Service worker (Workbox-less, hand-written, ~200 lines) with an explicit caching strategy per route class (§4.4) and a versioned cache name tied to the build hash.
- Install prompt UX: `beforeinstallprompt` capture on Android/desktop Chrome; an instructional sheet for iOS Safari ("Share → Add to Home Screen"), shown once, dismissible.
- VAPID keypair generated at first daemon run into `~/.orchestra/push.json` (0600); public key exposed to the client; rotation command.
- `push_subscriptions` table + `PushSubscriptionRepository` + subscribe/unsubscribe/list/test endpoints.
- `PushNotifier`: subscribes to `prompt.opened` (and `prompt.expired`, `session.crashed` behind flags), filters by priority and per-device preferences, coalesces, builds a **minimised** payload, encrypts and POSTs to each subscription endpoint, prunes on 404/410.
- Notification actions **Allow** / **Deny** / **Open** handled in the service worker's `notificationclick`, calling `POST /api/v1/prompts/:id/answer` with an `Idempotency-Key` — no app window needed.
- Offline: cached shell + last snapshots readable; an `outbox` in IndexedDB for answers submitted offline; Background Sync where available, replay-on-reconnect everywhere else; exactly-once delivery via `Idempotency-Key` (M0-04 convention) and the M5-05 `sinceEventId` resubscribe.
- Mobile layout pass for Attention, Chat, History and a read-only Terminals view (xterm at a phone-appropriate font size, input disabled by default behind a "enable typing" toggle).
- Device pairing: a QR code in Settings → Remote access containing `https://<host>/pair#<one-time-code>`; the phone exchanges the code for the token once, over the tunnel.
### Out of scope (deferred to …)
- Remote reachability itself (Tailscale / Cloudflare Tunnel, TLS, CORS/origin rules) — **M7-04**. On the LAN this step is developed against `http://<lan-ip>:4300` with a self-signed certificate or a `localhost` tunnel; secure-context requirements are M7-04's problem to make permanent.
- Multi-host merging in the phone UI — **M7-05** (the PWA talks to one host in this step; the host list arrives with M7-05).
- Native iOS/Android apps, APNs/FCM direct integration — never (Web Push only).
- Notification channel/rule editors (per-provider, quiet hours, escalation) — **M8-08**.
- Full mobile Missions/Review/Board layouts — **M8** at the earliest; those routes render a "best on a larger screen" panel with a link.
- Offline *starting* of sessions or editing of settings — out of scope permanently; the offline surface is read + answer only.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
```ts
// packages/core/src/push/push-subscription.ts
export interface PushSubscriptionRecord {
  id: string;                 // ULID
  hostId: string;
  endpoint: string;           // browser-supplied push service URL
  p256dh: string; auth: string;
  deviceLabel: string;        // "Eslam's iPhone" — user editable
  userAgentFamily: string;    // coarse: 'ios-safari' | 'android-chrome' | 'desktop-chrome' | 'other'
  minPriority: 1|2|3|4|5;     // AgentPrompt priority threshold for this device
  createdAt: string; lastSuccessAt?: string; lastFailureAt?: string; failureCount: number;
  disabledReason?: 'gone' | 'too-many-failures' | 'user';
}
```
Rules (pure, unit-tested):
- A subscription is **pruned** on HTTP 404/410 from the push service, and **disabled** after 5 consecutive failures of any other kind; it is re-enabled by a successful re-subscribe from the device.
- Payload minimisation: a push body may contain `promptId`, `kind`, `priority`, `provider`, a ≤ 60-char `title`, a ≤ 120-char `summary`, the worktree branch name, and nothing else. Tool arguments, file contents, command strings beyond the first 120 characters, and any value matching the M5-01 secret regexes are dropped **before** encryption. Full detail is fetched from the daemon when the app opens.
- Answer idempotency: `AnswerPrompt` (M1-11) already transitions only from `open`; this step adds an `Idempotency-Key` requirement so a retried offline answer or a double-tapped notification action produces exactly one `prompt.answered` event and returns the same result to both callers.
- Coalescing: at most one notification per `(sessionId)` per `coalesceWindowMs`; a burst collapses into a summary notification with no inline actions (actions require an unambiguous single prompt).

### 4.2 Interfaces / contracts
```ts
// packages/sdk/src/api/push.ts
export const PushSubscribeDto = z.object({
  subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  deviceLabel: z.string().min(1).max(60),
  minPriority: z.number().int().min(1).max(5).default(3),
});
export const PushPayload = z.object({
  v: z.literal(1),
  promptId: z.string(), kind: z.enum(['permission','question','planApproval','confirm','login','error']),
  priority: z.number().int().min(1).max(5), provider: z.string(), sessionId: z.string(),
  title: z.string().max(60), summary: z.string().max(120), branch: z.string().max(80).optional(),
  actions: z.array(z.object({ id: z.string(), label: z.string().max(24) })).max(2),
  hostId: z.string(), deepLink: z.string(),        // /attention/<promptId>
  coalesced: z.number().int().optional(),          // n prompts, actions omitted when set
});
// REST
// POST   /api/v1/push/subscribe      → 201 { id }
// DELETE /api/v1/push/subscribe/:id  → 204
// GET    /api/v1/push/subscriptions  → PushSubscriptionRecord[] (secrets omitted)
// POST   /api/v1/push/test/:id       → 202  (sends "Test notification" to one device)
// GET    /api/v1/push/vapid-public-key → { key: string }
// POST   /api/v1/prompts/:id/answer  (existing, M1-11) now requires header `Idempotency-Key`
```
```ts
// apps/daemon/src/application/push/push-notifier.port.ts
export interface PushSenderPort {
  send(sub: PushSubscriptionRecord, payload: PushPayload, ttlSeconds: number):
    Promise<Result<'sent', 'gone' | 'rate-limited' | 'transient' | 'payload-too-large'>>;
}
```
Service-worker outbox:
```ts
// apps/web/src/offline/outbox.ts  (IndexedDB store 'outbox')
export interface OutboxItem { key: string /* Idempotency-Key, ULID */; url: string; method: 'POST';
  body: string; createdAt: number; attempts: number; lastError?: string; promptId: string }
```

### 4.3 Data / schema changes
New migration `00NN_push_subscriptions.ts` (Postgres-compatible types only, per D8/ADR-010):
```
push_subscriptions(
  id text primary key, host_id text not null, endpoint text not null,
  p256dh text not null, auth text not null, device_label text not null,
  user_agent_family text not null, min_priority integer not null default 3,
  created_at text not null, last_success_at text, last_failure_at text,
  failure_count integer not null default 0, disabled_reason text,
  unique(host_id, endpoint)
)
```
`p256dh`/`auth` are client-public key material, not user secrets, but the table is still covered by the redacting serializer (they never appear in logs) and by M5-06 export exclusions. New events: `push.subscribed`, `push.unsubscribed`, `push.sent`, `push.failed`, `push.pruned` (namespace added to the `04-domain-model.md` event catalog).

### 4.4 Infrastructure (service worker, push, offline)
**Caching strategy per route class** (`apps/web/public/sw.js`, cache name `orchestra-<buildHash>`):
| Class | Examples | Strategy |
|---|---|---|
| App shell | `/`, `/index.html`, JS/CSS/fonts/icons (hashed) | **precache** on `install`, serve **cache-first**; `skipWaiting` only after the user accepts the "new version" toast |
| API reads | `/api/v1/prompts`, `/sessions`, `/events`, `/history/*` | **network-first with a 3 s timeout**, fall back to cache, always update the cache on success; responses tagged with a `sw-cached-at` header for the "showing data from HH:MM" banner |
| API writes | `POST /prompts/:id/answer` | **never cached**; on network failure → push to the outbox and return a synthetic `202 {queued:true}` to the app |
| WebSockets | `/ws`, `/term` | not interceptable by the SW; the app reconnects with `sinceEventId` (M5-05) |
| Large media | recordings (`.cast`) | **network-only** (never fill the cache with 40 MB pane recordings) |
Cache eviction: on `activate`, delete every cache whose name is not the current build hash; API cache capped at 200 entries LRU.

**Web Push transport**: `web-push` (VAPID, `aes128gcm`) from an allowlisted egress module (`apps/daemon/src/infrastructure/egress/push.ts`) so the `no-vendor-endpoints` ESLint rule and the M0-08 egress test both see exactly one new outbound destination class. TTL 900 s (a stale permission prompt is noise). Payload hard cap 3 000 bytes after encryption; `payload-too-large` → resend a coalesced-style notification with no `summary`.

**VAPID keys**: generated on first daemon boot into `~/.orchestra/push.json` (0600) as `{publicKey, privateKey, subject}` where `subject` is `mailto:orchestra@localhost` by default (configurable). Never in the DB, never in logs, excluded from M5-06 exports. `orch push rotate-keys` (M7-06) regenerates them and invalidates every subscription, forcing devices to re-subscribe — documented as a deliberately disruptive operation.

**Notification actions on the phone**: `notificationclick` in the SW reads `event.action`, resolves the token from IndexedDB (`auth` store, written at pairing), and POSTs the answer with `Idempotency-Key = <promptId>:<action>`. It then `showNotification`s a short result ("Denied — Claude continued") and closes the original. If the POST fails, the item goes to the outbox and the replacement notification says "queued — will send when online".

**Pairing**: the desktop app / browser shows a QR of `https://<origin>/pair#c=<one-time-code>`; `GET /api/v1/pair/:code` (single use, 5 min TTL, rate-limited) returns the device token. The code is in the URL **fragment**, so it is never sent to the server in a request line or logged — the page reads it client-side and posts it. Tokens are stored in IndexedDB, not `localStorage`, so the service worker can read them.

### 4.5 API / UI surface
- Routes: `/pair` (new), `/attention` (mobile layout), `/chat`, `/history`, `/terminals` (read-only on small screens).
- Settings → **Notifications**: this device's subscription state, `minPriority` selector, device list (label, last success, "Send test", Remove), "Notifications are delivered through your browser's push service" explanation with a link to the privacy note about payload minimisation.
- Offline UI: a persistent bar "Offline — showing data from 14:32"; queued answers render as cards with a `queued` badge and a spinner; a toast on successful flush.
- Install: `InstallPrompt` component; iOS instruction sheet with a screenshot; suppressed when `display-mode: standalone`.
- Mobile Attention card: title, provider chip, branch, risk badge, the prompt's own options as full-width buttons, swipe-free (no destructive gesture), 44 px minimum touch targets, respects `prefers-reduced-motion` and WCAG 2.1 AA contrast (12-ux-principles.md).

### 4.6 Flow / sequence
```
PAIRING
 desktop Settings → Pair a device → QR(https://host/pair#c=ABC123)
 phone scans → /pair page reads fragment → POST /api/v1/pair {code} → { token } → IndexedDB.auth
 → register SW → GET /push/vapid-public-key → registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})
 → POST /api/v1/push/subscribe {subscription, deviceLabel, minPriority} → push.subscribed

PUSH ROUND-TRIP
 agent asks → AgentPrompt opened (M1-11) → prompt.opened event
 → PushNotifier: filter(priority ≤ device.minPriority) → coalesce(sessionId, 3 s)
 → minimise + redact payload → PushSenderPort.send() per device → push.sent | push.failed | push.pruned
 → phone SW 'push' → showNotification(title, {body, actions:[Allow,Deny], data:{promptId, deepLink}})
 → user taps Allow → SW notificationclick → POST /prompts/:id/answer  (Idempotency-Key: <promptId>:allow)
 → prompt.answered → transport delivers → agent continues → SW shows "Allowed — Claude continued"

OFFLINE ANSWER
 tap Allow while offline → fetch rejects → outbox.put(item) → notification "queued"
 → 'online' event | Background Sync 'outbox-flush' | app foreground
 → for each item (oldest first): POST with its stored Idempotency-Key
      200/201 → delete item
      409 already-answered → delete item (exactly-once holds)
      5xx/network → attempts++ ; backoff 5s,15s,60s,5m ; after 6 attempts mark 'failed' and surface it
 → WS reconnect with sinceEventId → snapshot reconciles any answer applied while offline
```

## 5. Tasks
- [ ] `manifest.webmanifest` + icon set (192, 512, maskable, apple-touch) + `<meta name="theme-color">` for light/dark; verify with Lighthouse "Installable".
- [ ] Hand-written `sw.js`: precache list from the Vite build manifest, per-class fetch strategies, cache versioning + activate cleanup, `SKIP_WAITING` message handling, update toast in the app.
- [ ] `InstallPrompt` component + iOS instruction sheet + standalone detection (EN/AR).
- [ ] Migration `00NN_push_subscriptions`; `PushSubscriptionRepository` (Kysely) + in-memory fake for tests.
- [ ] VAPID key generation on boot (`~/.orchestra/push.json`, 0600), `GET /push/vapid-public-key`, rotation service.
- [ ] `PushSenderPort` + `WebPushSender` in the allowlisted egress module; extend the M0-08 egress test with the push destination and a negative case.
- [ ] `PushNotifier` application service: event subscription, priority filter, coalescing, payload minimisation + redaction (reuse M5-01 regexes), per-device fan-out, failure accounting, pruning.
- [ ] REST: subscribe / unsubscribe / list / test / vapid key; `Idempotency-Key` enforcement on `POST /prompts/:id/answer` with a stored key→result map (TTL 24 h).
- [ ] Pairing: `/pair` route, one-time code issuance + `POST /api/v1/pair`, 5 min TTL, single use, rate-limited; QR component in Settings.
- [ ] IndexedDB `auth` + `outbox` stores; outbox flush on `online`, Background Sync registration where supported, app-foreground flush fallback.
- [ ] SW `push` + `notificationclick` handlers with inline actions, result notification, offline queuing.
- [ ] Mobile layouts: Attention cards, Chat, History, read-only Terminals; 44 px targets; RTL check on Arabic.
- [ ] Settings → Notifications pane (device list, minPriority, test, remove) + the payload-minimisation privacy note.
- [ ] Playwright mobile-viewport E2E with FakeProvider covering install-state rendering, offline queue and flush (push itself is stubbed at the `PushSenderPort`).
- [ ] Manual round-trip on a real phone over the M7-04 tunnel; record timings and screenshots in `evidence/`.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M7-03-01 | unit | payload minimisation: a permission prompt whose command contains an API-key-shaped string and a 4 KB argument blob | output ≤ 120-char summary, key redacted, no `input`/`files` fields; schema-valid |
| UT-M7-03-02 | unit | coalescing: 6 `prompt.opened` for one session in 3 s | one payload with `coalesced: 6` and **no** `actions`; a 7th, 10 s later → its own actionable payload |
| UT-M7-03-03 | unit | subscription health: 404 then 410 responses; 5 consecutive `transient` failures | pruned on 404/410; disabled with `too-many-failures` after 5; a successful re-subscribe clears it |
| UT-M7-03-04 | unit | `minPriority` filter per device | a priority-4 question is sent only to devices with `minPriority >= 4`; a priority-1 error goes to all |
| UT-M7-03-05 | unit | outbox ordering + backoff schedule | items flush oldest-first; backoff 5s/15s/60s/5m; item marked `failed` after 6 attempts, never dropped silently |
| IT-M7-03-06 | integration | duplicate answer: same `Idempotency-Key` POSTed twice concurrently | exactly one `prompt.answered` event; both callers get the same 200 body |
| IT-M7-03-07 | integration | answering an already-answered prompt with a **different** key | 409 with `code: INVALID_TRANSITION`; no second event; outbox treats 409 as terminal success |
| IT-M7-03-08 | integration | `POST /api/v1/pair` with an expired / already-used / unknown code | 410 / 410 / 404; rate limiter blocks after 5 attempts per minute per IP; no token leaked in any response |
| E2E-M7-03-09 | e2e (mobile viewport) | offline: go offline, answer two prompts, come back online | both cards show `queued`; on reconnect both deliver; `events` shows exactly two `prompt.answered` |
| E2E-M7-03-10 | e2e | service-worker cache: load app, go offline, reload | shell renders from cache; History and the last prompts snapshot render; the "showing data from" bar is present; a write attempt queues instead of erroring |
| E2E-M7-03-11 | e2e | SW update flow: deploy a new build hash while the app is open | "new version" toast; accepting reloads onto the new SW; old caches deleted |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M7-03-01 | Install on iOS | 1. Open the tunnel URL in Safari on the iPhone 2. Share → Add to Home Screen 3. Launch from the Home Screen | Standalone window (no Safari chrome), dark theme, Attention as the start screen, icon correct on the Home Screen | ⬜ |
| TC-M7-03-02 | Install on Android | 1. Open in Chrome 2. Accept the install prompt 3. Launch | Same as TC-01; `beforeinstallprompt` path used, no instruction sheet shown | ⬜ |
| TC-M7-03-03 | Pairing | 1. Desktop Settings → Remote access → Pair a device 2. Scan the QR with the phone 3. Complete pairing 4. Re-scan the same QR | Phone authenticated without typing a token; the second scan is refused ("code already used"); daemon logs contain no code and no token | ⬜ |
| TC-M7-03-04 | **Approve a prompt from phone** (exit criterion) | 1. Phone locked, on the tunnel only (Wi-Fi off, LTE on) 2. On the Mac ask Claude to write a file 3. Observe the lock screen 4. Tap **Allow** without unlocking into the app | Notification within 5 s showing provider, branch and a readable summary; Allow answers the prompt; a follow-up notification confirms; the Mac's Attention card reaches `delivered`; the agent writes the file | ⬜ |
| TC-M7-03-05 | Deny from phone | 1. Ask Claude to run a destructive command 2. Tap **Deny** on the phone | Claude reports the denial; Events show `actor.kind = user` with the device label; the card shows the answering device | ⬜ |
| TC-M7-03-06 | Coalescing | 1. Trigger 5 prompts in one session within 3 s | One notification "5 prompts need you" with no inline actions; tapping it opens `/attention` with all five listed | ⬜ |
| TC-M7-03-07 | **Negative — offline phone** | 1. Airplane mode on the phone 2. Open the PWA 3. Read History and the Attention list 4. Answer a prompt 5. Airplane mode off | History and the cached queue render with the "showing data from HH:MM" bar; the answer shows `queued`; on reconnect it delivers within 2 s; exactly one `prompt.answered` event (`orch replay --prompt <id> --json`) | ⬜ |
| TC-M7-03-08 | **Negative — expired token** | 1. Run `orch token rotate` on the daemon 2. Use the phone (foreground request, then a notification action) | Foreground: re-pair screen, no crash, cached history still readable. Notification action: a "sign in again" notification, the answer is **not** silently queued forever, and the prompt stays open on the desktop | ⬜ |
| TC-M7-03-09 | **Negative — double tap** | 1. Receive a notification 2. Tap **Allow** twice quickly (or Allow then Deny) | Exactly one `prompt.answered`; the second action returns "already answered" and shows the recorded answer; the agent is not told twice | ⬜ |
| TC-M7-03-10 | **Negative — subscription revoked** | 1. In the phone's browser settings, revoke notification permission (or delete the PWA) 2. Trigger a prompt 3. Check Settings → Notifications on the desktop | Send fails with `gone`; the device is pruned from the list with a visible reason; no retry storm in the logs | ⬜ |
| TC-M7-03-11 | **Resilience — daemon restarted mid-flight** | 1. Trigger a prompt 2. `kill -9` the daemon before the phone answers 3. Restart it 4. Tap **Allow** on the still-visible notification | M5-05 restores the prompt with the same id; the notification action succeeds against the restored prompt; the agent continues; `restore_lost_prompts` stays 0 | ⬜ |
| TC-M7-03-12 | Payload privacy | 1. Trigger a prompt whose command contains a fake secret (`export TOKEN=sk-live-abc…`) 2. Read the notification on the phone 3. `grep` the daemon log for the secret | Notification summary is truncated and redacted — the secret is not visible on the lock screen; the log shows `[Redacted]`; the full command is only visible after opening the app | ⬜ |
| TC-M7-03-13 | Read-only terminals on phone | 1. Open Terminals on the phone 2. Attempt to type 3. Enable the typing toggle | Output streams legibly; typing is inert until the toggle is on; with the toggle on, keystrokes reach the agent over `/term` (no IPC involved) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] The app installs on iOS and Android (TC-01/02) and Lighthouse reports it installable with no PWA errors.
- [ ] **A prompt can be approved from a locked phone via the notification's inline action within 5 s of `prompt.opened`** (TC-M7-03-04), over the tunnel, without opening the app.
- [ ] Offline: history and the last queue render, answers queue, and every queued answer delivers **exactly once** on reconnect (TC-07, IT-06, E2E-09).
- [ ] `push_subscriptions` migration applied; devices are listed, testable, removable, and auto-pruned on `gone`.
- [ ] VAPID keys are generated locally at 0600, never logged, never exported, and rotatable.
- [ ] Push payloads carry only the minimised, redacted fields defined in §4.1; TC-M7-03-12 proves no secret reaches the lock screen.
- [ ] The only new egress is the push service endpoint supplied by the browser; the M0-08 egress test is extended and green.
- [ ] Mobile layouts meet WCAG 2.1 AA contrast and 44 px touch targets, work in RTL, and respect `prefers-reduced-motion`.
- [ ] All TC pass; no new lint/dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- iOS Web Push requires the PWA to be installed to the Home Screen, permission must be requested from a user gesture, and support has shifted between OS releases — every iOS claim here is "(verify at step start)". If iOS blocks a required behaviour (for example, if notification **actions** are not honoured), the fallback is a tap-to-open deep link straight onto the prompt card, and the exit criterion is demonstrated on Android with the iOS limitation documented.
- Notification action button count and label length are user-agent dependent (two actions is the safe maximum) — "(verify)".
- Background Sync is not available on all browsers; the `online`-event + foreground flush path is the guaranteed mechanism and is what the tests assert.
- Push service latency is outside our control; the 5 s target is measured over a normal connection and recorded, not enforced as an SLO.
- A push service endpoint is a third party receiving encrypted payloads plus timing metadata. The privacy note must say this plainly, and the minimisation rules must be reviewed whenever a new notification type is added (M8-08).
- The one-time pairing code is the weakest link in the flow; it is fragment-only, single-use, 5-minute TTL and rate-limited, but a shoulder-surfed QR is a real threat. Whether to require a desktop-side confirm ("a device just paired — was that you?") is an open question; M9-01 makes it mandatory under RBAC.
- Answering from a notification bypasses the app's own preview UI, which is in tension with C10's "preview before spend/keys". Mitigation: the notification body *is* the preview (tool + truncated command + branch), and destructive-risk prompts can be configured to require opening the app — default off, decided during TC-05.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
