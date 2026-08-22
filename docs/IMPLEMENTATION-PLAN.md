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

## Next checkpoints

- Complete agent/skill runtime state machine and durable checkpoint worker.
- Add provider adapters behind `GpuProvider`, queueing, metrics and autoscaling.
- Add credential broker and sandbox profiles before enabling repository or Lab tool execution.
- Add knowledge ingestion with provenance, conflict checks and superadmin approval.
- Add eval, canary and rollback workflows before production model promotion.
