---
name: code-review
description: Use to review code or diffs for correctness, regressions, security, maintainability and test gaps before integration.
metadata: {version: "1.0.0", category: engineering, risk: low}
---
# Code Review

## When to Use
PR/diff review, pre-merge quality gate, risky refactor or completed implementation task.

## When NOT to Use
Root-cause investigation of an active unknown bug; debug first.

## Inputs
Diff, surrounding code, specification/plan, tests and relevant runtime/schema contracts.

## Workflow
1. Understand intended behavior and invariants before judging style.
2. Inspect changed code plus callers/callees and data/schema contracts.
3. Prioritize correctness, security, data loss, race conditions and broken compatibility.
4. Check error handling, idempotency and authorization at boundaries.
5. Check tests for falsifiability and missing negative/edge cases.
6. Separate blocking defects from suggestions.
7. Cite concrete files/lines or behavior paths where possible.

## Verification Gate
Each blocking finding explains a plausible failure path, not merely a preference.

## Failure / Rollback
If context is insufficient to prove a defect, label it as a question/risk instead of a confirmed bug.
