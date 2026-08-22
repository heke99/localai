---
name: audit-context-building
description: Use before a deep security audit to construct a precise architecture, trust-boundary, entry-point and data-flow map from the actual codebase.
metadata: {version: "1.0.0", category: security, risk: low}
---
# Audit Context Building

## When to Use
Security audit, threat modeling, unfamiliar codebase, complex authorization or multi-service review.

## When NOT to Use
Small known diff where the surrounding architecture is already established.

## Inputs
Repository, deployment topology, schemas/configuration and known entry points.

## Workflow
1. Inventory languages/frameworks/services and generated/vendor boundaries.
2. Find external entry points: HTTP, jobs, queues, webhooks, CLI, files and RPC.
3. Trace authentication and authorization decisions.
4. Map privileged identities, secrets and trust transitions.
5. Trace critical data from input through validation, persistence and output.
6. Identify code that crosses tenant/security boundaries.
7. Map state-changing operations and high-impact sinks.
8. Record uncertain/unresolved dynamic calls instead of assuming them safe.
9. Produce a compact attack-surface map used by subsequent audit skills.

## Verification Gate
Critical findings can be located within a documented path from entry point through trust boundary to sensitive sink/state.

## Failure / Rollback
If code generation/runtime indirection blocks tracing, mark the blind spot and obtain runtime/static-analysis evidence before concluding coverage.
