# Milestone 9 — Enterprise

| Field | Value |
|---|---|
| Steps | 9 (M9-01 … M9-09) |
| Effort | 21 working days (sum of estimates) |
| Status | ⬜ |

## Goal

After M9 a trusted shared team can run one `orchestrad` under a shared OS/credential context (ADR-019; RBAC does not isolate execution): users sign in through the organisation's identity provider, each user sees and controls only what their role allows, every mutating action lands in a hash-chained audit log that a security reviewer can verify and export to a SIEM, risky work (high-risk tasks, infra/migration/release task types, merges to protected branches) waits for a second pair of eyes, storage moves from the laptop's SQLite file to Postgres + S3 through dialect-specific migrations, verified data transfer and repository contracts, and the whole daemon ships as a non-root container with a Helm chart, health probes, Prometheus metrics and OTel traces. Missions can also start on a schedule or a git push instead of a click. Nothing built in M0–M8 is rewritten: single-user mode keeps working unchanged (implicit Admin, SQLite, local token), and every enterprise feature sits behind `auth.mode: team`, `storage.driver: postgres` and `features.*` flags (D8, D9).

## Why this milestone now

- The **team lead** and **team member** personas (`00-foundations/01-vision-scope.md`) are the only ones still unserved after M8; their needs are exactly RBAC, approval gates, audit, and per-user defaults (the last one landed in M8-01).
- M8-01's layered settings (`settings_layers`) are the attachment point for policies that gates and roles read; building RBAC before M8 would have meant a second policy mechanism.
- M7-04 made the auth module "OIDC-ready" and M5-06 shipped retention/redaction primitives; M9 completes both instead of inventing parallel ones.
- D8 states that enterprise is "a driver swap". M9-05 is where that claim is proven with parity tests, before M10 freezes the 1.0 storage contract.
- Compliance rule C10 (every spend/keys action previewed, permissioned, audited) has been partially satisfied by the M0-04 audit interceptor; RBAC guards and the immutable chain finish it.

## Entry criteria

- M8-01 ✅ — `settings_layers` table, precedence engine, policy file loader.
- M7-04 ✅ — auth module with strategy registration points and local-token rotation.
- M5-06 ✅ — retention TTL job, manual redaction, export/import bundles.
- M3-04 ✅ and M3-06 ✅ — review rounds and PR/merge flow (gate insertion points for M9-04).
- M3-02 ✅ — `PlanMission` use case (automations create missions through it).
- M0-05 ✅ — event store and repositories on Kysely; migrations run through one runner.
- Dev machine: Docker ≥ 24 (present per `ENVIRONMENT.md`), `kind` or `k3d`, `helm` ≥ 3.14, `kubectl` (install before M9-06).
- Scratch repo `~/orchestra-scratch/` exists (M1-03) and has a remote you can push to (for M9-07 webhooks).

## Exit criteria (all measurable)

1. **Two users, different permissions.** Two browser profiles log in via OIDC as `alice` (group → Lead) and `bob` (group → Viewer). Bob's attempt to start a session and to answer Alice's prompt each return HTTP 403 / WS `forbidden` and produce an `audit_log` row with `outcome = denied`. Alice's attempts succeed. An Admin changes Bob's role in Settings → Users; Bob's next request (without re-login) is authorised as Member.
2. **Audit export passes review.** `orch audit verify` reports `ok` on a log of ≥ 10 000 entries that includes one retention purge; a single tampered row (written with the maintenance flag) is reported with its `seq`. `orch audit export --format jsonl` output validates against `audit-export.schema.json` and contains zero matches from the secrets corpus (M9-09). A syslog (RFC 5424 over TLS) and a webhook sink each receive 100 % of entries in an integration test.
3. **Helm deploy green.** `helm install` into a kind cluster with Postgres, MinIO and an OIDC test IdP becomes `Ready` within 120 s; a FakeProvider session starts; `kubectl delete pod` → daemon back to `Ready`, session marked `crashed`, zero open prompts lost (M5-05 semantics). CI job `helm-smoke` is green on `main`.
4. **Postgres parity.** Migration parity suite green on SQLite and Postgres; repository contract suite green on both; `orch storage migrate` moves a seeded SQLite DB with equal row counts per table and a valid audit chain afterwards.
5. **4-eyes.** A task with `risk: high` blocks in state `blocked/awaiting_approval` until a second approver decides; the requester's own approval is rejected with `FourEyesViolation`; an unanswered gate escalates after its timeout and both events are audited.
6. **Automations.** A cron automation creates a mission on schedule; a git push webhook creates one per commit and a duplicate delivery is `skipped` with `dedupe_key` shown in run history.
7. **Observability.** Prometheus scrapes `/metrics`; the shipped Grafana dashboard renders sessions, open prompts, window usage and reroutes from a FakeProvider run; the `AuditChainBroken` alert fires in a test.
8. **Hardening.** Threat model and pen-test checklist reviewed and signed off in the step log; secrets corpus recall ≥ 99 % and false-positive rate ≤ 1 %; CSP enforced with zero console violations across all 13 screens; SBOM diff reviewed for the milestone.
9. **No regression.** All M0–M8 E2E suites green in single-user mode with `auth.mode: local` (implicit Admin), SQLite and filesystem recordings.

## Steps

| ID | Step file | Title | Effort | Depends on |
|---|---|---|---|---|
| M9-01 | [step-01](step-01-rbac.md) | RBAC | 3 d | M8-01 |
| M9-02 | [step-02](step-02-oidc.md) | OIDC | 2 d | M9-01, M7-04 |
| M9-03 | [step-03](step-03-immutable-audit-log-and-siem-export.md) | Immutable audit log & SIEM export | 2 d | M9-01 |
| M9-04 | [step-04](step-04-approval-gates-4-eyes.md) | Approval gates (4-eyes) | 2 d | M9-01, M3-04 |
| M9-05 | [step-05](step-05-postgres-s3-drivers.md) | Postgres + S3 drivers | 3 d | M0-05, M5-06, M9-04 |
| M9-06 | [step-06](step-06-container-and-helm.md) | Container & Helm | 2.5 d | M9-05 |
| M9-07 | [step-07](step-07-automations.md) | Automations | 2.5 d | M3-02, M4-04, M9-01, M9-04 |
| M9-08 | [step-08](step-08-observability.md) | Observability | 2 d | M0-04, M9-03 |
| M9-09 | [step-09](step-09-security-hardening.md) | Security hardening | 2 d | M9-03, M9-02 |

## What you can test after this milestone

- Log in as two different people from two browser profiles and watch permissions differ per action, per screen and per WS topic.
- Break the audit chain on purpose and see `orch audit verify`, the Health screen and a Prometheus alert all report it.
- Switch `storage.driver` from `sqlite` to `postgres` and recordings from `fs` to `s3`, migrate, and replay an old session from S3 through a presigned URL.
- Run the daemon in Kubernetes, kill the pod, and confirm sessions are reconciled and prompts restored.
- Let a cron or a `git push` start a mission for you and have a Lead approve the risky part.
- Point Grafana at the daemon and see the G2/G6 KPIs as time series.

## Demo script

Preconditions: M8 demo passes; Docker running; `kind`, `helm`, `kubectl` installed; two browser profiles ("A" and "B") plus a third for Admin ("C"); scratch repo with a remote.

1. `docker compose -f deploy/compose/team.yaml up -d` — starts Postgres 16, MinIO and Dex (test OIDC IdP with users `alice`/`bob`/`carol` and groups `orchestra-leads`, `orchestra-viewers`, `orchestra-admins`). (verify: compose file path lives in `deploy/`, see M9-06 risk on repo layout.)
2. Edit `~/.orchestra/config.yaml`: `auth.mode: team`, `auth.oidc.issuer: http://localhost:5556/dex`, `storage.driver: postgres`, `storage.recordings.driver: s3`; secrets via env (`ORCH_PG_URL`, `ORCH_S3_ACCESS_KEY`, `ORCH_OIDC_CLIENT_SECRET`).
3. `orch storage migrate --from sqlite --to postgres --recordings fs:s3` — watch per-table progress; final line prints row counts and `audit chain: ok`.
4. Start the daemon (`pnpm dev:daemon`). Profile A → `http://localhost:4300` → redirected to Dex → log in as `alice` → lands on Attention as **Lead**. Profile B → `bob` → **Viewer**. Profile C → `carol` → **Admin**.
5. A: Fleet → Start session (FakeProvider, scenario `prompts-all-kinds`). B: sees the session in Fleet and Terminals (read-only, no input); tries to Approve the open prompt → toast "Forbidden: prompt.answer"; C: Settings → Audit shows the denied row.
6. A: Quick Delegate an `infra` task on the scratch repo → Attention shows an **Approval gate** card with reasons `task_type=infra`, `4-eyes`. A clicks Approve → error "Requester cannot approve (4-eyes)". C approves → task runs.
7. Terminal: `orch audit verify` → `ok (n=…, head=…)`. `orch audit export --format jsonl --since 1h | jq .action | sort | uniq -c`. Tamper: `psql $ORCH_PG_URL -c "set orchestra.audit_maintenance='on'; update audit_log set action='x' where seq=(select max(seq)-3 from audit_log)"` → `orch audit verify` → `BROKEN at seq …`; Health screen shows the case; Prometheus `orchestra_audit_chain_ok` = 0.
8. C: Settings → Automations → New: cron `*/2 * * * *`, playbook `bugfix`, repo scratch, budget 1 window-hour. Wait two minutes → run appears, mission created. Add a second automation with trigger `git_push`; `git push` twice with the same commit → second run `skipped (dedupe)`.
9. Open Grafana (`http://localhost:3000`, dashboard "Orchestra overview") → sessions, open prompts, window usage, reroutes. Trigger the `AuditChainBroken` alert from step 7.
10. `docker build -t orchestra:dev -f deploy/docker/Dockerfile .` → `kind create cluster` → `helm install orchestra deploy/helm/orchestra -f deploy/helm/values-kind.yaml` → `kubectl wait --for=condition=Ready pod -l app=orchestra --timeout=120s` → `kubectl port-forward svc/orchestra 4300:4300` → log in as `alice`, start a FakeProvider session → `kubectl delete pod -l app=orchestra` → pod returns Ready; session shows `crashed`; the prompt that was open is still in Attention with the restored badge.
11. `orch audit scan-secrets --corpus packages/sdk/fixtures/secrets-corpus` → recall/FP report; open DevTools on each screen → zero CSP violations.
12. Switch `auth.mode: local`, `storage.driver: sqlite`; run `pnpm e2e` → all M0–M8 suites green.

## Milestone risks

| Risk | Impact | Mitigation |
|---|---|---|
| Permission checks miss a route/WS command/MCP tool | privilege escalation | M9-01 adds an architecture test that enumerates every mutating handler and asserts a `@RequirePermission` decorator; CI fails on unguarded handlers |
| Audit immutability vs retention purge conflict | either unbounded growth or a mutable log | anchors + maintenance flag inside one transaction (M9-03); purge itself is audited |
| Postgres behaves differently from SQLite (FTS, triggers, JSON) | features silently broken in team mode | `SearchPort` and dialect-scoped migration helpers (M9-05); parity suite runs on both in CI |
| tmux inside a container loses sessions on pod restart | agents killed on every deploy | documented as a property of container mode; `Recreate` strategy, graceful pre-stop, restore semantics from M5-05 (M9-06) |
| User-configured egress (SIEM, OTLP, S3, IdP) collides with the `no-vendor-endpoints` rule | CI blocks legitimate egress or the rule is weakened | one allowlisted `infrastructure/egress` module with config-driven hosts; ESLint rule unchanged; ADR proposed (see inconsistencies in the step files) |
| Solo bandwidth (R16) | milestone slips | three parallel lanes below; M9-07 and M9-08 are deferrable to M10 without blocking 1.0 DoD |
| `deploy/` folder not in `11-repo-layout.md` | layout drift | M9-06 proposes the folder and asks for a layout doc update (not done here) |

## Parallelization notes

- **Lane A (auth/governance):** M9-01 (3 d) → { M9-02, M9-03, M9-04 } in parallel (2 d each, three agents) → M9-09 (2 d, after M9-03). Critical path 7 d.
- **Lane B (storage/deploy):** M9-05 (3 d) → M9-06 (2.5 d). Independent of Lane A except that M9-06 Helm values need the config keys from M9-02 (`auth.oidc.*`) — agree on the config schema on day 1 of the milestone and freeze it in `apps/daemon/src/interface/config/schema.ts`.
- **Lane C (platform):** M9-07 (2.5 d) and M9-08 (2 d) can start on day 1; M9-07 must be re-checked against M9-01 guards and M9-04 gates once those land (one half-day integration task listed in M9-07).
- Serial effort 21 d; with three lanes ≈ 9–10 calendar days plus a 1-day milestone acceptance pass running the demo script above.
- Shared touch points to coordinate: `config.yaml` schema (M9-02, M9-05, M9-06, M9-08), `audit_log` schema (M9-03 writes it, M9-01/M9-04/M9-07 emit into it), `apps/daemon/src/infrastructure/egress/` allowlist (M9-02, M9-03, M9-05, M9-08).

## Revised release boundary (2026-09-15)
Complete every required step above and its regression scenarios; optional gated steps do not block the milestone. [DEPENDENCIES.md](../DEPENDENCIES.md) gives the actual order. Capability-specific provider evidence, explicit recovery outcomes and commit-bound validation govern the exit criteria; no live result is implied by this plan update.
