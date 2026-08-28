# Agent Kernel V2 shadow rollout

## Purpose

The first runtime-capable Agent Kernel V2 layer is intentionally observational. It converts the existing `TaskAnalysis` contract into a bounded multi-agent DAG, validates the plan, and computes safe parallel execution waves without changing the answer path.

## Safety invariants

- Legacy `AgentWorkerProcessor` remains the only production answer executor.
- Shadow planning performs no model generation and no tool execution.
- Shadow planning cannot mutate repositories, databases, deployments, memory, queues, or provider state.
- V2 must be explicitly enabled and configured with `DIV3RSA_AGENT_KERNEL_V2_MODE=shadow`; all other modes are a no-op in this component.
- Agent count and parallel width are bounded by rollout configuration.
- Verification remains mandatory by default. If the configured budget cannot retain the verifier, planning fails closed.
- Every plan is validated through the protocol-v2 contract before it can be observed or persisted.

## Shadow plan shape

The planner is always first. Independent research and scoped execution may share a parallel wave when both are required. The verifier depends on all material execution steps and always runs last.

Example:

`plan -> [research || execute] -> verify`

The logical model alias remains `general-prod`; verification is assigned to `verifier-prod`. The shadow planner does not resolve either alias yet.

## Promotion sequence

1. Validate deterministic shadow plans and parallel budgets in CI.
2. Add shadow telemetry persistence and baseline comparison without blocking the legacy answer path.
3. Add opt-in model-backed subagent probes with separate latency/GPU budgets.
4. Run offline and production-shadow evals.
5. Only after measurable quality gain and no production regression may a later PR introduce an active kernel path behind an explicit promotion gate.
