---
name: differential-security-review
description: Use for security-focused review of a code change, pull request or release by analyzing the diff together with history, affected callers and privilege/data-flow changes.
metadata: {version: "1.0.0", category: security, risk: medium}
---
# Differential Security Review

## When to Use
PR/release security review, authentication/authorization changes, parser/input changes, dependency upgrades or fixes touching a security boundary.

## When NOT to Use
Full greenfield audit with no meaningful baseline; use audit-context-building first.

## Inputs
Diff/base/head, history/blame where useful, affected tests and architecture context.

## Workflow
1. Classify changed files by security relevance.
2. Identify changed trust boundaries, validation, auth decisions, serialization and dangerous sinks.
3. Trace changed functions to callers and downstream side effects.
4. Compare removed checks as carefully as added code.
5. Inspect historical intent when code looks oddly defensive.
6. Look for incomplete fixes and sibling variants of the same bug pattern.
7. Test changed assumptions with targeted tests/static analysis.
8. Report only evidence-backed risks and explicitly label uncertainty.

## Verification Gate
Review covers behavior beyond the textual diff where changed code influences privileged or externally controlled paths.

## Failure / Rollback
Escalate to full context audit if the diff alters foundational auth/data architecture beyond local reasoning.
