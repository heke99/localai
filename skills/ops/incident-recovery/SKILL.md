---
name: incident-recovery
description: Use during production incidents to stabilize LocalAI, establish evidence, mitigate safely, recover service and preserve a timeline for root-cause follow-up.
metadata: {version: "1.0.0", category: ops, risk: high}
---
# Incident Recovery

## When to Use
Outage, severe latency, data integrity concern, security event, bad model rollout or widespread agent/tool failure.

## When NOT to Use
Normal isolated bug with no operational impact.

## Inputs
Alert/symptoms, affected services/users, recent changes, dashboards/logs and known-good rollback points.

## Workflow
1. Declare incident scope and start an immutable timeline.
2. Stabilize first: stop harmful rollout/traffic/mutation if evidence supports it.
3. Preserve logs/artifacts before ephemeral workers disappear.
4. Identify blast radius by tenant, model, skill, deployment and tool dependency.
5. Prefer reversible mitigations: rollback, traffic shift, feature disable, queue drain.
6. Validate mitigation through user-visible signals.
7. Recover gradually while watching error/latency/data-integrity metrics.
8. After stabilization, perform systematic root-cause analysis and create regression tests/evals.

## Verification Gate
Service recovery is confirmed by user-path and telemetry evidence, and the harmful state is no longer propagating.

## Failure / Rollback
If mitigation worsens impact, return to the previous known-good state and reassess from preserved evidence.
