# 06 — Intelligence layer: task taxonomy, model profiles, assignment, playbooks

All of this is **data** (`packages/catalog`) validated by Zod schemas, versioned, hot-reloadable, overridable per org/workspace/user (D7).

## 1. Task taxonomy (`catalog/taxonomy/*.yaml`)

Each `TaskType` carries: `requiredCapabilities[]`, `preferredCapabilities[]`, `weights {reasoning, speed, cost, context, toolReliability, platformExpertise}` (sum 1.0), `risk (low|medium|high)` → approval gate, `reviewRequired (bool | 'two-reviewer')`, `defaultBudget`, `defaultSkills[]`, `sandboxDefault`.

| Group | Task types |
|---|---|
| Discovery | codebase-qa, research, dependency-audit, spike |
| Design | architecture, api-design, data-model, ux-spec |
| Planning | decomposition, estimation, deploy-checklist |
| Build | feature-impl (layer: domain/data/app/presentation), boilerplate, bulk-edit, ui-impl (flutter/swiftui/compose/react), refactor, dependency-upgrade, i18n |
| Quality | test-gen (unit/integration/e2e), bugfix, code-review (correctness/security/performance/architecture), security-audit, perf-optimization |
| Data | schema-migration, query-optimization, data-script |
| Platform | infra, release, incident |
| Docs | readme, api-docs, adr-writing, changelog, pr-description, commit-message |
| AI | prompt-engineering, ai-integration |
| Misc | quick (Quick Delegate, no plan file) |

## 2. Model capability profiles (`catalog/models/<provider>/<model>.yaml`)

```yaml
modelId: claude-opus-5
provider: claude
dimensions: { reasoning: 0.95, longContext: 0.9, speed: 0.5, instructionFollowing: 0.9, toolUse: 0.95, multimodal: 0.7,
              codeQuality: { typescript: 0.95, dart: 0.9, kotlin: 0.85, swift: 0.85, python: 0.9 } }
contextWindow: 1000000
costTier: 4            # 1 cheapest … 5 most expensive (subscription-relative)
bestFor: [architecture, refactor, security-audit, perf-optimization]
avoidFor: [boilerplate, changelog]
evidence:
  - { kind: benchmark, name: SWE-bench-verified, value: 0.8, date: 2026-08-01, url: … }
  - { kind: local-outcomes, sampleSize: 42, reviewFindingsPer100Loc: 1.2, testPassRate: 0.93, updated: 2026-09-10 }
validFrom: 2026-06-01
validTo: null
```
Community package ships defaults; `outcomes` table feeds local overrides (M8-06). Deprecations flow through model lifecycle (M6-06).

## 3. Assignment engine (deterministic, explainable — M2-04)

```
score(model, task) = capabilityFit(model, task)      // weighted dot product of task.weights × model.dimensions, 0 if a requiredCapability is missing
                   × quotaAvailability(provider)     // 1.0 healthy … 0 exhausted/cooling; uses forecast (M4-02)
                   × costEfficiency(model, task)     // prefers cheaper tier when fit is within ε of the best
                   × constraints(model, task)        // 0/1 gates: cross-vendor review (reviewer.provider ≠ author.provider), risk gates,
                                                     //   sandbox requirement, org allowlist, protect-Lead reserve, maxConcurrentSessions
```
Output: `RoutingDecision {chosen, score, reasons[], alternatives[top 3], dryRun}` — every decision persisted and shown in UI ("why this model"). Dry-run simulates a whole mission's window impact (M4-06).

Learning loop (M8-06): per `(model, taskType)` track review findings, test pass rate, rework rounds, latency, cost → adjusts *local* profile weights (bounded ±0.2) → Model Scorecard. Never touches ToS/auth rules. Anonymised export opt-in.

## 4. Default assignment matrix (starting point; engine + your evidence override)

| Task type | Primary | Fallback | Reviewer |
|---|---|---|---|
| architecture / api-design / data-model | Claude Fable → Opus | agy Gemini Pro | Codex GPT-5.x |
| decomposition (Lead) | Claude Fable/Opus | agy Claude-Opus (Google plan) | — |
| feature-impl (well-specified) | Codex GPT-5.x-Codex | Claude Sonnet | Claude Opus |
| boilerplate / bulk-edit / i18n | agy Gemini Flash | Kimi | Codex |
| ui-impl | Claude Sonnet/Opus | Codex | agy Gemini Pro |
| refactor (large, cross-file) | Claude Opus | Codex | agy Gemini Pro |
| bugfix / debug | Codex GPT-5.x-Codex | Claude Opus | Claude Sonnet |
| test-gen | Codex | agy Gemini Flash | Claude Sonnet |
| code-review (default round) | *different vendor than author* | — | — |
| security-audit | Claude Opus + Codex (two-reviewer) | — | — |
| perf-optimization | Claude Opus | Codex | agy |
| infra / migrations / release | Claude Opus | Codex | Codex/Opus |
| research / codebase-qa (large context) | agy Gemini Pro | Claude Opus | — |
| docs / changelog / pr-description | agy Gemini Flash | Claude Sonnet | any |
| quick chores | agy Gemini Flash / Sonnet | Kimi | — |

## 5. Mission playbooks (`catalog/playbooks/*.yaml`)
Mission type → task DAG template the Lead instantiates. Each step: `taskType`, `role`, `dependsOn[]`, `requiredSkills[]`, `gate (none|lead|human|4-eyes)`, `reviewRounds`, `budgetShare`.

Gate mapping: playbook `gate: none|lead|human|4-eyes` → M3-02 implements `none|lead|human` (`4-eyes` degrades to `human` with a warning); M9-04 `GateRule` implements `4-eyes` (approver ≠ requester) and policy-driven gates on risk/task type/branch.

Shipped: `new-feature-fullstack` (research → ADR → plan → implement per layer → tests → cross-review → docs → deploy-checklist), `bugfix`, `refactor`, `dependency-upgrade`, `incident`, `release`. Editable per workspace (M8-07).

## 6. Skills (`catalog/skill-packs/*`) — see M8-04
SKILL.md-style frontmatter: `name, version, taskTypes[], providers[], requiredCapabilities[], inputs, evals[]`. Rendered into each provider's native location with a trust level. Auto-attached by `taskType` + platform.

## Feasibility contract reconciliation (2026-09-15)
Provider capabilities are keyed by exact CLI version and execution mode; foundation 14 and M0-09 define the release gate. Mandatory unsupported capabilities block that mode; optional unsupported capabilities disable only the feature. Task success follows declared deliverables (M3-03), independent review uses model publisher identity (M3-04), and merge validation binds the exact candidate commit (M3-05). Recovery means durable captured records with explicit outcomes (M5-05), not universal capture or exactly-once effects. Budgets are admission limits (ADR-021). Learning defaults to shadow proposals (M8-06). Enterprise v1 is trusted shared-team execution (ADR-019); plugin provenance alone never authorizes untrusted execution (ADR-014). These revised contracts govern implementation; the source-plan-v0.2 snapshot is historical.
