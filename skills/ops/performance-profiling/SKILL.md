---
name: performance-profiling
description: Use when LocalAI, a web app, database, model server or agent workflow is slow or expensive and optimization must be driven by measured bottlenecks.
metadata: {version: "1.0.0", category: ops, risk: medium}
---
# Performance Profiling

## When to Use
Latency, throughput, memory, GPU utilization, database/query cost, frontend performance or excessive tool/model spend.

## When NOT to Use
No measurable performance problem or target exists.

## Inputs
Baseline metrics, workload, SLO/budget and system topology.

## Workflow
1. Define one measurable target and representative workload.
2. Capture baseline before changes.
3. Break latency/cost into queue, model, DB, network, tool, serialization and client components.
4. Profile the largest contributor first.
5. Change one bottleneck hypothesis at a time.
6. Re-measure with the same workload and include p50/p95/p99 where relevant.
7. Check correctness/cache consistency after optimization.
8. Keep optimizations that improve the target without unacceptable regressions elsewhere.

## Verification Gate
Improvement is demonstrated against the same baseline workload with no hidden correctness regression.

## Failure / Rollback
Revert optimizations that only move cost/latency to another layer or rely on stale/incorrect caching.
