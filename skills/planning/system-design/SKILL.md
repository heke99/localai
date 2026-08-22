---
name: system-design
description: Use for architecture involving multiple services, databases, queues, models, sandboxes, integrations or scaling boundaries.
metadata: {version: "1.0.0", category: planning, risk: medium}
---
# System Design

## When to Use
Cross-service architecture, new persistence boundary, multi-tenant design, GPU/model serving, asynchronous workflows or high-scale changes.

## When NOT to Use
Single-file implementation with no architectural consequence.

## Inputs
Requirements, SLOs, traffic/usage assumptions, data classes, trust boundaries and current topology.

## Workflow
1. Define functional and non-functional requirements.
2. Draw trust/data boundaries and ownership.
3. Define canonical data model and source of truth.
4. Define APIs/events with idempotency and versioning.
5. Plan authN/authZ, tenant isolation, secrets and audit.
6. Plan failure, retries, backpressure, recovery and rollback.
7. Plan observability and capacity.
8. Keep model/GPU adapters outside business logic.
9. Document migrations and compatibility.

## Verification Gate
Every critical state transition has an owner, durable source of truth, failure path and observable signal.

## Failure / Rollback
Prefer staged migration, feature flags/canaries and backward-compatible contracts where possible.
