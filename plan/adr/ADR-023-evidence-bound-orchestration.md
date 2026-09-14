# ADR-023 — Evidence-bound orchestration and recovery

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-09-15 |
| Deciders | Unassigned; no approval recorded |
| Related steps | M0-09, M1-11, M3-03, M3-05, M5-05, M6-04, M8-08 |

## Context
The feasibility review found universal prompt, success, merge and recovery guarantees that neither the provider interfaces nor the planned evidence could establish.

## Options considered
1. Universal adapters with heuristic acknowledgement and restart fallback: simpler surface, but can misreport task success and duplicate effects.
2. Capability-specific operations, immutable validation evidence and explicit uncertainty: more visible states, but failures and release conditions are reviewable.

## Decision
Propose option 2. M0-09 establishes mandatory per-mode capability gates. M1-11 uses correlated acknowledgement and rejects stale answers. M3-03 evaluates declared deliverables, not empty diff or process exit alone. M3-05 validates and approves the exact integration candidate and promotes it with an expected-target precondition. M5-05 separates record durability from usable interaction recovery. M6-04 restarts only from verified quiescent replay-safe checkpoints with exclusive ownership. Instruction cleanup preserves user edits and blocks managed content in submitted history.

## Consequences
Manual-only/unsupported features remain visible. Some failures require human reconciliation. Additional fixtures and fault-injection cases are required. Existing source-plan universal guarantees are superseded by these proposed detailed requirements; live support and human acceptance remain unverified.

## Compliance / security impact
Official binaries retain provider authentication. No credential-store access or upstream proxying is introduced. Uncertain delivery never authorizes a duplicate side effect. API policy and human gates stay outside model instructions.
