# Agent Kernel V2 sampled shadow probes

## Scope

This stage introduces model-backed observation without changing the production answer path. Probes run only after the legacy processor has already produced a fixed baseline answer.

## Default state

Probes are off by default and sampling defaults to zero. Both `DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED=1` and a positive `DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS` are required. Agent Kernel V2 itself must also be enabled in `shadow` mode before the worker constructs a probe runner.

## Hard budgets

- deterministic run-id sampling, 0-10,000 basis points
- maximum concurrent probes, default 1 and hard cap 4
- maximum model calls per sampled run, default/hard cap 3
- maximum output tokens per call, default 256 and hard cap 512
- per-call abort timeout, default 4 seconds and hard cap 15 seconds
- no tool definitions are supplied to probe requests
- excess concurrent work is skipped rather than queued

## Roles

1. Planner: decomposes the already-known task and identifies risks/checks.
2. Researcher: only when current information is required; proposes evidence/source categories but cannot search or fetch.
3. Verifier: scores the existing legacy baseline answer. It cannot replace or rewrite it.

## Data handling

The model sees the same request/baseline material needed for the shadow evaluation, but raw probe outputs are not persisted. Telemetry stores only role/model, duration, output hash/size, usage and a compact verifier score/reason code.

## Failure isolation

Probe sampling, capacity skips, timeouts, model errors, parse failures and telemetry persistence failures are shadow-only conditions. They must never fail, retry, alter or delay the required legacy completion path.

## Promotion gate

Do not enable probes in production as part of this merge. A later promotion batch must first run offline/load evaluation, then start at a very small sample rate and verify GPU headroom, TTFT/total latency, error rate and quality-score usefulness before increasing sampling.
