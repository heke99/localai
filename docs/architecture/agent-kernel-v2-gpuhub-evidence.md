# Agent Kernel V2 GPUHub evidence runner

This batch adds a production-like, fail-closed evidence collection path for model-backed Agent Kernel V2 shadow probes.

It does **not** enable production sampling.

## Purpose

Run the same Qwen p8 runtime twice on the GPUHub node:

1. baseline load without probe traffic;
2. the same foreground load while bounded tool-free probe traffic runs beside it.

The runner then combines:

- labeled verifier quality cases;
- baseline p95 TTFT;
- loaded p95 TTFT;
- baseline aggregate output tokens/s;
- loaded aggregate output tokens/s;
- probe p95 duration;
- probe error count;
- capacity skip count;
- total probe output tokens;

into the JSON contract consumed by `eval:agent-kernel-probes`.

## Safety invariants

- The runner calls the inference endpoint directly; it does not mutate the production worker environment.
- It never toggles production `DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED`.
- Probe calls expose no tools.
- Foreground and probe calls use separate request IDs.
- Probe concurrency is one and excess work is counted as capacity-skipped rather than queued.
- Missing metrics or malformed verifier JSON fail the evidence run.
- The promotion CLI remains authoritative: no rollout is allowed unless it returns `allowed=true`.
- The runner never edits llama.cpp launch flags or restarts the model process.

## Required environment

- `DIV3RSA_INFERENCE_BASE_URL`
- `DIV3RSA_INFERENCE_API_KEY`

Optional:

- `DIV3RSA_MODEL_RUNTIME_ALIAS` (default `localai-qwen38-v3-q8`)
- `DIV3RSA_PROBE_EVIDENCE_OUTPUT`
- `DIV3RSA_PROBE_EVAL_CASES`
- `DIV3RSA_PROBE_LOAD_CONCURRENCY` (default `8`)
- `DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER` (default `4`)
- `DIV3RSA_PROBE_LOAD_MAX_TOKENS` (default `256`)
- `DIV3RSA_PROBE_TIMEOUT_MS` (default `4000`)

## Execution

```bash
npm run eval:agent-kernel-probes:gpuhub
```

The command writes one evidence JSON file and evaluates it through the promotion gate. Exit code is non-zero when collection or promotion fails.

## Promotion sequence

1. Merge this runner with all CI green.
2. Execute it on the GPUHub production node while the p8 runtime is healthy.
3. Keep production probe env disabled.
4. Inspect the generated evidence artifact.
5. Require the promotion gate to return `allowed=true`.
6. Only in a separate PR consider a tiny production shadow sample (initially 0.5–1%).
