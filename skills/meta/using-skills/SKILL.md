---
name: using-skills
description: Use at task start to discover, order and load the minimum LocalAI skills needed for reliable execution.
metadata: {version: "1.0.0", category: meta, risk: low}
---
# Using Skills

## When to Use
At the start of any non-trivial task or whenever the task changes domain.

## When NOT to Use
Do not repeatedly reload unchanged skills inside the same stable phase.

## Inputs
Task intent, actor grants, available tools, current repository/runtime context.

## Workflow
1. Classify task: design, implementation, bug, research, platform, security or operations.
2. Read registry metadata only; choose the smallest matching set.
3. Load process skill before domain skill.
4. Expand declared dependencies.
5. Reject skills that require tools/permissions the actor does not have.
6. Keep unrelated skills out of context.
7. Re-route when evidence changes the task class.

## Verification Gate
Before action, be able to state internally which skill owns the process and which skill owns the domain.

## Failure / Rollback
If routing is ambiguous, choose the safer read-only/process path and gather evidence before mutation.
