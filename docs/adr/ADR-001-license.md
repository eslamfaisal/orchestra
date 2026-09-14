# ADR-001 — Core license

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-09-15 |
| Deciders | Not recorded |
| Related steps | M0-01, M10-07 |

## Context
The plan needs an explicit license for the initial scaffold while core licensing remains open.

## Options considered
Apache-2.0 throughout, or AGPL-3.0 for core with Apache-2.0 for SDK/protocol/plugins.

## Decision
Use the plan's provisional Apache-2.0 default for the scaffold. A final core-license decision must be recorded before accepting the first external contribution. This ADR does not record that final decision.

## Consequences
The root LICENSE contains Apache-2.0; package metadata matches. Any future change needs explicit review and must respect existing contributions.

## Compliance / security impact
No provider credentials, vendor binaries or service terms are sublicensed by this repository.
