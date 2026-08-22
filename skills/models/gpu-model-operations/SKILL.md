---
name: gpu-model-operations
description: Use for installing, upgrading, quantizing, serving, moving, scaling, canarying or rolling back LocalAI model workloads across GPU infrastructure.
metadata: {version: "1.0.0", category: models, risk: high}
---
# GPU & Model Operations

## When to Use
New model/checkpoint, GPU provider change, quantization, inference runtime change, autoscaling, capacity expansion, canary or rollback.

## When NOT to Use
Prompt/routing changes that do not alter model artifacts or serving infrastructure.

## Inputs
Model artifact + checksum, license, serving runtime, quantization, GPU memory/compute requirements, eval baseline, traffic policy and rollback target.

## Workflow
1. Register model artifact immutably: source, revision, checksum, license, tokenizer, context limit and supported features.
2. Pin runtime/container/CUDA/library versions; generate an SBOM or equivalent dependency record.
3. Benchmark target quantization/runtime on representative prompts before promotion.
4. Keep inference gateway contract stable across GPU providers.
5. Provision capacity from declarative profiles rather than embedding provider-specific IDs in application logic.
6. Warm model, run health + correctness smoke tests, then canary a small traffic slice.
7. Compare quality, tool-call validity, latency, throughput, error rate and memory usage against baseline.
8. Drain old workers only after canary passes; checkpoint active durable agent workflows outside GPU memory.
9. Keep previous model/runtime artifact ready for rollback.

## Verification Gate
Canary meets configured quality and operational thresholds, artifact checksums match registry, and failover/rollback has been exercised or proven in staging.

## Failure / Rollback
Stop rollout on quality regression, malformed tool calls, instability or memory pressure; shift traffic back without deleting the previous artifact.
