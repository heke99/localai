# Agent Kernel V2 shadow probe promotion gate

Model-backed shadow probes remain disabled by default. This gate defines the minimum evidence required before production shadow sampling can be considered.

## Quality gate

Promotion is blocked unless the evaluation set contains at least 20 labeled cases, including at least 8 intentionally weak baseline answers. The verifier must detect at least 80% of weak baselines while keeping false positives at or below 10%. Any unparsed verifier output blocks promotion.

## Load gate

Promotion is blocked when probe errors exceed 2%, capacity skips exceed 5%, p95 TTFT regresses by more than 5%, aggregate throughput regresses by more than 5%, p95 probe duration exceeds 4000 ms, or average probe output exceeds 768 tokens per sampled run.

The load comparison must use the same production-like runtime profile and request mix for baseline and probe-enabled measurements. Missing or invalid load evidence fails closed.

## CLI

Prepare one JSON document with `cases`, `load`, and optionally `thresholds`, then run:

`npm run eval:agent-kernel-probes -- path/to/evidence.json`

Exit code 0 means the evidence satisfies the gate. Exit code 1 means promotion is blocked. Exit code 2 means the evidence document itself is invalid.

## Promotion sequence

1. Run labeled offline quality evaluation.
2. Run production-like baseline load test with probes disabled.
3. Run the same load test with probes enabled at the proposed sample rate.
4. Feed both quality and load evidence to the CLI gate.
5. Only if `allowed=true`, create a separate production-shadow rollout PR with a very small sample rate.
6. Active Agent Kernel routing remains a separate later promotion and is not authorized by this gate.

No production sampling is enabled by this document or by the gate implementation itself.
