---
name: model-routing
description: Use when selecting among LocalAI models or model profiles based on task capability, context, latency, cost, risk and tool-use requirements.
metadata: {version: "1.0.0", category: models, risk: medium}
---
# Model Routing

## When to Use
Every inference path with more than one available model/profile, including code, reasoning, security analysis, vision or fast chat routes.

## When NOT to Use
A deployment intentionally pinned to one model for an eval/canary.

## Inputs
Task class, required modalities/tools, context size, latency budget, quality target, risk tier, model registry and recent eval scores.

## Workflow
1. Filter models that cannot satisfy required modality/context/tool schema.
2. Enforce actor/product policy independently from model choice.
3. Rank remaining candidates using current evals for the task class, not marketing benchmark averages.
4. Include latency, memory/GPU fit, queue depth and cost in routing score.
5. Use explicit model pin when reproducibility is required.
6. For high-risk actions, prefer the model/profile with stronger tool-call/eval reliability even if slower.
7. Record selected model, version, quantization, adapter and routing reason.
8. Fall back only to models that meet the same minimum capability/policy contract.

## Verification Gate
Every route is reproducible from logged inputs + model registry state and can be explained without hidden model-specific business logic.

## Failure / Rollback
If no eligible model meets requirements, fail clearly or downgrade the requested capability explicitly; never silently route to an incompatible cheaper model.
