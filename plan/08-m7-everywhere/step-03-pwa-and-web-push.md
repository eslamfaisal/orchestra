# Step M7-03 — PWA & Web Push

| Field | Value |
|---|---|
| Milestone | M7 — Everywhere |
| Status | ⬜ Not started |
| Depends on | M0-07, M5-05, M1-11, M0-04, M7-04 |
| Estimated effort | 2.5 days |
| Packages touched | `apps/web` (manifest, service worker, install prompt, offline queue, mobile layouts), `apps/daemon` (`src/application/push`, `src/infrastructure/push`, `src/interface/http/push`, migration `push_subscriptions`), `packages/core` (idempotent answer rules), `packages/sdk` (push DTOs), `packages/ui` (mobile card variants) |
| Risk | High (iOS Web Push behaviour is the least stable surface in the milestone) |
| Owner | |

## 1. Goal
The web UI becomes an installable progressive web app. On a phone it can be added to the Home Screen, launches standalone, renders Attention / Chat / History in a layout built for a 390 px screen, and — crucially — receives a **Web Push notification within seconds of an `AgentPrompt` opening**. Where the browser and OS support notification *actions*, inline **Allow** / **Deny** buttons answer the prompt without opening the app; where they do not, the notification is tap-to-open and lands on the prompt card — the behaviour is a declared per-browser tier (§4.7), not an assumption. Offline, the app still renders cached history and the last Attention snapshot, queues answers locally, and submits each queued answer **exactly once into the daemon** (`Idempotency-Key`) when connectivity returns; whether that answer is then *applied* depends on revalidation (§4.8), and its onward delivery to the vendor follows the M1-11 answer states (`submitted → acknowledged | delivery_uncertain`). Push subscriptions live in the daemon in a new `push_subscriptions` table; the VAPID keypair is generated locally on first run and never leaves the host.

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
- Notification actions **Allow** / **Deny** / **Open** handled in the service worker's `notificationclick`, calling `POST /api/v1/prompts/:id/answer` with an `Idempotency-Key` — no app window needed **on the browsers whose tier supports actions** (§4.7); every other tier degrades to tap-to-open on the prompt card, and the capability tier is detected at subscribe time and stored on the subscription record.
- Offline: cached shell + last snapshots readable; an `outbox` in IndexedDB for answers submitted offline; Background Sync where available, replay-on-reconnect everywhere else; exactly-once *submission* via `Idempotency-Key` (M0-04 convention) and the M5-05 `sinceEventId` resubscribe.
- **Staleness revalidation of queued answers** (§4.8): the daemon re-checks prompt generation, session state, expiry and the answering principal's authorization before applying an offline answer; a stale answer is refused with 409 and a reason, and the phone says "prompt changed — review again".
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
  userAgentFamily: string;    // coarse label for the device list only — never the capability source
  notificationTier: 'actions' | 'tap-only' | 'foreground-only' | 'unsupported';  // detected, §4.7
  minPriority: 1|2|3|4|5;     // AgentPrompt priority threshold for this device
  createdAt: string; lastSuccessAt?: string; lastFailureAt?: string; failureCount: number;
  disabledReason?: 'gone' | 'too-many-failures' | 'user';
}
```
Rules (pure, unit-tested):
- A subscription is **pruned** on HTTP 404/410 from the push service, and **disabled** after 5 consecutive failures of any other kind; it is re-enabled by a successful re-subscribe from the device.
- Payload minimisation: a push body may contain `promptId`, `kind`, `priority`, `provider`, a ≤ 60-char `title`, a ≤ 120-char `summary`, the worktree branch name, and nothing else. Tool arguments, file contents, command strings beyond the first 120 characters, and any value matching the M5-01 secret regexes are dropped **before** encryption. Full detail is fetched from the daemon when the app opens.
- Answer idempotency: `AnswerPrompt` (M1-11) already transitions only from `open`; this step adds an `Idempotency-Key` requirement so a retried offline answer or a double-tapped notification action produces exactly one `prompt.answered` event and returns the same result to both callers. Idempotency is about **submission into the daemon**; it says nothing about whether the vendor received the answer — that is M1-11's `acknowledged` / `delivery_uncertain` distinction, and this step never presents `submitted` as `acknowledged`.
- Answer freshness: an answer carries the `promptGeneration` the device saw. The daemon applies it only if that generation is still current and the four revalidation checks in §4.8 pass; otherwise it is refused, not applied. A refusal is a normal outcome, not an error state for the device.
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
//        and body field `observedGeneration` (§4.8); 409 on a stale answer with a typed reason
```
```ts
// packages/sdk/src/api/prompts.ts  (extended here, owned by M1-11)
export const AnswerPromptDto = z.object({
  optionId: z.string(), text: z.string().max(4000).optional(),
  observedGeneration: z.number().int(),   // the prompt generation the device rendered
  observedAt: z.string().datetime(),      // when the device rendered it (offline answers can be hours old)
});
export const StaleAnswerReason = z.enum([
  'generation_changed',    // the prompt was re-raised or its payload/options changed (M5-05 restore, re-ask)
  'prompt_not_open',       // already answered, cancelled, or superseded
  'prompt_expired',        // past deadlineAt; M1-11 decides whether a fallback re-ask exists
  'session_not_running',   // session crashed, finished or was killed while the device was offline
  'principal_unauthorized',// the device token was rotated/revoked, or the principal lost the right to answer
]);
// 409 body: { code: 'STALE_ANSWER', reason: StaleAnswerReason, currentGeneration, promptState, sessionState }
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
  user_agent_family text not null, notification_tier text not null, min_priority integer not null default 3,
  created_at text not null, last_success_at text, last_failure_at text,
  failure_count integer not null default 0, disabled_reason text,
  unique(host_id, endpoint)
)
```
`p256dh`/`auth` are client-public key material, not user secrets, but the table is still covered by the redacting serializer (they never appear in logs) and by M5-06 export exclusions. New events: `push.subscribed`, `push.unsubscribed`, `push.sent`, `push.failed`, `push.pruned`, `prompt.answer_rejected` (namespace added to the `04-domain-model.md` event catalog).

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

**Notification actions on the phone** (tier `actions` only, §4.7): `notificationclick` in the SW reads `event.action`, resolves the token from IndexedDB (`auth` store, written at pairing), and POSTs the answer with `Idempotency-Key = <promptId>:<action>` and `observedGeneration`. It then `showNotification`s a short result — "Denied — Claude continued" once the answer is `acknowledged`, or "Denied — sent, waiting for Claude" while it is only `submitted` — and closes the original. On a network failure the item goes to the outbox and the replacement notification says "queued — will send when online". On a 409 `STALE_ANSWER` the replacement notification says "prompt changed — review again" and opens the card (§4.8). On tiers other than `actions`, `notificationclick` has no `event.action` and simply focuses/opens the PWA on the prompt's deep link.

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
 → phone SW 'push' → showNotification(title, {body, data:{promptId, generation, deepLink},
                        actions: tier === 'actions' ? [Allow, Deny] : []})       ← §4.7
 → tier 'actions':  user taps Allow → SW notificationclick → POST /prompts/:id/answer
                       (Idempotency-Key: <promptId>:allow, observedGeneration)
   other tiers:     user taps the notification → PWA opens on /attention/<promptId> → answers there
 → prompt.answered → transport delivers → M1-11 states: submitted → acknowledged (structured ack)
                                                      → delivery_uncertain (no provable ack)
 → SW shows "Allowed — Claude continued" only on acknowledged; otherwise "Allowed — sent, waiting"

OFFLINE ANSWER
 tap Allow while offline → fetch rejects → outbox.put({...item, observedGeneration}) → notification "queued"
 → 'online' event | Background Sync 'outbox-flush' | app foreground
 → for each item (oldest first): POST with its stored Idempotency-Key + observedGeneration
      200/201                    → delete item (submitted; state then follows M1-11)
      409 INVALID_TRANSITION     → delete item (the same answer already landed — exactly-once holds)
      409 STALE_ANSWER {reason}  → delete item, DO NOT retry → "prompt changed — review again" + Review card (§4.8)
      401/403                    → stop the flush, keep items, show "sign in again" (never loop)
      5xx/network → attempts++ ; backoff 5s,15s,60s,5m ; after 6 attempts mark 'failed' and surface it
 → WS reconnect with sinceEventId → snapshot reconciles any answer applied while offline
```

### 4.7 Notification behaviour is per-browser, and declared
Web Push is one API with materially different behaviour per browser and OS version. This step does not assume a uniform surface; it declares tiers, detects the tier at subscribe time, stores it on `PushSubscriptionRecord.notificationTier`, and both the sender and the UI branch on it. Every row below is *(verify against the browser's current documentation and a real device at step start — the result is recorded in `evidence/` alongside the M0-09 style capability rows)*.

| Tier | What the device can do | Payload the notifier sends | What the user gets |
|---|---|---|---|
| `actions` | `showNotification` honours `actions[]`, and `notificationclick` runs with `event.action` set while the app is closed | up to **2** actions (`Allow`/`Deny`), labels ≤ 24 chars | answer from the lock screen; a result notification replaces the original |
| `tap-only` | notifications render, actions are ignored or not displayed | `actions: []`, body carries the same summary | tapping opens the PWA directly on `/attention/<promptId>`; the answer is one tap away, not zero |
| `foreground-only` | push is delivered but only while the PWA is open / recently used, or permission is scoped narrowly | same as `tap-only` | the phone is a *secondary* channel; the desktop tray (M7-01) remains the primary one for this device |
| `unsupported` | no push (permission denied, not installed to the Home Screen, browser without Web Push) | nothing sent; the subscription is not created | Settings → Notifications says why, in one sentence, and offers the install instructions for that browser |

Rules:
- The capability tier is **detected, never inferred from the user-agent string alone**: the client probes `Notification.maxActions`, `ServiceWorkerRegistration.showNotification` support and the current `Notification.permission`, and sends the result with `POST /push/subscribe`; `userAgentFamily` is only a coarse label for the device list.
- iOS Safari additionally requires the PWA to be installed to the Home Screen and the permission request to originate in a user gesture; a device that has not met those preconditions is `unsupported` until it has, and the install sheet says exactly that.
- **The fallback always opens the app.** No tier silently drops a prompt: if actions are unavailable, the notification is actionable by opening, and if push is unavailable the prompt still appears in the Attention queue and in the desktop tray. The phone is an additional channel, never the only one.
- Action labels and count are clamped to the tier (`min(2, Notification.maxActions)`); a coalesced burst is always `tap-only` regardless of tier, because actions require one unambiguous prompt.
- The exit criterion (TC-M7-03-04) is demonstrated on a device in the `actions` tier; on every other tier the equivalent criterion is "tap the notification → the prompt card is on screen and answerable in one tap", and the measured tier per tested device is recorded.

### 4.8 A queued answer is revalidated before it is applied
An answer written to the outbox while offline can be minutes or hours old. Exactly-once submission does **not** mean the answer is still meaningful. Before `AnswerPrompt` runs, `POST /api/v1/prompts/:id/answer` revalidates four things, in this order, inside the same transaction that would record the answer:

1. **Generation / version** — `observedGeneration` equals the prompt's current `generation`. The counter is bumped whenever the prompt is re-raised or its options/payload change (M5-05 restore, an agent re-asking after a restart, an edited plan). A different generation means the user answered a *different question*.
2. **Session state** — the session is still `running` and is the same session instance (`sessionId` + start epoch). A crashed, finished or killed session cannot consume the answer.
3. **Expiry** — the prompt is not past `deadlineAt` in a way that already triggered M1-11's fallback. An expired prompt that M1-11 still allows to be answered is applied; one that was re-asked natively in the pane is `generation_changed` and refused.
4. **Principal authorization** — the token that signed the request still exists, is not rotated or revoked, and the principal is still allowed to answer prompts of this risk level for this session (M9-01 tightens this; v1 checks token validity and device enablement).

On failure the request returns **409 `STALE_ANSWER`** with the typed `reason`, the current generation, and the current prompt/session state. The daemon records `prompt.answer_rejected { reason }` for the audit trail and **does not** change prompt state.

Device behaviour on 409:
```
outbox flush → 409 STALE_ANSWER
 → remove the item from the outbox (terminal: never retried — retrying a stale answer is the bug)
 → showNotification("Prompt changed — review again", body = the reason in one plain sentence,
                    tap → /attention/<promptId> or /attention if the prompt is gone)
 → the queued card in the app flips from `queued` to `needs review` with the reason and a Review button
```
The phone never reports "answered" for a refused answer, and it never silently applies one. `409 INVALID_TRANSITION` from an *already-answered* prompt stays terminal-success as before (the same answer arrived twice); `409 STALE_ANSWER` is terminal-refusal and is surfaced. The two are distinguished by `code`, never by status alone.

Once accepted, the answer's onward journey is M1-11's: `submitted` → `acknowledged` when a structured ack is observed, or `delivery_uncertain` when the transport cannot prove delivery. The phone shows those states verbatim; "sent" is not rendered as "done".

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
- [ ] SW `push` + `notificationclick` handlers: tier-aware actions, result notification reflecting the M1-11 answer state, offline queuing, 409 `STALE_ANSWER` handling.
- [ ] Notification capability detection (`Notification.maxActions`, SW `showNotification`, permission state, standalone-display check) → `notificationTier` on subscribe; tier column + migration; Settings shows the detected tier per device with a one-sentence explanation.
- [ ] Revalidation (§4.8) in `AnswerPrompt`'s HTTP edge: `observedGeneration`/`observedAt` in the DTO, the four checks in one transaction, typed 409 `STALE_ANSWER` body, `prompt.answer_rejected` event, and the "needs review" card + notification on the device.
- [ ] Prompt `generation` counter: consume it from M1-11 if present at step start, otherwise add it as a migration plus an M1-11 amendment note (bumped on re-raise, payload/option change, and M5-05 restore-re-ask).
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
| UT-M7-03-12 | unit | tier detection: `maxActions = 0`, `maxActions = 2`, permission `denied`, non-standalone iOS | `tap-only`, `actions`, `unsupported`, `unsupported`; the payload builder emits 0 / 2 / no-send / no-send actions accordingly; user-agent string alone never decides |
| UT-M7-03-13 | unit | payload for a `tap-only` device | `actions: []`, `deepLink` present and pointing at `/attention/<promptId>`; the body still carries the readable summary |
| IT-M7-03-14 | integration | stale answer: generation bumped (prompt re-raised) while the device was offline | 409 `{ code: 'STALE_ANSWER', reason: 'generation_changed', currentGeneration }`; prompt state unchanged; one `prompt.answer_rejected` event; no `prompt.answered` |
| IT-M7-03-15 | integration | queued answer for a session that crashed while offline | 409 `reason: 'session_not_running'`; nothing delivered to any transport |
| IT-M7-03-16 | integration | queued answer past `deadlineAt` where M1-11 already re-asked natively | 409 `reason: 'prompt_expired'` or `'generation_changed'` per M1-11's rule — asserted against M1-11's expiry contract, not re-implemented here |
| IT-M7-03-17 | integration | queued answer whose device token was rotated while offline | 401 on the flush (items kept, no loop); after re-pairing, the same answer is re-submitted and then revalidated normally — a revoked principal never answers |
| IT-M7-03-18 | integration | answer accepted but the transport cannot prove delivery | response carries M1-11 state `delivery_uncertain`; the device renders "sent, waiting", never "done" |
| E2E-M7-03-09 | e2e (mobile viewport) | offline: go offline, answer two prompts, come back online | both cards show `queued`; on reconnect both deliver; `events` shows exactly two `prompt.answered` |
| E2E-M7-03-10 | e2e | service-worker cache: load app, go offline, reload | shell renders from cache; History and the last prompts snapshot render; the "showing data from" bar is present; a write attempt queues instead of erroring |
| E2E-M7-03-11 | e2e | SW update flow: deploy a new build hash while the app is open | "new version" toast; accepting reloads onto the new SW; old caches deleted |
| E2E-M7-03-19 | e2e (mobile viewport) | offline answer, then the prompt is answered on the desktop before reconnect | on flush the device gets 409; the card becomes **needs review** with the reason; exactly one `prompt.answered` in `events`; the outbox is empty and nothing retries |

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
| TC-M7-03-14 | Notification tier is detected and shown | 1. Subscribe from iOS Safari (installed), Android Chrome and a desktop browser 2. Settings → Notifications | Each device lists its detected tier; a device that cannot do actions says so plainly and its notifications open the card instead; no device claims a capability it does not have | ⬜ |
| TC-M7-03-15 | Tap-only fallback | 1. On a device in the `tap-only` tier, trigger a prompt 2. Tap the notification | No action buttons are shown (nothing looks broken or empty); the PWA opens directly on the prompt card and the answer is one tap away | ⬜ |
| TC-M7-03-16 | **Negative — stale queued answer (prompt changed)** | 1. Airplane mode 2. Tap Allow on a permission prompt 3. On the Mac, cancel that prompt and let the agent re-ask 4. Airplane mode off | The queued answer is refused; the phone shows "prompt changed — review again" and opens the *new* prompt; the old answer is never applied to the new prompt; Events show `prompt.answer_rejected { reason: generation_changed }` | ⬜ |
| TC-M7-03-17 | **Negative — stale queued answer (session gone)** | 1. Airplane mode 2. Answer a prompt 3. Kill the session on the Mac 4. Airplane mode off | 409 `session_not_running`; the card becomes "needs review" explaining the session ended; no transport delivery attempt is logged | ⬜ |
| TC-M7-03-18 | Answer state honesty | 1. Answer a prompt from the phone on a provider whose ack is not structured 2. Watch the phone and the desktop card | Both show `delivery_uncertain` ("sent, waiting for the agent"), not "done"; the card only reaches `acknowledged` when a structured ack arrives | ⬜ |
| TC-M7-03-13 | Read-only terminals on phone | 1. Open Terminals on the phone 2. Attempt to type 3. Enable the typing toggle | Output streams legibly; typing is inert until the toggle is on; with the toggle on, keystrokes reach the agent over `/term` (no IPC involved) | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] The app installs on iOS and Android (TC-01/02) and Lighthouse reports it installable with no PWA errors.
- [ ] **A prompt can be approved from a locked phone within 5 s of `prompt.opened`** (TC-M7-03-04), over the tunnel: via the notification's inline action on a device in the `actions` tier, and via one tap into the prompt card on every other tier. The tier of each tested device is recorded in `evidence/`.
- [ ] Notification behaviour is declared per tier (§4.7), detected rather than assumed, visible in Settings, and no tier silently drops a prompt — the fallback always opens the app (TC-M7-03-14/15).
- [ ] Offline: history and the last queue render, answers queue, and every queued answer is submitted into the daemon **exactly once** on reconnect (TC-07, IT-06, E2E-09). Onward delivery to the vendor is reported with the M1-11 answer states and is never presented as guaranteed (TC-M7-03-18).
- [ ] **No stale answer is applied**: generation, session state, expiry and principal authorization are revalidated before `AnswerPrompt` runs; a refusal returns 409 `STALE_ANSWER` with a reason, is audited as `prompt.answer_rejected`, is terminal on the device, and surfaces as "prompt changed — review again" (IT-M7-03-14..17, E2E-M7-03-19, TC-M7-03-16/17).
- [ ] `push_subscriptions` migration applied; devices are listed, testable, removable, and auto-pruned on `gone`.
- [ ] VAPID keys are generated locally at 0600, never logged, never exported, and rotatable.
- [ ] Push payloads carry only the minimised, redacted fields defined in §4.1; TC-M7-03-12 proves no secret reaches the lock screen.
- [ ] The only new egress is the push service endpoint supplied by the browser; the M0-08 egress test is extended and green.
- [ ] Mobile layouts meet WCAG 2.1 AA contrast and 44 px touch targets, work in RTL, and respect `prefers-reduced-motion`.
- [ ] All TC pass; no new lint/dependency-cruiser violations; `PROGRESS.md` updated.

## 8. Risks / open questions
- iOS Web Push requires the PWA to be installed to the Home Screen, permission must be requested from a user gesture, and support has shifted between OS releases — every iOS claim here is *(verify against Apple's current documentation and a real device at step start)*. The tier model in §4.7 exists so that an iOS limitation degrades one device's tier rather than invalidating the step: the exit criterion is then met on an `actions`-tier device and the iOS tier is recorded.
- Notification action button count and label length are user-agent dependent (two actions is the safe maximum) and can change with a browser update — hence detection at subscribe time, re-detected on every re-subscribe, rather than a table compiled once *(verify)*.
- Revalidation needs a prompt `generation` counter. M1-11 owns that field; if it is not present at step start this step adds it and records an amendment on M1-11 rather than inventing a parallel notion of freshness.
- `observedAt` is device clock time and can be wrong; it is recorded for the audit trail and for operator diagnosis only — no decision in §4.8 depends on it.
- Background Sync is not available on all browsers; the `online`-event + foreground flush path is the guaranteed mechanism and is what the tests assert.
- Push service latency is outside our control; the 5 s target is measured over a normal connection and recorded, not enforced as an SLO.
- A push service endpoint is a third party receiving encrypted payloads plus timing metadata. The privacy note must say this plainly, and the minimisation rules must be reviewed whenever a new notification type is added (M8-08).
- The one-time pairing code is the weakest link in the flow; it is fragment-only, single-use, 5-minute TTL and rate-limited, but a shoulder-surfed QR is a real threat. Whether to require a desktop-side confirm ("a device just paired — was that you?") is an open question; M9-01 makes it mandatory under RBAC.
- Answering from a notification bypasses the app's own preview UI, which is in tension with C10's "preview before spend/keys". Mitigation: the notification body *is* the preview (tool + truncated command + branch), and destructive-risk prompts can be configured to require opening the app — default off, decided during TC-05.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
