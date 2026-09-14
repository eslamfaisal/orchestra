# Step M0-02 — Core domain package

| Field | Value |
|---|---|
| Milestone | M0 — Foundation |
| Status | ⬜ Not started |
| Depends on | M0-01 |
| Estimated effort | 2 days |
| Packages touched | `packages/core` |
| Risk | Medium (shapes everything after) |
| Owner | |

## 1. Goal
`@orchestra/core` contains the pure domain from `04-domain-model.md`: entities, value objects, the five state machines, typed domain errors, `Result` helpers, repository/port interfaces, the event catalog types, and `Clock`/`IdGenerator` ports — with zero runtime dependencies except `neverthrow` and `zod` (types) and 100 % branch coverage on state machines and value-object validation.

## 2. Why
D9 (Clean Architecture; core is pure and testable), D13/D14 (supervisor + AgentPrompt are domain concepts), G5 (the event catalog is defined once, here), `09-engineering-standards.md` (Result not throw; ports injected).

## 3. Scope
### In scope
- Value objects: `ProviderId`, `ModelId`, `TaskType`, `RoleName`, `WindowState`, `Budget`, `WorktreeRef`, `CapabilityFlag`, `SandboxProfile`, `AnswerTransport`, `Confidence`, `Ulid`, `IsoTimestamp`.
- Entities/aggregates: `Host`, `ProviderAccount`, `Session`, `Pane`, `Worktree`, `Mission`, `Task`, `TaskResult`, `Review`, `ReviewFinding`, `Conversation`, `Message`, `AgentPrompt`, `PlanVersion`, `RoutingDecision`, `PolicySet` (minimal), `RepairCase` (shape only).
- State machines as pure transition functions: `session`, `task`, `mission`, `agentPrompt`, `repairCase`.
- `DomainError` union with stable `code`s; `Result` re-exports.
- Ports: `SessionRepository`, `TaskRepository`, `MissionRepository`, `PromptRepository`, `EventStore`, `Clock`, `IdGenerator`, `EventBus`.
- `DomainEvent` types for the whole catalog in `04-domain-model.md` §3 (payload Zod schemas live here as *types + schemas*, no I/O).
### Out of scope (deferred)
- Domain services `AssignmentEngine` (M2-04), `QuotaForecaster` (M4-02), `ReviewRule` (M3-04), `DriftClassifier`/`RemediationLadder` (M6-02/04), `PromptClassifier` (M1-11) — folders created, empty.
- Persistence implementations → M0-05.

## 4. Design
### 4.1 Domain
Entities are immutable data + pure functions (`Session.transition(session, event) → Result<Session, DomainError>`), not classes with mutable state. Aggregates expose invariants as functions (`Task.canAssign`, `Mission.allTasksTerminal`).
### 4.2 Interfaces / contracts
```ts
// packages/core/src/shared/result.ts
export type { Result } from 'neverthrow'; export { ok, err } from 'neverthrow';

// packages/core/src/shared/errors.ts
export type DomainError =
  | { code: 'SESSION_NOT_FOUND'; sessionId: string }
  | { code: 'INVALID_TRANSITION'; entity: 'session'|'task'|'mission'|'prompt'|'repairCase'; from: string; event: string }
  | { code: 'PROVIDER_UNAVAILABLE'; providerId: string; reason: string }
  | { code: 'QUOTA_EXHAUSTED'; providerId: string; resetAt?: string }
  | { code: 'ACK_TIMEOUT'; paneId: string; command: string }
  | { code: 'VALIDATION'; path: string; message: string }
  | { code: 'CONCURRENCY_LIMIT'; providerId: string; max: number }
  | { code: 'FORBIDDEN'; action: string };

// packages/core/src/session/session.ts
export type SessionState = 'requested'|'launching'|'running'|'waiting_for_input'|'stopping'|'stopped'|'failed'|'crashed';
export type SessionEvent = { type:'launch' }|{ type:'ready' }|{ type:'prompt_opened' }|{ type:'prompt_answered' }|{ type:'stop' }|{ type:'exited'; code:number }|{ type:'crash' }|{ type:'resume' };
export function transitionSession(s: Session, e: SessionEvent, now: IsoTimestamp): Result<Session, DomainError>;

// packages/core/src/ports/
export interface Clock { now(): IsoTimestamp }
export interface IdGenerator { next(): Ulid }
export interface EventStore { append(e: DomainEvent): Promise<Result<void, DomainError>>; readSince(cursor: string, filter?: EventFilter): AsyncIterable<DomainEvent> }
export interface EventBus { publish(e: DomainEvent): void; subscribe(filter: EventFilter, h: (e: DomainEvent)=>void): Unsubscribe }
```
Every value object has `parse(x: unknown): Result<VO, DomainError>` backed by a Zod schema and a branded type.
### 4.3 Data / schema changes
None (types only). Table shapes in `04-domain-model.md` §4 are the target for M0-04/05.
### 4.4 Infrastructure
None. `package.json` `dependencies`: `neverthrow`, `zod` only.
### 4.5 API / UI surface
None.
### 4.6 Flow
n/a

## 5. Tasks
- [ ] Folder layout: `src/shared`, `src/host`, `src/provider`, `src/session`, `src/worktree`, `src/mission`, `src/task`, `src/review`, `src/conversation`, `src/prompt`, `src/plan`, `src/routing`, `src/policy`, `src/repair`, `src/events`, `src/ports`, `src/services` (empty).
- [ ] `shared/`: branded ids, `IsoTimestamp`, `Ulid` validators, `Result` re-exports, `DomainError`.
- [ ] Value objects with Zod schemas + `parse()`; property tests with fast-check for round-trips.
- [ ] Entities as readonly types + factory functions with invariant checks.
- [ ] Five state machines as tables (`Record<State, Partial<Record<EventType, State>>>`) + `transition*` functions returning `INVALID_TRANSITION` errors.
- [ ] `events/`: `DomainEvent` discriminated union + per-type payload schemas + `eventSchema` registry map (`type → zod`).
- [ ] Ports interfaces.
- [ ] `index.ts` barrel with explicit exports (no `export *` from deep files to keep the public surface deliberate).
- [ ] Vitest with coverage thresholds: `state-machines` and `value-objects` 100 % branches; package ≥ 90 %.
- [ ] README: how to add an entity/event; rule "no I/O in core".

## 6. Tests
### 6.1 Automated
| ID | Level | Test | Expected |
|---|---|---|---|
| UT-M0-02-01 | unit | every state machine: table-driven valid transitions | expected next state, timestamps updated |
| UT-M0-02-02 | unit | every state machine: every invalid (state, event) pair | `INVALID_TRANSITION` with from/event filled |
| UT-M0-02-03 | property | value objects `parse(print(x)) == x` | holds for 1000 cases each |
| UT-M0-02-04 | unit | `eventSchema` registry covers every `DomainEvent['type']` | compile-time exhaustive check + runtime test |
| UT-M0-02-05 | unit | `DomainError` codes unique | set size == union size |
| AT-M0-02-06 | architecture | depcruise `core-imports-nothing` | 0 violations |

### 6.2 Manual test cases
| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| TC-M0-02-01 | Coverage gate | 1. `pnpm --filter @orchestra/core test -- --coverage` | branches 100 % on `session|task|mission|prompt|repairCase` machines and `value-objects`; no threshold failure | ⬜ |
| TC-M0-02-02 | Public API is deliberate | 1. open `dist/index.d.ts` | only intended names exported; no `any` | ⬜ |
| TC-M0-02-03 | Purity | 1. `grep -r "node:" packages/core/src` 2. check `package.json` deps | no node builtins; deps = neverthrow, zod only | ⬜ |
| TC-M0-02-04 | Invalid transition surfaces cleanly | 1. in a REPL call `transitionSession(stoppedSession, {type:'ready'})` | `Err({code:'INVALID_TRANSITION', from:'stopped', event:'ready'})`, no throw | ⬜ |
| TC-M0-02-05 | Event registry | 1. add a new event type without a schema 2. `pnpm typecheck` | compile error pointing at the registry | ⬜ |

## 7. Acceptance criteria
- [ ] All entities/VOs/state machines/ports from `04-domain-model.md` exist with docs.
- [ ] 100 % branch coverage on state machines and VO validation; ≥ 90 % package.
- [ ] Zero runtime deps besides neverthrow + zod; depcruise clean.
- [ ] Event catalog types + schemas exhaustive (compile-time check).
- [ ] All TC pass; no new lint/arch violations.

## 8. Risks / open questions
- Temptation to put behaviour in classes: keep functions + data; classes only for DI-registered services in `application/`.
- Zod in core: allowed for schemas/types (no I/O); if bundle size matters for web, export types separately.

## 9. Notes & progress log
| Date | Note |
|---|---|
| | |
