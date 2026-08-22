# Pre-agent readiness boundary

The application and control-plane code can be built and verified without installing model weights. This does not mean the model is deployed or production promoted.

## Ready before GPU installation

- Invitation-only product and Supabase authentication.
- Tenant-aware workspaces, conversations and database authorization.
- Run submission, durable queue, worker leases, checkpoints, retry and cancellation.
- Chat, Code, Lab and Research routing through logical model aliases.
- Lab requires an active, organization-bound authorization record.
- Model and GPU provider contracts remain replaceable.
- Skills are hash-indexed, dependency resolved and progressively loaded.
- Tool calls require permission, an allow rule and scoped temporary credentials for writes.
- Sandbox profiles require default-deny egress and bounded resources.
- Global knowledge requires superadmin approval and secret scanning.
- Training candidates require verified evidence and explicit curation.
- Model promotion requires pinned runtime/artifact and passing critical evals.

## Intentionally blocked until installation

- The model remains `registered`, not `production`.
- Runs may queue, but no worker consumes them until the private model endpoint is healthy.
- Repository, shell, browser and Lab execution remain disabled until the credential broker and sandbox backends are connected.
- Training remains disabled until a separate training compute pool is configured.

## Installation evidence required

1. Immutable llama.cpp image digest.
2. Immutable Node worker image digest.
3. CUDA and driver versions.
4. Verified model artifact SHA-256.
5. Model health, TTFT, tokens/second, VRAM and context tests.
6. Authenticated tenant-isolation and Lab authorization tests.
7. Full UI → API → queue → worker → model → message E2E.
8. Eval, canary and rollback evidence.
