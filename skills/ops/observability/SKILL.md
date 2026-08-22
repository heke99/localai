---
name: observability
description: Use when designing or diagnosing LocalAI telemetry across requests, agent runs, model inference, tool calls, sandboxes, queues and user-visible latency.
metadata: {version: "1.0.0", category: ops, risk: medium}
---
# Observability

## When to Use
Production instrumentation, debugging, SLOs, capacity planning or distributed run tracing.

## When NOT to Use
One-off local code with no production operation.

## Inputs
User request/run IDs, service topology, critical states, latency/error goals and privacy constraints.

## Workflow
1. Propagate stable correlation/run/task IDs across gateway, model, tools and sandbox.
2. Emit structured events for state transitions, not only free-text logs.
3. Measure request latency, queue time, model TTFT/tokens, tool duration, retries, sandbox resource use and error classes.
4. Track model/skill/policy/runtime versions on each run.
5. Redact prompts/tool outputs where sensitive; log metadata by default rather than raw content.
6. Define SLOs and alerts on user-visible symptoms plus critical internal saturation.
7. Build traces that distinguish model delay, queue delay, database delay and tool delay.

## Verification Gate
A failed/slow user run can be traced end-to-end without exposing raw secrets or requiring guesswork across services.

## Failure / Rollback
If telemetry volume/cost is excessive, sample high-volume success paths while retaining errors and critical state transitions.
