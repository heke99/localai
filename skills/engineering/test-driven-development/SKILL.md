---
name: test-driven-development
description: Use for behavior-changing implementation to drive code from a falsifiable failing test through minimal passing code and refactor.
metadata: {version: "1.0.0", category: engineering, risk: low}
---
# Test-Driven Development

## When to Use
Bug fixes, new behavior, state machines, parsers, business rules and regressions where automated tests are practical.

## When NOT to Use
Pure prose/assets or trivial configuration that cannot produce meaningful behavioral assertions.

## Inputs
Desired observable behavior and the production boundary that owns it.

## Workflow
1. Name the real bug/behavior the test protects.
2. Write the smallest falsifiable test whose failure demonstrates the missing behavior.
3. Run it and confirm the expected RED failure.
4. Write minimal production code to make it pass.
5. Run targeted tests to GREEN.
6. Refactor without changing behavior.
7. Run broader impacted tests.
8. Prefer testing real behavior over mock existence or string-presence assertions.

## Verification Gate
The test must fail under a plausible mutation that reintroduces the defect; a constant/change-detector assertion is not sufficient.

## Failure / Rollback
If the test cannot distinguish correct from incorrect production behavior, redesign the test before adding more code.
