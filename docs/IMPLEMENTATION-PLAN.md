# DIV3RSA Intelligence implementation plan

The canonical source is the supplied master specification. Delivery is staged so every checkpoint is replayable and model/GPU independent.

## Current vertical slice

1. Monorepo and typed contracts.
2. Public product shell, invitation request and simple Chat/Code/Lab/Research dashboard.
3. Supabase control-plane baseline with explicit tenancy, RBAC, audit and RLS.
4. Immutable Qwen3.8-27B-OBLITERATED V2 Q8_0 registry entry.
5. ModelAdapter and GpuProvider contracts with logical model aliases.
6. Automated contract tests and build gates.

## Release gates

- No runtime may use an unpinned model artifact.
- A model cannot progress past `registered` until its inference container digest, CUDA/runtime versions and representative evals exist.
- User-facing tables use RLS; internal/training/audit schemas are not granted to browser roles.
- No open signup is exposed by the product. Access requests are reviewed before invitations.
- Superadmin authority is enforced outside the foundation model and requires an `aal2` session for sensitive writes.
- GPU workers are stateless; durable agent, knowledge and audit state remains in the control plane.

## Pre-agent checkpoint implemented

- Agent state machine, durable run queue, `SKIP LOCKED` claiming, retry limits, cancellation and checkpoints.
- Progressive skill manifest, dependency-aware selection and pinned body loading.
- Authenticated run API and Chat/Code/Lab/Research dashboard status flow.
- Policy, credential, tool gateway and deny-by-default sandbox contracts.
- Knowledge preparation, provenance, secret rejection and conflict persistence.
- Dataset curation, deterministic version hashes, training separation and eval promotion gates.
- Model-independent gateway, real SSE parsing and Qwen V2 Q8 worker boundary.

## External installation checkpoint

- Select the GPU provider and provision the first `large_96gb` worker.
- Pin the llama.cpp and Node container digests plus CUDA/runtime versions.
- Download and checksum-verify the 29 GB Q8 artifact on the worker.
- Start the private model and agent-worker compose stack.
- Run representative model, agent, RLS and complete UI-to-model E2E suites.
- Record eval results before moving the model from `registered` to `verified`, `canary` and `production`.
