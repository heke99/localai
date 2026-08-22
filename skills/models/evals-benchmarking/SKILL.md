---
name: evals-benchmarking
description: Use when measuring whether a model, prompt, skill, retrieval change or agent workflow is actually better and safe to promote.
metadata: {version: "1.0.0", category: models, risk: medium}
---
# Evals & Benchmarking

## When to Use
Model comparisons, skill revisions, prompt changes, RAG/memory changes, quantization, routing policy or pre-release quality gates.

## When NOT to Use
A purely operational change with no plausible behavior impact, unless reliability metrics are still required.

## Inputs
Candidate and baseline, task taxonomy, golden cases, adversarial cases, scoring rules, latency/cost metrics and acceptance thresholds.

## Workflow
1. Define the decision the eval must support before running it.
2. Use representative private/project tasks in addition to public benchmarks.
3. Separate deterministic checks from judge-model scoring.
4. Include negative/adversarial cases: prompt injection, bad memory, tool failure, insufficient permissions and ambiguous instructions.
5. Measure correctness, completeness, tool-call validity, policy/permission compliance, latency, throughput and resource cost.
6. Blind or randomize A/B order when judge bias matters.
7. Track variance and confidence; do not promote from one anecdotal win.
8. Store dataset/version, model/runtime/skill versions and raw outcomes for reproducibility.
9. Gate promotion on no critical regression plus configured task-specific improvements.

## Verification Gate
Results are reproducible, baseline-comparable and cover the failure classes relevant to the change.

## Failure / Rollback
If eval data is contaminated by training leakage, unstable judges or changed infrastructure, invalidate the run rather than averaging it into history.
