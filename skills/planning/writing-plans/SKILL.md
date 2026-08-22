---
name: writing-plans
description: Use after design is understood to produce an executable implementation plan with exact scope, dependencies and verification per task.
metadata: {version: "1.0.0", category: planning, risk: low}
---
# Writing Plans

## When to Use
Multi-step implementation, refactor, migration, production hardening or coordinated platform work.

## When NOT to Use
Tiny isolated change with one obvious edit and one test.

## Inputs
Approved design or well-defined desired state, repository facts and test/deploy constraints.

## Workflow
1. Break work into independently verifiable tasks.
2. For each task name files/components, behavior change, tests/checks and dependencies.
3. Put schema/API changes before dependent application changes.
4. Include generated artifacts and documentation that must stay synchronized.
5. Include failure/rollback points for risky changes.
6. Order tasks so the system remains understandable and preferably runnable between checkpoints.
7. End with full verification and release criteria.

## Verification Gate
Another capable agent should be able to execute the plan without inventing missing architecture or guessing completion criteria.

## Failure / Rollback
If execution discovers a false assumption, update the plan before continuing downstream tasks.
