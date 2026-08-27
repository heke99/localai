---
name: reasoning-router
description: Use on agent requests to choose the minimum sufficient FAST, STANDARD or DEEP reasoning workflow based on complexity, uncertainty, risk and required tools.
metadata:
  version: "1.0.0"
  category: planning
  risk: low
---
# Reasoning Router

## When to Use
Use for agent requests where the runtime must choose how much reasoning and verification is justified before execution or response.

## When NOT to Use
Do not add extra reasoning passes to deterministic tool lookups or trivial formatting after the runtime has already classified them as FAST.

## Inputs
Task analysis, risk, complexity, uncertainty, required tools, repository breadth, current-information requirements and completion criteria.

## Workflow
1. Choose `FAST` for low-risk deterministic or simple questions; avoid planner/critic overhead.
2. Choose `STANDARD` when the task needs decomposition, current-information research, repository context, multiple constraints or evidence checks.
3. Choose `DEEP` for broad/high-impact work, critical changes, unresolved root cause, conflicting evidence or low confidence after STANDARD.
4. Escalate only when evidence is missing, a hypothesis fails, uncertainty remains material or verification rejects completion.
5. For STANDARD/DEEP, separate known facts, assumptions and open questions; gather evidence before selecting a conclusion.
6. For debugging, generate plausible hypotheses and eliminate them with logs, code, tests or tools instead of defending the first guess.
7. For mutations, perform consequence analysis and test observable behavior before completion.
8. Keep private scratch reasoning internal; return conclusions, evidence and concise rationale rather than hidden chain-of-thought.

## Verification Gate
The chosen level must be the least expensive workflow that still satisfies risk, evidence and completion requirements. Escalation requires an observable reason.

## Failure / Rollback
If deeper reasoning increases latency without improving evidence or correctness, return to the lower verified level and record the regression for evaluation.
