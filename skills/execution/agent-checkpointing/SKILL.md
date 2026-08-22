---
name: agent-checkpointing
description: Use for long or stateful agent runs so work can resume safely after model, process, GPU or tool failure.
metadata: {version: "1.0.0", category: execution, risk: medium}
---
# Agent Checkpointing

## When to Use
Long-running coding, research, migration, multi-tool or security-testing workflows.

## When NOT to Use
Read-only response with no mutable external state.

## Inputs
Run ID, task graph, artifacts, tool mutations, last verified state and pending work.

## Workflow
1. Assign stable run/task IDs independent of model session.
2. Persist plan version and completed task IDs.
3. Persist artifact references, not giant duplicated context blobs.
4. Record external mutations with idempotency keys where available.
5. Store last verification evidence and model/tool versions.
6. On resume, revalidate mutable external state before continuing.
7. Never replay a mutation merely because the model forgot it happened.

## Verification Gate
A fresh model process can reconstruct what is done, what is pending and which mutations are safe to retry.

## Failure / Rollback
Resume from last verified checkpoint; invalidate stale checkpoints after incompatible schema/policy/model-tool contract changes.
