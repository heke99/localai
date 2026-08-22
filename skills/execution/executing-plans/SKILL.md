---
name: executing-plans
description: Use when a written plan exists and the agent must implement it sequentially with evidence checkpoints and scope control.
metadata: {version: "1.0.0", category: execution, risk: medium}
---
# Executing Plans

## When to Use
A reviewed plan exists and implementation should begin.

## When NOT to Use
No design/plan exists for a complex task; plan first.

## Inputs
Plan, current branch/workspace, available tools, verification commands.

## Workflow
1. Re-read plan and current repository state; detect drift.
2. Establish an isolated/recoverable workspace when supported.
3. Execute one dependency-safe unit at a time.
4. Run its local verification immediately.
5. Record changed assumptions and update downstream plan items.
6. Use parallel agents only for independent work with non-overlapping ownership.
7. Run integrated verification after local checks.
8. Finish with verification-before-completion.

## Verification Gate
Every completed plan item has fresh evidence and no unresolved blocker is silently skipped.

## Failure / Rollback
Stop dependent tasks after a failed invariant. Restore last valid checkpoint or repair root cause before continuing.
