# Step M9-06 — Container & Helm

| Field | Value |
|---|---|
| Milestone | M9 — Enterprise |
| Status | ⬜ Not started |
| Depends on | M9-05 |
| Estimated effort | 2.5 days |
| Packages touched | `deploy/docker` (new), `deploy/helm/orchestra` (new), `deploy/compose`, `apps/daemon` (`src/interface/http/health`, `src/interface/config`, shutdown hooks), `.github/workflows` (`release.yml`, new `helm-smoke.yml`), `docs/deployment` |
| Risk | High (tmux inside a container changes the session-survival promise of D2) |
| Owner | |

## 1. Goal
Orchestra ships as one OCI image and one Helm chart. `docker build -f deploy/docker/Dockerfile .` produces a ~300 MB image running Node 22 with `tmux`, `git` and `openssh-client` as a non-root user; `helm install orchestra deploy/helm/orchestra -f values-kind.yaml` brings up a daemon that is `Ready` within 120 s against Postgres, S3/MinIO and an OIDC issuer, with liveness/readiness/startup probes, a PVC for worktrees and staged recordings, a read-only root filesystem, resource limits, and an ingress. Vendor CLIs are **not** bundled — the operator mounts or installs them, and the chart documents why (licensing and C1). Killing the pod brings the daemon back `Ready`, marks the killed sessions `crashed`, and loses zero open prompts (M5-05 semantics).

## 2. Why
- Source plan §17 lists "single container / Helm" as an enterprise pillar; the README's exit criterion 3 makes it measurable.
- D8: after M9-05 the state lives in Postgres and S3, so the daemon is finally close enough to stateless for a container to make sense. Before M9-05 a container would have meant a database on a PVC and a single point of data loss.
- D2 says tmux + worktrees are the substrate and that sessions survive daemon death. In a container that promise is **narrower**: the tmux server dies with the pod. This step's job is to make that limitation explicit, bounded, and safe (graceful pre-stop + restore), rather than to pretend it away.
- C1 / C4: the image must not bundle vendor CLIs — redistributing them is neither licensed nor "the user's own official binary launched per vendor docs", and bundled binaries would break the `BinaryRegistry` version story (M1-04).
- C9: CI builds and smoke-tests the chart with `FakeProvider` only; no vendor credentials ever enter the cluster.
- M9-08 needs a stable place to expose `/metrics` and a ServiceMonitor; M9-02 needs a public URL for the OIDC redirect — both are chart values.

## 3. Scope
### In scope
- `deploy/docker/Dockerfile`: multi-stage (pnpm build → distroless-ish runtime on `node:22-bookworm-slim`), non-root `orchestra` user (uid 10001), `tmux`, `git`, `openssh-client`, `ca-certificates`, tini as PID 1.
- Image labels (OCI), SBOM (CycloneDX) and cosign signing wired into `release.yml`, matching the supply-chain controls in `07-compliance-rules.md`.
- `deploy/helm/orchestra`: Deployment (`strategy: Recreate`), Service, Ingress, PVC, ConfigMap, Secret refs, ServiceAccount, probes, securityContext, resources, optional bundled Postgres/MinIO subcharts for evaluation only.
- Health endpoints split: `/health` (liveness, cheap), `/health/ready` (readiness: DB, migrations, object store, OIDC discovery), `/health/startup` (startup probe during migrations).
- Graceful shutdown: SIGTERM → stop accepting new sessions → flush audit spool and recording uploads → mark sessions `crashed` with a reason → close DB → exit; `preStop` hook + `terminationGracePeriodSeconds`.
- Vendor CLI mounting: documented patterns (initContainer that installs into an emptyDir, a sidecar-free `hostPath`/PVC mount, or a derived image built by the operator) plus a `values.providers.binaries` mapping consumed by the `BinaryRegistry` allowlist (M1-04).
- Single-container evaluation mode (`values.mode: single`): SQLite on the PVC, filesystem recordings, local token auth — for a demo, explicitly not recommended for teams.
- `helm-smoke` CI job on `kind`: install, wait Ready, run a FakeProvider session, delete the pod, assert recovery.
- `docs/deployment/kubernetes.md` + `docs/deployment/docker.md`.
### Out of scope (deferred to …)
- Kubernetes **Operator**/CRDs, multi-replica HA, leader election — not planned for 1.0; the daemon is single-instance by design (M0-04 lock, M9-03 `seq` serialisation).
- Running vendor CLIs in separate pods or a remote executor — deferred to M10 backlog; M7-05 multi-host is the supported way to place agents elsewhere.
- Windows/macOS containers — not planned; the image is linux/amd64 + linux/arm64.
- Production-grade Postgres/MinIO operation — the subcharts are evaluation only; the docs point at the cloud/managed options and M9-05's backup guidance.
- Network policies and PodSecurityPolicy/Kyverno rules — a sample `networkpolicy.yaml` is shipped commented-out; hardening is M9-09.
- Autoscaling — meaningless for a single-instance daemon.

## 4. Design
### 4.1 Domain (entities, value objects, rules)
No new domain types. Two operational rules are introduced and must be documented in the chart's NOTES.txt:
- **R-C1 Sessions do not outlive the pod.** In container mode the tmux server runs inside the daemon's container, so a pod restart kills every agent. On restart the supervisor reconciles (M1-02) and marks previously running sessions `crashed` with `reason: 'host_restarted'`; open prompts are preserved (M5-05) and shown with a "restored" badge. `features.container: true` makes the UI say this plainly in the Fleet screen instead of showing an unexplained crash.
- **R-C2 Worktrees are pod-local.** `git worktree` needs a real filesystem, so worktrees live on the PVC. Uncommitted work survives only according to the storage class, backing volume, topology and reclaim/lifecycle policy. ReadWriteOnce constrains mount access; it does not imply same-node persistence. Document and test rescheduling for the selected storage class, and distinguish volume loss from process loss. The chart therefore defaults to a PVC and refuses `emptyDir` unless `values.persistence.acceptDataLoss: true`.

### 4.2 Interfaces / contracts
```ts
// apps/daemon/src/interface/http/health/health.controller.ts
export interface HealthReport  { status: 'ok'; version: string; hostId: string; uptimeSec: number }           // GET /health      (liveness)
export interface ReadyReport   {                                                                               // GET /health/ready
  ready: boolean;
  checks: Array<{ name: 'db' | 'migrations' | 'objectStore' | 'oidc' | 'tmux' | 'recordingUploads'; ok: boolean; detail?: string; latencyMs?: number }>;
}
export interface StartupReport { started: boolean; phase: 'config' | 'migrations' | 'supervisor' | 'ready' }   // GET /health/startup

// apps/daemon/src/application/lifecycle/graceful-shutdown.ts  (one use case)
export class ShutdownDaemon {
  execute(o: { deadlineMs: number; reason: string }): Promise<Result<ShutdownReport, DomainError>>;
}
export interface ShutdownReport { sessionsMarkedCrashed: number; auditSpoolFlushed: number; recordingSegmentsUploaded: number; promptsPreserved: number; tookMs: number }
```
Config additions (Zod): `server.publicUrl` (required when `auth.oidc` is enabled — the redirect URI base), `features.container: boolean` (set by the chart), `runtime.shutdownGraceMs` (default `25000`, must be < `terminationGracePeriodSeconds`), `storage.recordings.localStageDir` (defaults into the PVC in container mode).

### 4.3 Data / schema changes
None. Two behaviours are wired to existing columns:
- `sessions.exit_code` / state set to `crashed` with `state_reason: 'host_restarted'` during reconcile when `features.container` is true (the column exists from M1-02's crash handling).
- `events`: reuse `session.crashed` and add `host.shutdown` / `host.started` payload fields `{ reason, graceful: boolean, version }` (extension of the `provider.*`/`session.*` catalog in `04-domain-model.md` §3 — flag).

### 4.4 Infrastructure (tmux, git, fs, network, external processes)
**Dockerfile outline** (`deploy/docker/Dockerfile`):
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/*/package.json apps/ ; COPY packages/*/package.json packages/     # (expanded properly in the real file)
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts=false   # better-sqlite3/node-pty need builds

FROM deps AS build
COPY . .
RUN pnpm turbo run build --filter=orchestrad... --filter=@orchestra/web...
RUN pnpm deploy --filter=orchestrad --prod /out && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 orchestra && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin orchestra
COPY --from=build --chown=10001:10001 /out /app
ENV NODE_ENV=production ORCH_HOME=/data HOME=/data
WORKDIR /app
USER 10001:10001
EXPOSE 4300
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini","--","node","/app/dist/main.js"]
```
- **No vendor CLIs.** A build-time assertion (`tools/scripts/assert-no-vendor-binaries.sh`, run in `release.yml`) greps the final image layers for `claude`, `codex`, `agy`, `kimi`, `opencode` executables and fails the build if any is present (C1/C4 as a CI gate, not a promise).
- Multi-arch: `linux/amd64` + `linux/arm64` via buildx; native modules (`better-sqlite3`, `node-pty` 1.1.0) must have prebuilds for both or the build stage compiles them (adds build-essential to the `deps` stage only, never to runtime).
- **tmux in a container:** the tmux server is started by the daemon on demand (`tmux -f /app/tmux.conf new-session -d -s orchestra`), socket in `/data/tmux` (not `/tmp`, so it is on the PVC and predictable). `TERM=xterm-256color`; `/app/tmux.conf` sets `set -g history-limit 10000`, `set -g destroy-unattached off`, `set -g exit-empty off` so the server does not vanish when the last pane exits. Requires `/data` to be writable by uid 10001 → `fsGroup: 10001` in the pod security context.
- **Read-only root filesystem:** `readOnlyRootFilesystem: true` with `emptyDir` mounts for `/tmp` and `/home/orchestra/.cache`; `/data` is the PVC. `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `seccompProfile: RuntimeDefault`, `runAsNonRoot: true`.
- **Vendor CLI mounting patterns** (documented, with a values switch):

| Pattern | values | How | Notes |
|---|---|---|---|
| Derived image | `image.repository: myorg/orchestra-with-clis` | operator's Dockerfile `FROM ghcr.io/…/orchestra:<v>` + their own CLI install | recommended; keeps our image clean of third-party licences |
| initContainer install | `providers.install.enabled: true` | initContainer runs the operator's script into a shared `emptyDir` mounted at `/opt/clis` | needs network egress at pod start |
| Volume mount | `providers.binariesVolume` | PVC/hostPath containing already-installed CLIs | air-gapped friendly |

In all three, `values.providers.binaries` maps `providerId → absolute path` and is rendered into `config.yaml`'s `BinaryRegistry` allowlist; the daemon still verifies the version range at boot (M1-04), so a wrong mount shows as an unhealthy provider in Fleet rather than a crash.
- **Vendor login inside the cluster** is the operator's problem and must be documented honestly: each CLI's official login flow must be completed in a way that persists into `/data` (e.g. `kubectl exec -it … -- claude login` once, with the CLI's config dir on the PVC). Orchestra never automates or proxies that (C3).
- **Graceful shutdown:** `terminationGracePeriodSeconds: 45`; `preStop: exec ["/app/bin/orch","daemon","drain","--timeout","25s"]` → `ShutdownDaemon` stops accepting new sessions, flushes the M9-03 audit spool, finishes in-flight recording uploads (M9-05), marks sessions `crashed`, closes the pool. SIGKILL after the grace period is survivable because every one of those steps is also idempotent on restart.
- **Probes:**

| Probe | Path | initialDelay | period | failureThreshold | Notes |
|---|---|---|---|---|---|
| startup | `/health/startup` | 5 s | 5 s | 60 | covers long migrations (5 min budget) |
| liveness | `/health` | — | 10 s | 3 | must not touch the DB (a DB outage is not a reason to kill the pod — TC-M9-05-05) |
| readiness | `/health/ready` | — | 5 s | 2 | DB, migrations, object store, OIDC discovery, tmux server |

**Helm values** (`deploy/helm/orchestra/values.yaml`, abridged):
```yaml
mode: team                       # team | single
image: { repository: ghcr.io/<org>/orchestra, tag: "", pullPolicy: IfNotPresent }
replicaCount: 1                  # >1 is refused by a chart assertion (single-instance daemon)
strategy: Recreate
server: { port: 4300, publicUrl: "https://orchestra.example.com" }
persistence:
  enabled: true
  size: 50Gi                     # worktrees + staged recordings + logs
  storageClass: ""
  accessMode: ReadWriteOnce
  acceptDataLoss: false
postgres:
  enabled: false                 # true installs the evaluation subchart
  urlSecret: { name: orchestra-db, key: url }
s3:
  enabled: true
  endpoint: "", region: us-east-1, bucket: orchestra-recordings, forcePathStyle: false
  credentialsSecret: { name: orchestra-s3, accessKeyKey: access-key, secretKeyKey: secret-key }
oidc:
  enabled: true
  issuer: "", clientId: orchestra
  clientSecretSecret: { name: orchestra-oidc, key: client-secret }
  roleMapping: { allowAdminFromIdp: false, entries: [] }
audit: { sinks: [] }
observability: { metrics: { enabled: true, serviceMonitor: false }, otlp: { endpoint: "" } }   # M9-08
providers:
  binaries: {}                   # claude: /opt/clis/bin/claude
  install: { enabled: false, image: "", script: "" }
ingress:
  enabled: false
  className: nginx
  annotations: { nginx.ingress.kubernetes.io/proxy-read-timeout: "3600" }   # WS terminals
  tls: []
resources: { requests: { cpu: 500m, memory: 1Gi }, limits: { cpu: "2", memory: 4Gi } }
podSecurityContext: { runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: { type: RuntimeDefault } }
containerSecurityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
```
Chart assertions (`fail` in `_helpers.tpl`): `replicaCount > 1` ⇒ fail; `mode: team` with `postgres.urlSecret` empty and `postgres.enabled: false` ⇒ fail; `oidc.enabled` with an empty `server.publicUrl` ⇒ fail; `persistence.enabled: false` with `acceptDataLoss: false` ⇒ fail.
- **Ingress:** WebSocket support is mandatory (`/ws` and `/term`); the chart's default annotations set long read timeouts and disable buffering. TLS termination at the ingress; the daemon still binds `0.0.0.0` *inside the pod only* — a deviation from `03-architecture.md` §7 ("binds 127.0.0.1 only") that is only acceptable because the pod network is the boundary. This is called out in the docs and guarded by `features.container` (the daemon refuses `bind: 0.0.0.0` unless `features.container` is true).

### 4.5 API / UI surface
- New: `GET /health/ready`, `GET /health/startup` (public, no auth, no secrets in the body — check names and booleans only).
- `orch daemon drain --timeout <d>` (CLI, used by `preStop` and by operators before maintenance).
- Fleet screen: a "Container mode" notice explaining R-C1 when `features.container` is true, and per-provider rows showing the mounted binary path and detected version (or "not mounted — see deployment docs").
- Settings → About: image tag, chart version, Kubernetes namespace/pod name (from the downward API), storage drivers.
- No new permissions; `/health*` stays public (already in M9-01's allowlist file).

### 4.6 Flow / sequence
```
helm install
  → ConfigMap(config.yaml from values) + Secrets(pg url, s3 keys, oidc secret, audit sink secrets)
  → PVC bound → Pod starts (uid 10001, fsGroup 10001, read-only root, /data writable)
  → entrypoint tini → node main.js
      loadConfig (fail fast) → /health/startup {phase:'config'}
      runMigrations (single-instance lock)  → {phase:'migrations'}
      start tmux server on /data/tmux/orchestra.sock → supervisor reconcile → {phase:'supervisor'}
      listen :4300 → /health/startup {started:true} → readiness starts passing
  → Service + Ingress route /, /ws, /term

kubectl delete pod
  → SIGTERM → preStop `orch daemon drain --timeout 25s`
      stop admitting sessions → flush audit spool → finish recording uploads
      mark running sessions crashed(reason='host_restarted') → close pool → exit 0
  → new Pod (Recreate ⇒ old volume released first) → boot as above
      reconcile finds no tmux panes → sessions already crashed → open prompts re-derived (M5-05)
      Fleet shows "restored" badge; Attention still holds every prompt that was open
```

### 4.7 Review reconciliation contract (2026-09-15)
Pod replacement terminates its agent processes even when worktree data persists. Old prompts remain historical records with cancelled/session-gone or delivery-uncertain outcomes; they are not advertised as answerable. Use one active supervisor per namespace and fencing during rescheduling. Document local-PV node affinity versus network-backed storage and run restoration tests with explicit PVC lifecycle settings.

## 5. Tasks
- [ ] `deploy/docker/Dockerfile` (multi-stage, non-root, tini, tmux/git/ssh) + `.dockerignore`; build for amd64 and arm64 with buildx.
- [ ] `tools/scripts/assert-no-vendor-binaries.sh` + a CI step that fails the build if a vendor CLI is present in the image.
- [ ] Image labels (OCI source/revision/licenses), CycloneDX SBOM generation, cosign signing, and publish to GHCR in `release.yml`.
- [ ] Split health endpoints: `/health` (no DB), `/health/ready` (db, migrations, objectStore, oidc, tmux, recordingUploads), `/health/startup` with phases.
- [ ] `ShutdownDaemon` use case + `orch daemon drain`; wire SIGTERM, `preStop`, and `runtime.shutdownGraceMs`; make every drain step idempotent.
- [ ] `features.container` flag: allow `bind: 0.0.0.0` only under it; Fleet notice; reconcile reason `host_restarted`.
- [ ] tmux-in-container config: socket under `/data/tmux`, `/app/tmux.conf`, `exit-empty off`, `destroy-unattached off`, `TERM` handling; verify control mode (`-CC`) works with the packaged tmux version and pin it in `BinaryRegistry`.
- [ ] Helm chart skeleton: Deployment, Service, Ingress, PVC, ConfigMap, Secrets, ServiceAccount, NOTES.txt, `_helpers.tpl` with the four assertions.
- [ ] Values for Postgres/S3/OIDC/audit sinks/observability/providers/ingress/resources/security contexts; `values-kind.yaml` and `values-single.yaml` examples.
- [ ] Evaluation subcharts (`postgresql`, `minio`) behind `postgres.enabled` / `s3.enabled` with a NOTES warning that they are not production storage.
- [ ] Vendor-CLI mounting: `providers.binaries` rendering, optional initContainer, docs for all three patterns plus the one-time `claude login` procedure.
- [ ] `helm-smoke.yml` CI job: kind cluster, build image, `helm install` with FakeProvider, wait Ready, run a scripted session, `kubectl delete pod`, assert Ready + zero lost prompts.
- [ ] `helm lint`, `helm template` golden-output tests, and `kubeconform` schema validation in CI.
- [ ] Commented-out `networkpolicy.yaml` sample (egress to DB, S3, IdP, SIEM, OTLP only) for M9-09 to finish.
- [ ] Docs `docs/deployment/docker.md` and `docs/deployment/kubernetes.md` (R-C1/R-C2 stated up front, sizing, upgrade procedure, backup pointer to M9-05, troubleshooting table).
- [ ] Propose the `deploy/` folder addition to `11-repo-layout.md` (do not edit that doc here — record it in the milestone log).

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M9-06-01 | unit | `ShutdownDaemon` with a slow upload and a short deadline | returns within the deadline, reports what was flushed vs pending, never throws |
| UT-M9-06-02 | unit | readiness report assembly with each dependency failing in turn | `ready:false` with exactly the failing check named; no secret values in the body |
| AT-M9-06-01 | application | `bind: 0.0.0.0` without `features.container` | boot refused with a config error; allowed with the flag |
| IT-M9-06-01 | integration | `docker build` then run the image with compose (Postgres+MinIO+Dex), start a FakeProvider session | session runs in tmux inside the container; recording uploads to MinIO; login via Dex works |
| IT-M9-06-02 | integration | image content assertion | no vendor CLI binary present; runs as uid 10001; root filesystem read-only except `/data`, `/tmp` |
| IT-M9-06-03 | integration | `helm lint` + `helm template` golden output + `kubeconform` for default, kind and single-mode values | schema-valid manifests; assertions fire for `replicaCount: 2`, missing `publicUrl`, disabled persistence |
| IT-M9-06-04 | integration | kind: install chart, wait Ready ≤ 120 s, run a FakeProvider session, `kubectl delete pod`, wait Ready again | pod returns Ready; sessions marked `crashed(host_restarted)`; open prompts count before == after |
| IT-M9-06-05 | integration | SIGTERM during an active recording upload and an unflushed audit spool | drain finishes both within the grace period; after restart `orch audit verify` ok and no staged segment is orphaned |
| E2E-M9-06-01 | e2e | Playwright against the kind deployment through the ingress: log in via Dex, open Terminals, watch a FakeProvider pane, answer a prompt | WS through ingress works (xterm renders, prompt answered); no mixed-content or CSP errors |

### 6.2 Manual test cases (run by you before marking ✅)
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M9-06-01 | Build and inspect the image | 1. `docker build -t orchestra:dev -f deploy/docker/Dockerfile .`. 2. `docker run --rm orchestra:dev id` and `... sh -c 'command -v tmux git claude codex'`. 3. `docker image inspect` / `dive` for size and layers. | Runs as uid 10001; `tmux` and `git` present, no vendor CLI found; image ≤ 400 MB (record the actual size); OCI labels present. | ⬜ |
| TC-M9-06-02 | Compose stack end to end | 1. `docker compose -f deploy/compose/team.yaml up -d` (daemon + Postgres + MinIO + Dex). 2. Log in as `alice`, start a FakeProvider session, answer a prompt, open the replay. | Everything works through the containerised daemon; the recording plays from MinIO via a presigned URL; `orch storage check` inside the container reports postgres + s3. | ⬜ |
| TC-M9-06-03 | Helm install on kind | 1. `kind create cluster`. 2. `kind load docker-image orchestra:dev`. 3. `helm install orchestra deploy/helm/orchestra -f deploy/helm/values-kind.yaml`. 4. `kubectl wait --for=condition=Ready pod -l app=orchestra --timeout=120s`. 5. Port-forward and log in. | Pod Ready inside 120 s (record the actual time); readiness lists all six checks ok; the UI is reachable and OIDC login works. | ⬜ |
| TC-M9-06-04 | Resilience: pod restart with work in flight | 1. Start two FakeProvider sessions; leave one prompt open and one recording mid-segment. 2. `kubectl delete pod -l app=orchestra`. 3. Watch `kubectl get pod -w` and the UI. | Pod terminates within the grace period (drain log shows spool flushed + upload finished); new pod Ready; both sessions show `crashed · host restarted` with the container-mode explanation; the open prompt is still in Attention with the restored badge; `orch audit verify` ok. | ⬜ |
| TC-M9-06-05 | Negative: misconfigured chart | 1. `helm install` with `replicaCount: 2`. 2. With `oidc.enabled: true` and empty `server.publicUrl`. 3. With `persistence.enabled: false` and `acceptDataLoss: false`. | Each install fails at template time with a specific, readable message; nothing is created in the cluster. | ⬜ |
| TC-M9-06-06 | Negative: vendor CLI not mounted | 1. Install with `providers.binaries: {}`. 2. Open Fleet. 3. Try to start a Claude session. | Fleet shows Claude as "not mounted — see deployment docs" (not a crash); starting a session fails with `ProviderUnavailable` and a link to the docs; the daemon stays Ready. | ⬜ |
| TC-M9-06-07 | Real CLI in the container | 1. Build a derived image with Claude Code installed per vendor docs. 2. Deploy it; `kubectl exec` and complete the official `claude` login once with the CLI config dir on `/data`. 3. Start a real session and answer a prompt from the browser. | Login persists across a pod restart (config on the PVC); the session runs in a tmux pane in the pod; prompts round-trip; nothing about the login was automated or proxied by Orchestra. | ⬜ |
| TC-M9-06-08 | Resource limits and read-only FS | 1. Set `resources.limits.memory: 1Gi`. 2. Run 10 FakeProvider sessions. 3. `kubectl top pod` and check for OOMKills; try `touch /etc/foo` inside the container. | No OOMKill at the documented session count (or the docs' sizing table is corrected from this measurement); writing outside `/data` and `/tmp` fails; the daemon logs no permission errors during normal operation. | ⬜ |

### 6.3 Review regression scenarios
- [ ] Pod restart preserves worktree bytes on the configured PVC but cancels old process-bound approvals.
- [ ] Node reschedule follows the selected storage topology; unsupported relocation is reported.
- [ ] Volume deletion is handled as data loss/backup recovery, never prompt restoration.

## 7. Acceptance criteria (Definition of Done)
- [ ] The review reconciliation contract and all §6.3 regression scenarios pass; archive evidence alongside the original test cases.
- [ ] One multi-arch image builds reproducibly, runs as a non-root user with a read-only root filesystem, and contains `tmux` + `git` but **no vendor CLI** (CI-asserted).
- [ ] Image is signed (cosign) and ships an SBOM, consistent with the supply-chain controls in `07-compliance-rules.md`.
- [ ] `helm install` on kind reaches `Ready` within 120 s against Postgres + MinIO + Dex, with startup/liveness/readiness probes behaving per the table (liveness does not depend on the DB).
- [ ] `kubectl delete pod` → daemon returns Ready, sessions are marked `crashed(host_restarted)`, and the open-prompt count is unchanged (IT-M9-06-04, TC-M9-06-04).
- [ ] Graceful drain flushes the audit spool and finishes recording uploads within the grace period, and every step is idempotent after a SIGKILL.
- [ ] The chart refuses configurations that would silently lose data or break the single-instance invariant (TC-M9-06-05).
- [ ] All three vendor-CLI mounting patterns are documented, and the licensing reason for not bundling is stated in the docs and the chart NOTES.
- [ ] `helm-smoke` CI job is green on `main`; `helm lint`, golden templates and `kubeconform` run in CI.
- [ ] All TC-M9-06-* pass and are recorded; no new lint/arch violations; `docs/deployment/{docker,kubernetes}.md` written; `PROGRESS.md` updated.

## 8. Risks / open questions
- **tmux in a container weakens D2.** The "sessions survive the daemon" promise becomes "sessions survive the *daemon process*, not the *pod*". Every mitigation here (Recreate, drain, restore) reduces damage but does not restore the property. If container mode becomes the primary deployment, the honest long-term answer is agents in their own pods — deliberately out of scope for 1.0, but the docs must not oversell.
- Uncommitted worktree state on a PVC is lost if the volume is recreated or the pod lands on another node with `ReadWriteOnce` — flagged as R-C2; consider auto-committing to the task branch before drain (not designed here; candidate for M10).
- `node-pty` 1.1.0 and `better-sqlite3` prebuilds for `linux/arm64` may be missing, forcing a compile in the build stage and a much longer build (verify at step start; if compiling, ensure build tools stay out of the runtime layer).
- Binding `0.0.0.0` inside the pod contradicts `03-architecture.md` §7 as written. The flag-guarded exception is the proposal; an ADR may be warranted (inconsistency, not fixed here).
- Vendor login inside a cluster is awkward and may be effectively impossible for CLIs that require a browser on the same machine. That would make container mode usable only with FakeProvider and CLIs supporting headless login — verify per provider and record a support matrix in the docs (verify).
- Long-lived WebSockets through ingress controllers vary (`proxy-read-timeout`, idle timeouts on cloud LBs). Terminals may disconnect every N minutes on some setups; the default annotations cover nginx only (verify on one cloud provider).
- `deploy/` is not in `11-repo-layout.md`; this step and M9-05 both create subfolders there. The layout doc needs an update (not done here).
- Bundling evaluation Postgres/MinIO subcharts invites someone to run them in production. The NOTES warning may not be enough; consider defaulting both to `false` (currently `s3.enabled: true` for MinIO in kind values only) (verify with the first operator).

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
