---
name: capacity-benchmarking
description: Use when tuning concurrent model serving, llama.cpp parallel slots, batching, KV cache or GPU capacity and a production profile must be chosen from measured latency, throughput, stability and quality.
metadata:
  version: "1.0.0"
  category: ops
  risk: medium
---
# Capacity Benchmarking

## When to Use
Use for `--parallel` tuning, concurrent-user capacity, TTFT/throughput regression, context scaling, batch/ubatch tuning, KV-cache experiments, Flash Attention or speculative-decoding evaluation.

## When NOT to Use
Do not change production serving parameters from intuition, a single request, peak tokens/second alone or an unrepresentative synthetic workload.

## Inputs
Model/runtime version, GPU and VRAM, exact serving flags, representative prompts/contexts/outputs, concurrency matrix, quality eval set and latency/error SLOs.

## Workflow
1. Capture a reproducible baseline before changing serving parameters.
2. Test one serving profile at a time and record its exact configuration.
3. Exercise representative short, medium and long context/output workloads across the requested concurrency matrix.
4. Measure TTFT p50/p95/p99, request latency p50/p95/p99, per-user tokens/s, aggregate tokens/s, queue depth/time, active slots, KV-cache usage, GPU/VRAM utilization, error/timeout/cancel rate and cached-token reuse.
5. Run correctness/quality regression checks alongside performance tests, especially tool use, coding, reasoning and long-context behavior.
6. Reject profiles that gain aggregate throughput by making interactive p95, stability or quality unacceptable.
7. Increase concurrency only while useful throughput scales and SLOs remain satisfied; stop exploring higher profiles once saturation is proven for the same configuration.
8. Promote the best balanced profile with a rollback value and preserve raw benchmark output for later comparison.

## Verification Gate
A promoted profile must beat or intentionally trade against the same baseline workload with documented TTFT, throughput, queue, memory, stability and quality evidence.

## Failure / Rollback
Restore the previous known-good serving profile if p95 latency, errors, OOM risk, quality or user-level throughput regresses beyond the accepted threshold.
