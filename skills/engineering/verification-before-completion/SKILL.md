---
name: verification-before-completion
description: Use immediately before claiming a task is fixed, complete, merged, deployed or production-ready.
metadata: {version: "1.0.0", category: engineering, risk: low}
---
# Verification Before Completion

## When to Use
Before any success/completion statement about mutable work.

## When NOT to Use
Pure explanation with no claim that external work succeeded.

## Inputs
Requested outcome, changed surfaces and strongest available verification methods.

## Workflow
1. Restate the observable completion criteria.
2. Run fresh targeted tests/checks.
3. Run impacted integration/build/type/lint checks as relevant.
4. Verify generated/schema/API artifacts are synchronized.
5. For deployment claims, verify deployed state rather than only local build.
6. Check git/PR/CI state when merge/push is part of the request.
7. Report verification level precisely.

## Verification Gate
No completion claim without current evidence matching the requested outcome.

## Failure / Rollback
If a check cannot be run, state the unverified boundary; do not translate partial evidence into a stronger claim.
