# LocalAI

LocalAI is a model-agnostic, skill-first agent platform for coding, research, infrastructure, persistent knowledge, model/GPU operations and authorized security testing.

The repository keeps **skills, memory, policy, credentials, model weights and GPU infrastructure as separate layers**. This lets the platform replace Qwen or GPU providers without losing operational knowledge or rewriting the product.

## Principles

- Skills are small, composable and loaded on demand.
- Every skill has explicit triggers, non-triggers, workflow and verification gates.
- Process skills run before domain skills: plan/debug first, then execute.
- Evidence beats claims: an agent does not call work complete without fresh verification.
- External skills are dependencies, not trusted prompts. Pin, review and evaluate them.
- Knowledge ingestion is separated from model training.
- Security and code execution happen inside scoped sandboxes.
- Tool permissions are resolved independently from the model.

## Implemented foundation

- Next.js 16 product shell with invitation-only access request and simple Chat/Code/Lab/Research dashboard.
- Supabase control plane in project `Ai local`, split into `public`, `internal`, `training` and `audit` schemas.
- Tenant-aware RLS and MFA-gated superadmin review paths.
- Immutable Qwen3.8-27B-OBLITERATED **V2 Q8_0** manifest and model aliases.
- Stable `ModelAdapter` and `GpuProvider` contracts so app logic is independent from Qwen, llama.cpp, RTX PRO 6000 and a specific GPU provider.
- Model worker compose profile, resumable checksum-verified artifact download and a `large_96gb` capacity profile.

The exact system specification is committed at `docs/CANONICAL-SYSTEM-SPEC.md`. Work continues in the phase order documented there; a model is not considered production deployed merely because it is registered.

## Layout

```text
skills/               canonical LocalAI skills
skills/registry.yaml  discovery and dependency registry
skills/upstream.lock.yaml reviewed upstream influences
docs/                  runtime and skill contracts
scripts/               validation utilities
AGENTS.md              repo-wide agent rules
apps/web/              public product and authenticated shell
packages/              stable DB, model and provider contracts
services/              model gateway and future control-plane services
supabase/              canonical migrations and database assertions
models/                immutable model manifests
infra/                 GPU and model-worker profiles
```

## Initial upstream foundations

LocalAI's original skills are informed by the open Agent Skills standard, obra/superpowers engineering workflows, official Supabase skills, Vercel agent skills, and Trail of Bits security-skill patterns. See `THIRD_PARTY.md`.

## Runtime order

1. Resolve actor, tenant, role and tool grants.
2. Discover matching skills from metadata.
3. Load required process skills first.
4. Load domain skills only when required.
5. Establish sandbox/network/data boundaries.
6. Execute with checkpoints.
7. Verify the observable outcome.
8. Persist audit data, artifacts and explicitly approved knowledge.
9. Send measurable outcomes to evals; training data requires separate curation.

## Verify

```bash
npm install
npm run verify
```

The 29 GB Q8 model is intentionally not committed. A GPU worker downloads and verifies the pinned V2 artifact with:

```bash
DIV3RSA_MODEL_DIR=/models/qwen-v2 npm run model:fetch:q8
```
