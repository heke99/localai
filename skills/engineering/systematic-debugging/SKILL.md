---
name: systematic-debugging
description: Use for bugs, failing tests, unexpected behavior or incidents where the root cause is not already proven.
metadata: {version: "1.0.0", category: engineering, risk: low}
---
# Systematic Debugging

## When to Use
Any unexplained failure, flaky behavior, mismatch across environments or recurring workaround.

## When NOT to Use
Root cause is already demonstrated and only implementation remains.

## Inputs
Reproduction, logs/errors, relevant state, recent changes and system boundaries.

## Workflow
1. Reproduce reliably or characterize when reproduction fails.
2. Gather evidence at each boundary; do not patch the final symptom first.
3. Trace the bad value/state backward to its earliest incorrect origin.
4. Compare working vs failing paths and recent changes.
5. Form one falsifiable root-cause hypothesis.
6. Run the smallest experiment that can disprove it.
7. Once proven, add regression coverage and implement root-level fix.
8. Verify side effects and the original reproduction.

## Verification Gate
There is direct evidence connecting the fix to the demonstrated root cause and the original failure no longer reproduces.

## Failure / Rollback
After repeated failed hypotheses, widen the model of the system rather than stacking speculative patches.
