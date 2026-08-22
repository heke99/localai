---
name: static-analysis
description: Use when codebase-wide pattern, taint, dependency or vulnerability discovery benefits from Semgrep, CodeQL, linters, type systems or SARIF-based analysis.
metadata: {version: "1.0.0", category: security, risk: medium}
---
# Static Analysis

## When to Use
Large-codebase audits, variant discovery, taint paths, unsafe APIs, custom patterns or regression gates.

## When NOT to Use
A tiny local logic bug where direct reasoning/tests are stronger and faster.

## Inputs
Languages, build context, attack hypothesis, relevant sources/sinks and available analyzers.

## Workflow
1. Choose analyzer based on question, not habit.
2. Establish build/index prerequisites before interpreting missing results.
3. Start with high-signal built-in rules, then add focused custom queries where needed.
4. Scope generated/vendor code intentionally.
5. Triage findings by reachability and real data/control flow.
6. Validate potential vulnerabilities manually or dynamically before reporting as confirmed.
7. For confirmed patterns, search variants across the whole codebase.
8. Preserve machine-readable SARIF/results for regression comparison.

## Verification Gate
Confirmed findings have a real source-to-sink/control path and false positives are separated from tool output counts.

## Failure / Rollback
Do not interpret analyzer silence as proof of safety when indexing/build/rules lacked coverage.
