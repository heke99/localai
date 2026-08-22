---
name: parallel-agent-orchestration
description: Use when two or more independent investigation or implementation tasks can run concurrently without conflicting state.
metadata: {version: "1.0.0", category: execution, risk: medium}
---
# Parallel Agent Orchestration

## When to Use
Independent files/components, separate failing tests, distinct research tracks or review workers.

## When NOT to Use
Tasks mutate the same state, depend on sequential discoveries, or share a fragile environment.

## Inputs
Task graph, ownership boundaries, shared constraints and merge/integration point.

## Workflow
1. Prove independence before dispatch.
2. Give each worker a bounded objective, inputs, files/resources it owns and required output/evidence.
3. Do not give workers hidden authority over shared destructive state.
4. Require structured results: findings/changes/evidence/risks.
5. Integrate centrally; resolve contradictions against source-of-truth evidence.
6. Run cross-cutting verification after integration.

## Verification Gate
No two workers unknowingly modified the same invariant or relied on incompatible assumptions.

## Failure / Rollback
Discard only the failing worker result, not valid independent work; re-run the affected branch with corrected context.
