---
name: property-based-testing
description: Use for parsers, serializers, state machines, validation, authorization invariants, numeric logic and other behavior where broad generated inputs reveal edge cases better than examples alone.
metadata: {version: "1.0.0", category: security, risk: low}
---
# Property-Based Testing

## When to Use
Input-heavy or combinatorial logic with clear invariants.

## When NOT to Use
UI layout/prose or behavior with no meaningful invariant/generator.

## Inputs
System under test, invariants, generators, constraints and known edge cases.

## Workflow
1. State invariant independently from implementation.
2. Build generators that include boundary, malformed and adversarial values.
3. Use shrinking/minimization so failures become reproducible examples.
4. For stateful systems, generate valid action sequences and assert safety invariants after each step.
5. Seed known regressions into the generator corpus.
6. Persist minimized counterexamples as deterministic regression tests.

## Verification Gate
A deliberately broken implementation violates the property and produces a useful minimized counterexample.

## Failure / Rollback
Reject properties that merely restate implementation output or only prove framework behavior.
