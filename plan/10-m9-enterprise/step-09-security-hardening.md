# Step M9-09 — Security hardening

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M9-03 |
| Estimated effort | 2 days |
| Packages touched | `packages/core` (`src/redaction/`), `packages/sdk` (`fixtures/secrets-corpus/`), `apps/daemon` (`src/infrastructure/crypto`, `src/infrastructure/persistence`, `src/interface/http/security`, `src/application/history`), `apps/web` (CSP compliance, no inline handlers), `deploy/helm/orchestra` (NetworkPolicy, securityContext), `docs/security` (threat model, pen-test checklist), `.github/workflows` (SBOM/dep review) |
| Risk | High (this step's output is the security claim the project makes publicly) |
| Owner | |

## 1. Goal
The security posture stops being a set of scattered promises and becomes a documented, tested position. This step: (a) **decides and documents encryption at rest** — OS/volume encryption as the baseline, with optional column-level encryption for the handful of genuinely sensitive columns — and implements the chosen option; (b) **audits secret scrubbing end to end** against a versioned corpus of secret shapes, across recordings, messages, tool-call arguments, events, audit rows, exports and telemetry, with measured recall and false-positive rates; (c) **defines retention policies per artifact kind** and makes them the shipped defaults; (d) publishes a **STRIDE threat model** over the planes in `03-architecture.md`; (e) provides a **pen-test checklist** that a reviewer can execute against a running instance; (f) closes the loop on **dependency/SBOM review** and (g) enforces **CSP and the other security headers** on the web app with zero violations across all 13 screens.

## 2. Why
- C13 ("secrets never stored; scrubbed from recordings at capture time") and C3 ("tokens never seen/stored/forwarded") are asserted in several steps (M5-01 capture-time redaction, M0-04 log redaction, M9-03 audit redaction) but have never been *measured*. A rule that is never measured is a hope.
- Source plan §17 names "secrets never stored, scrubbed in recordings, **encryption at rest**" as an enterprise pillar; M9-02 and M9-07 both deferred a storage decision ("refresh token", "webhook secret") to this step, and M9-04 deferred signed approvals here. This step must answer those three questions explicitly.
- `07-compliance-rules.md` "Supply-chain controls" already requires SBOM, provenance and Scorecard ≥ 7 (M0-08, M10-08); what is missing is the *review* habit and a dependency diff at milestone boundaries.
- M9-03 gave detection (tamper-evident audit); a threat model is what tells a reader which attacks that detection covers and which it does not.
- The 1.0 DoD requires OpenSSF Best Practices "passing" and a SECURITY.md; a written threat model and pen-test checklist are the cheapest way to satisfy the "security review" criteria and to give M10-08's audit something to check against.
- CSP matters more than usual here: the web app renders agent-produced markdown, diffs and terminal output. An agent that can inject script into a rendered message would cross from "an agent wrote bad code" to "an agent controls the operator's browser session".

## 3. Scope
### In scope
- **Encryption-at-rest decision** written as `ADR-017-encryption-at-rest` and implemented: baseline = OS/volume encryption (FileVault on the dev machine, encrypted PV/volume in Kubernetes, encrypted RDS/bucket in cloud), documented as a deployment requirement; optional = column-level encryption for a short, explicit list of sensitive columns via a `CryptoPort` (`pgcrypto` on Postgres, an application-side AES-256-GCM envelope on SQLite). SQLCipher is evaluated and rejected or accepted in the ADR.
- `CryptoPort` + key management: key from env/keychain (never config files), key id stored alongside ciphertext, rotation procedure, and a `orch security rotate-key` command.
- **Secrets-scrubbing audit**: a versioned `secrets-corpus` in `packages/sdk/fixtures/secrets-corpus/` (positives and near-miss negatives), a harness that pushes it through every sink (recording, message, tool args, event payload, audit row, export bundle, JSONL audit export, metrics, spans, logs), and a report with recall and false-positive rate per rule.
- **Retention policy defaults per artifact kind**, expressed in M5-06's `RetentionPolicy` shape and shipped in `examples/policies/retention.yaml`, plus the audit-specific policy from M9-03.
- **Threat model** `docs/security/threat-model.md`: STRIDE per plane (Terminal, Telemetry, Delegation, Intelligence, Maintenance, Event store, Plugin host) + the surfaces added in M9 (OIDC, audit sinks, webhook, `/metrics`, object store, container), with mitigations mapped to step ids and explicit residual risks.
- **Pen-test checklist** `docs/security/pentest-checklist.md`: an executable list (authn/authz, session, injection, SSRF, path traversal, secrets, rate limits, headers, WS, MCP, supply chain) with expected results, runnable against a local instance.
- **CSP + security headers** on the web app and the daemon's static serving: `default-src 'self'`, no `unsafe-inline`/`unsafe-eval` (nonce or hash for the Vite bundle), `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, plus sanitisation review for markdown/diff/snippet rendering.
- **Dependency/SBOM review**: CycloneDX SBOM diff since the last milestone, `pnpm audit` triage, a written note per accepted advisory, and a NetworkPolicy completing M9-06's commented-out sample.
### Out of scope (deferred to …)
- An external professional penetration test — the checklist enables one; commissioning it is a project decision for M10-08.
- HSM/KMS-backed keys and per-user signing of approvals (deferred from M9-04) — the ADR states the position; implementation is M10 backlog unless the ADR concludes otherwise.
- Full-disk encryption *implementation* — it is an operator responsibility; Orchestra verifies and reports, it does not encrypt volumes.
- Sandboxing agent processes beyond what the vendor CLIs provide (seccomp per pane, gVisor) — not planned for 1.0; the worktree + env allowlist (M0-04 `childEnv`) is the boundary.
- Repair-Agent guardrails (C12) — M10-01 owns them; the threat model documents the intended boundary.
- Automated remediation of dependency advisories — Renovate (M0-08) already proposes; this step only adds the review ritual.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
- `SensitiveColumn` registry (a constant list, reviewed in the ADR): `auth_sessions.refresh_token_enc`, `automations.webhook_secret_enc`, `api_tokens.token_hash` (already a hash — listed to prove it needs no encryption), `settings_layers.value_json` **only for keys marked sensitive**, `audit_log.before_json/after_json` (**not** encrypted — encrypting them would break offline verification; redaction is the control). Anything not on the list is explicitly not encrypted, and the list is the thing a reviewer reads.
- `CipherEnvelope` value object: `{ v: 1, kid: string, alg: 'AES-256-GCM' | 'pgcrypto', iv: base64, ct: base64, tag: base64 }` stored as JSON text so both dialects (M9-05) hold the same shape.
- Pure rules (`packages/core/src/redaction/audit.ts`, added to M5-01's redactor, 100 % branch):
  - `scrubReport(corpus, results) → { recall, falsePositiveRate, perRule: Array<{ruleId, tp, fn, fp}> }` — deterministic scoring so the numbers in the acceptance criteria are reproducible.
  - Rule: a redaction rule may only *replace*, never drop or reorder content (already M5-06's invariant — re-asserted here across all sinks).
  - Rule: chunk-boundary safety — a secret split across two writes must still be caught; the carry-over buffer is `max(rule.maxLen)` (M5-01) and the corpus harness explicitly tests split positions.
- `RetentionDefault` table (shipped values, all overridable per M5-06/M8-01 layering):

| Artifact kind | Default TTL | minKeep | Action | Rationale |
|---|---|---|---|---|
| `recording` | 90 d | 20 per session | purge | largest artifact; replay value decays |
| `attachment` | 90 d | 10 | purge | follows recordings |
| `message` | 365 d | 200 per session | purge | G5 recall vs growth |
| `event` | 365 d | — | purge | analytics value decays |
| `task_result` | 730 d | — | keep | small, high evidential value |
| `restore_run` | 90 d | — | purge | operational only |
| `telemetry_inbox` | 30 d | — | purge | raw vendor payloads, highest leak risk |
| `audit_log` | `never` (opt-in numeric) | — | anchor-purge (M9-03) | compliance-driven |
| `auth_login_attempts` | 30 d | — | purge | M9-02 |
| `automation_runs` | 180 d | — | purge | M9-07 |

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/infrastructure/crypto/crypto.port.ts
export interface CryptoPort {                      // DI strategy: 'none' | 'app-aes-gcm' | 'pgcrypto'
  readonly mode: 'none' | 'app-aes-gcm' | 'pgcrypto';
  readonly activeKeyId: string;
  encrypt(plaintext: string, aad: string): Result<CipherEnvelope, CryptoError>;
  decrypt(env: CipherEnvelope, aad: string): Result<string, CryptoError>;
  rotate(newKeyId: string): Promise<Result<{ reencrypted: number }, CryptoError>>;
}
export type CryptoError = { code: 'KeyMissing' | 'KeyUnknown' | 'DecryptFailed' | 'ModeDisabled' | 'AadMismatch'; message: string };

// packages/sdk/src/security/secrets-corpus.ts
export interface CorpusCase { id: string; kind: 'positive' | 'near_miss'; ruleId?: string; text: string; splitAt?: number[] }
export interface ScrubTarget { id: 'recording' | 'message' | 'tool_args' | 'event' | 'audit' | 'export_bundle' | 'audit_export' | 'metrics' | 'span' | 'log'; run(input: string): Promise<string> }
export interface ScrubReport { recall: number; falsePositiveRate: number; perRule: Array<{ ruleId: string; tp: number; fn: number; fp: number }>; perTarget: Array<{ target: ScrubTarget['id']; leaked: CorpusCase['id'][] }> }

// apps/daemon/src/application/security/ — one use case per class
export class ScanSecrets      { execute(o: { corpusPath: string; targets?: ScrubTarget['id'][] }): Promise<Result<ScrubReport, DomainError>>; }
export class RotateEncryptionKey { execute(o: { newKeyId: string; dryRun: boolean }, actor: Actor): Promise<Result<{ reencrypted: number }, CryptoError>>; }
export class CheckSecurityPosture { execute(): Promise<Result<PostureReport, DomainError>>; }
export interface PostureReport {
  checks: Array<{ id: string; ok: boolean | 'unknown'; detail: string }>;   // volumeEncrypted, filePerms, bindAddress, cspEnforced,
}                                                                          // auditImmutable, sinksTls, tokenPerms, depsAudited, cryptoMode
```
Config: `security.encryption.mode` (`none | app-aes-gcm | pgcrypto`, default `none` with a boot warning in team mode), `security.encryption.keyEnv` (`ORCH_ENCRYPTION_KEY`, 32 bytes base64), `security.encryption.keyId`, `security.csp.reportUri?`, `security.csp.enforce` (default `true`), `security.headers.hsts` (default on when `publicUrl` is https), `retention.*` (the table above).

### 4.3 Data / schema changes
Migration `0097_hardening`:
- `auth_sessions.refresh_token_enc` (M9-02 reserved it) and `automations.webhook_secret_enc` (M9-07 flagged the misnamed `webhook_secret_hash` — **renamed here** to `_enc`, with a data migration for any rows written in between) become `CipherEnvelope` JSON text columns; a nullable `key_id text` is added next to each for rotation bookkeeping.
- `settings_layers`: add `sensitive integer not null default 0` so a settings key can be marked sensitive and encrypted on write.
- New table `security_scans (id text pk, ts text, kind text, corpus_version text, recall real, fp_rate real, report_json text)` — the scrub-audit history, so a regression is visible over time.
- No change to `audit_log` (deliberately unencrypted; see the rule above).
- New events: `security.scan_completed`, `security.key_rotated`, `security.posture_changed` (extension of `04-domain-model.md` §3 — flag).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
- **Encryption baseline (the decision to write in ADR-017):** volume/disk encryption is the primary control because the daemon's real exposure is a stolen laptop or an unencrypted PV, not a targeted DBA. Column encryption adds value only for the two credential-shaped columns above, and is **not** applied to recordings, messages or audit rows — encrypting those would break search (M5-03/M9-05), replay ranges (M5-01/M9-05 presigned GETs) and offline audit verification (M9-03) while protecting against an attacker who, by then, already has the key that the running daemon must hold. The ADR must state this trade-off plainly rather than claim "encryption at rest" without qualification.
- `CheckSecurityPosture` detects rather than enforces: FileVault via `fdesetup status` on macOS, `lsblk`/`cryptsetup status` or the StorageClass annotation in Kubernetes, `~/.orchestra` 0700 and `token` 0600 (M0-04), bind address, CSP enforcement, audit trigger presence, sink TLS, `pnpm audit` freshness, crypto mode. Results land in the Health screen and `orch doctor` (M6-01) as a new check group, with `unknown` as a legitimate value — guessing would be worse.
- **Scrub harness:** `packages/sdk/fixtures/secrets-corpus/` holds `positives/*.txt` (one file per rule id, with realistic-looking but **fabricated** values, plus split-point metadata) and `near-misses/*.txt` (git SHAs, base64 blobs, UUIDs, long hex strings, ULIDs, an Arabic paragraph, a diff hunk containing `password:` as prose). `ScanSecrets` runs each case through each target's real path — not a mocked one: a real FakeProvider session prints the corpus to a pane (exercising M5-01's `orch-rec`), a real message ingest, a real audit append, a real export, a real metric label and span attribute, a real pino line. `orch audit scan-secrets --corpus <path>` prints the report and writes a `security_scans` row.
- **CSP:** the daemon sets headers on the static web response and on `/`; the web build uses a per-response nonce injected into `index.html` (Vite `build.rollupOptions` emits no inline scripts except the module preload, which gets the nonce). `style-src 'self' 'nonce-…'` — Tailwind 4 emits a stylesheet, not inline styles; any component relying on inline `style` attributes is refactored or allowed via hashes explicitly listed in the docs. `connect-src 'self'` plus the OIDC issuer origin (needed only for the redirect, which is a navigation, not a fetch — verify) and `ws:`/`wss:` same-origin. `img-src 'self' data:` for xterm/asciinema canvases. `frame-ancestors 'none'`. Report-only mode is available via `security.csp.enforce: false` during rollout, with violations logged.
- **Rendering sanitisation review:** markdown (chat, plan cards, review findings), diffs, FTS snippets (M5-03's `<mark>`-only sanitiser), terminal output (xterm handles bytes, but link detection is a risk), and asciinema playback. Each rendering path gets a test feeding it an agent-authored payload containing `<script>`, `javascript:` URLs, `onerror=`, and a data-URL image.
- **NetworkPolicy:** completes M9-06's sample — egress allowed only to the DNS service, the Postgres service, the object store, the IdP, configured SIEM sinks and the OTLP endpoint; ingress only from the ingress controller. Shipped enabled-by-default in `values-kind.yaml` and documented for production.
- No tmux/git behaviour changes; the `childEnv()` allowlist (M0-04) is re-audited as part of the checklist.

### 4.5 API / UI surface
- `GET /security/posture` → `PostureReport` — `@RequirePermission('user.manage')`.
- `POST /security/scan` `{ corpusPath?, targets? }` → `ScrubReport` — Admin; also runnable offline via the CLI so CI can gate on it.
- `POST /security/rotate-key` `{ newKeyId, dryRun }` → Admin, audited, refuses when `mode: none`.
- Health screen: a "Security posture" card listing each check with ok / unknown / failed and a link to the relevant docs section; a "Last secrets scan" row with recall/FP and the corpus version.
- Settings → About: encryption mode and key id (never the key), CSP mode, retention summary.
- CLI: `orch security posture`, `orch security scan-secrets [--corpus P] [--json] [--fail-under 0.99]`, `orch security rotate-key --new-key-id K [--dry-run]`, `orch security sbom-diff --since <tag>`.
- Docs: `docs/security/threat-model.md`, `docs/security/pentest-checklist.md`, `docs/security/encryption.md`, plus `SECURITY.md` updated with the encryption position and the scan numbers.

### 4.6 Flow / sequence
```
orch security scan-secrets
  → load corpus (positives + near-misses, with split points)
  → for each ScrubTarget (10 targets, real paths):
        recording: FakeProvider scenario prints case text (split across writes at splitAt) → orch-rec → .cast read back
        message / tool_args / event / audit / export_bundle / audit_export: ingest → read back from the store
        metrics / span / log: emit → capture from the exposition / in-memory exporter / log sink
     → leaked if the original secret substring survives anywhere in the output
  → scrubReport → security_scans row + security.scan_completed event
  → exit non-zero when recall < --fail-under or fpRate > 0.01   (CI gate)

key rotation
  → RotateEncryptionKey(newKeyId, dryRun)
      dry-run: count rows per sensitive column, verify every envelope decrypts with a known kid
      real: per column, batched: decrypt(old kid) → encrypt(new kid) → update, inside withTx (M9-05)
      → audit 'security.key_rotated' with counts (never the key material)
      → old key must remain available until the run completes; documented in the runbook

CSP rollout
  → security.csp.enforce: false (report-only) → exercise all 13 screens → collect violations
  → fix sources → flip to enforce: true → E2E asserts zero console violations
```

## 5. Tasks
- [ ] Write `ADR-017-encryption-at-rest` (baseline volume encryption; column encryption for the two credential columns; explicit rejection of encrypting recordings/messages/audit with reasons; SQLCipher evaluated; key management and rotation). Merge before code.
- [ ] `CryptoPort` + `NoneCrypto`, `AppAesGcmCrypto` (AES-256-GCM with AAD = `table:column:rowId`), `PgcryptoCrypto`; DI strategy keyed by `security.encryption.mode`.
- [ ] Migration `0097_hardening`: `*_enc` columns + `key_id`, rename `automations.webhook_secret_hash` → `_enc` with data migration, `settings_layers.sensitive`, `security_scans`.
- [ ] `RotateEncryptionKey` use case + `orch security rotate-key` with dry-run, batching and a documented runbook.
- [ ] Build `packages/sdk/fixtures/secrets-corpus/`: ≥ 60 positives across every M5-01 rule id (fabricated values only, with split points) and ≥ 40 near-misses (SHAs, ULIDs, base64, UUIDs, Arabic text, prose containing `password:`).
- [ ] `ScanSecrets` harness with 10 real `ScrubTarget` implementations; `scrubReport` scoring; `orch security scan-secrets --fail-under`; CI job `secrets-scan` gating on recall ≥ 0.99 and FP ≤ 0.01.
- [ ] Fix every leak the first scan finds; add rules or widen carry-over as needed; record the before/after numbers in the step log.
- [ ] Ship retention defaults as `examples/policies/retention.yaml` wired into M5-06's sweeper and M9-03's audit policy; verify the sweeper honours `minKeep` and pinned sessions.
- [ ] `CheckSecurityPosture` + `GET /security/posture` + Health "Security posture" card + `orch doctor` check group + `orch security posture`.
- [ ] CSP + headers: nonce injection in the daemon's static handler, Vite config changes to eliminate inline scripts/styles, `security.csp.*` config, report-only rollout, then enforce.
- [ ] Sanitisation tests for markdown, diffs, FTS snippets, terminal link detection and asciinema playback with hostile agent-authored payloads.
- [ ] NetworkPolicy in the Helm chart (egress allowlist matching the configured hosts), enabled in `values-kind.yaml`, documented for production.
- [ ] SBOM diff tooling (`orch security sbom-diff --since <tag>`) + a milestone dependency review: `pnpm audit` triage with a written note per accepted advisory; confirm `minimumReleaseAge`, `onlyBuiltDependencies` allowlist and lockfile integrity are still as `09-engineering-standards.md` requires.
- [ ] Write `docs/security/threat-model.md` (STRIDE per plane + the M9 surfaces, mitigation → step id, residual risks) and `docs/security/pentest-checklist.md` (≥ 40 executable items with expected results).
- [ ] Update `SECURITY.md` with the encryption position, the measured scrub numbers, the retention defaults and the disclosure process.
- [ ] Review the M9-02 open question (whether to keep refresh tokens at all) and the M9-04 open question (signed approvals) and record the decisions in this step's log and in the ADR.

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-09-01 | unit | `scrubReport` scoring over a synthetic corpus with known tp/fn/fp | exact recall/FP numbers; deterministic; 100 % branches |
| UT-M9-09-02 | unit | `AppAesGcmCrypto` round-trip, wrong AAD, unknown kid, tampered ciphertext | ok / `AadMismatch` / `KeyUnknown` / `DecryptFailed`; no plaintext in any error message |
| UT-M9-09-03 | unit | redactor chunk-boundary: each corpus positive split at every byte position of its secret | zero leaks at any split point |
| AT-M9-09-01 | application | `RotateEncryptionKey` dry-run then real on 1 000 rows; interrupted mid-run and resumed | dry-run writes nothing; real re-encrypts all rows; interruption leaves a mix of kids that still all decrypt; resume completes |
| AT-M9-09-02 | application | `CheckSecurityPosture` with each check failing in turn | the failing check is named; `unknown` is returned where detection is impossible, never a false `ok` |
| IT-M9-09-01 | integration | full `ScanSecrets` across all 10 targets with the shipped corpus | recall ≥ 0.99, FP ≤ 0.01; `perTarget.leaked` empty; a `security_scans` row written |
| IT-M9-09-02 | integration | XSS payload corpus through markdown, diff, FTS snippet, terminal link and asciinema paths | nothing executes; payloads render as text; only `<mark>` survives in snippets |
| IT-M9-09-03 | integration | CSP enforced: load all 13 screens in a headless browser, exercise terminals, replay, charts | zero CSP violations in the console; no `unsafe-inline`/`unsafe-eval` in the header |
| IT-M9-09-04 | integration | NetworkPolicy in kind: attempt egress to a non-allowlisted host from the pod | connection refused/timed out; allowlisted hosts (DB, S3, IdP, OTLP, SIEM) reachable |
| E2E-M9-09-01 | e2e | retention sweep with the shipped defaults on a seeded DB (pinned session, `minKeep` boundaries, audit rows) | pinned session untouched, `minKeep` honoured, audit rows never swept by the generic sweeper, purge audited |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-09-01 | Real-CLI secrets scan | 1. Start a real Claude Code session in the scratch repo. 2. Have it `cat` a file containing the corpus positives and echo a few split across lines. 3. Answer a prompt whose payload includes a JWT. 4. `orch security scan-secrets --json` and grep the `.cast`, the DB and the audit export for the raw values. | Zero raw secrets anywhere; the report shows recall ≥ 0.99 and FP ≤ 0.01; every occurrence shows `[REDACTED:<ruleId>]`; the corpus version and rules version are recorded. | ⬜ |
| TC-M9-09-02 | Negative: near-misses are not destroyed | 1. Include a commit SHA, a ULID, a base64 image blob, an Arabic paragraph and the prose line `the password: field is empty` in agent output and in a chat message. 2. Read the recording and the message back. | None of these are redacted (they are near-misses); the diff/markdown renders normally; the FP rate stays ≤ 0.01. If any is redacted, the rule is tightened and the run repeated. | ⬜ |
| TC-M9-09-03 | Negative: hostile agent output | 1. Use a FakeProvider scenario that emits `<script>alert(1)</script>`, `<img src=x onerror=…>`, a `javascript:` link, a markdown image with a `data:` URL and a 2 MB single-line diff. 2. Open Chat, Review, History search results and Terminals. | Nothing executes; the payloads render as text; the terminal shows the bytes; no CSP violation appears in the console; the UI does not freeze on the large diff. | ⬜ |
| TC-M9-09-04 | Encryption at rest, both modes | 1. With `mode: none`, inspect `auth_sessions` and `automations` in the DB. 2. Switch to `app-aes-gcm` with a key in env, restart, create a new session and automation. 3. Remove the key from env and restart. | Mode `none` stores the values in the clear (and the boot log warns in team mode); mode `app-aes-gcm` stores `CipherEnvelope` JSON with a `kid`; without the key the daemon refuses to start with `KeyMissing` rather than silently failing to decrypt later. | ⬜ |
| TC-M9-09-05 | Key rotation without downtime | 1. With encrypted columns populated, run `orch security rotate-key --new-key-id k2 --dry-run` then for real while a session and an automation are active. 2. Restart the daemon. 3. Log in and fire the automation. | Rotation reports the row counts; the active OIDC session and the automation keep working during and after rotation; the audit log records `security.key_rotated` with counts and no key material. | ⬜ |
| TC-M9-09-06 | Pen-test checklist pass | 1. Work `docs/security/pentest-checklist.md` top to bottom against a local team-mode instance (authz bypass attempts on ≥ 10 routes, WS command authz, MCP tool authz, `/term` input as Viewer, SSRF via the webhook and the OIDC issuer, path traversal in recording/export paths, rate limits, header checks, cookie flags). | Every item has a recorded result; zero critical/high findings open at the end; any accepted finding is written into the threat model's residual-risk section with a rationale. | ⬜ |
| TC-M9-09-07 | Resilience: retention sweep during a pod restart | 1. Configure aggressive retention (recordings 1 d) on a seeded DB with 5 GB of recordings on S3. 2. Start the sweep. 3. `kubectl delete pod` (or `kill -9`) mid-sweep. 4. Restart and re-run the sweep; then `orch audit verify`. | The sweep is resumable and idempotent: no half-deleted recording rows pointing at missing objects, no orphaned objects left unreported (`orch storage vacuum-recordings` lists them), no audit rows swept, and the chain still verifies. | ⬜ |
| TC-M9-09-08 | Dependency and SBOM review | 1. `orch security sbom-diff --since v0.8.0`. 2. `pnpm audit`. 3. Review every added/changed dependency and every advisory. | A written note exists for each added dependency (why it is needed, who maintains it, release age) and each advisory (fix, accept with reason, or defer with a date); `minimumReleaseAge` and the build-script allowlist are confirmed unchanged; the notes go into the step log and `SECURITY.md`. | ⬜ |

## 7. Acceptance criteria (Definition of Done)
- [ ] `ADR-017-encryption-at-rest` merged, linked from `DECISIONS.md`, and implemented: volume encryption documented as the baseline, column encryption available for the listed credential columns, and the reasons for *not* encrypting recordings/messages/audit stated plainly.
- [ ] The M9-02 refresh-token question and the M9-04 signed-approval question are answered in writing (in the ADR and this step's log).
- [ ] Secrets scan across all 10 sinks reaches **recall ≥ 99 %** and **false-positive rate ≤ 1 %** on the shipped corpus, including split-across-chunk cases, and runs as a CI gate (IT-M9-09-01, UT-M9-09-03, TC-M9-09-01/02).
- [ ] Retention defaults are shipped per artifact kind, honour `minKeep` and pinned sessions, never touch audit rows, and are resumable after a crash (E2E-M9-09-01, TC-M9-09-07).
- [ ] CSP is enforced with no `unsafe-inline`/`unsafe-eval` and zero console violations across all 13 screens, and hostile agent-authored content cannot execute anywhere it is rendered (IT-M9-09-02/03, TC-M9-09-03).
- [ ] `docs/security/threat-model.md` covers STRIDE for every plane in `03-architecture.md` plus the M9 surfaces, maps each mitigation to a step id, and lists residual risks explicitly.
- [ ] `docs/security/pentest-checklist.md` has ≥ 40 executable items, has been run once end to end, and leaves zero open critical/high findings (TC-M9-09-06).
- [ ] Key rotation works on a live instance without downtime and without key material reaching logs or audit rows (TC-M9-09-05).
- [ ] SBOM diff and dependency advisories reviewed with a written note each; supply-chain settings from `09-engineering-standards.md` re-confirmed (TC-M9-09-08).
- [ ] All TC-M9-09-* pass and are recorded; no new lint/arch violations; `SECURITY.md` updated; `PROGRESS.md` updated.

## 8. Risks / open questions
- **"Encryption at rest" is easy to oversell.** A daemon that must decrypt on every read holds the key; column encryption stops an offline disk reader and a careless backup, not a live host compromise. The ADR and `SECURITY.md` must say exactly that, or the claim becomes a liability the moment someone tests it.
- A 99 % recall target is a number chosen without data. The first full scan may reveal that some rules (notably `generic-kv` and `jwt`) trade recall against a false-positive rate that damages readability of recordings. If so, the right answer may be a lower FP target with a documented recall for the high-value rules only — decide with the first scan's numbers, and record the decision rather than quietly moving the goalposts (verify).
- The corpus must contain **fabricated** values only. A real key committed to the repo as a test fixture would be an incident caused by the very step meant to prevent one; the CI job must also run a secret scanner over the corpus directory itself to prove the values are synthetic-shaped but inert.
- CSP against xterm.js, asciinema-player and Tailwind 4 may need hashes for a small number of inline styles. Every exception weakens the policy and must be listed in the docs with a reason; if the list grows past a handful, prefer refactoring the component (verify during the report-only rollout).
- Encrypting `settings_layers.value_json` selectively means search and diff views (M8-01's "diff view") cannot show those values. Confirm the settings UI degrades readably ("value hidden — sensitive") rather than showing ciphertext (verify).
- The threat model will expose gaps this milestone cannot close (agent sandboxing, MCP tool abuse by a compromised Lead, supply-chain attacks on the vendor CLIs themselves). Listing them honestly as residual risk is the deliverable; resisting the urge to quietly expand scope is part of the step.
- `security_scans` and the `security.*` event namespace are not in `04-domain-model.md` — the domain model doc needs an update (not done here), consistent with the flags raised by M9-01 through M9-07.
- Renaming `automations.webhook_secret_hash` to `_enc` touches a table shipped one step earlier in the same milestone; if M9-07 is implemented after this step in a different order, coordinate so the column is created correctly the first time (already flagged as an open question in M9-07).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
