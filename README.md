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
- Immutable Qwen3.8-27B-OBLITERATED **V3 Q8_0** manifest and product model aliases.
- Stable `ModelAdapter` and `GpuProvider` contracts so app logic is independent from Qwen, llama.cpp, RTX PRO 6000 and a specific GPU provider.
- Model worker compose profiles, resumable checksum-verified artifact download and a `large_96gb` capacity profile.
- Durable pre-agent runtime with run queue, state transitions, retries, cancellation, checkpoints and usage/audit persistence.
- Progressive skill engine, policy/tool/credential/sandbox boundaries and learning/eval gates.

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
services/              model gateway and control-plane workers
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

## Verified Qwen V3 runtime

The active model version is `qwen38-27b-obliterated-v3-q8-0`. The llama.cpp serving name is deliberately separate: `localai-qwen38-v3-q8`.

Verified V3 Q8 artifact:

```text
revision  768dd4ca58e1af3593605d93abef2c1c45647a07
sha256    afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221
bytes     29047075872
```

The current RunPod endpoint is configured only as server-side worker environment. `QWEN_INFERENCE_API_KEY` must never be exposed through `NEXT_PUBLIC_*` or browser code.

## Verify

```bash
npm install
npm run verify
```

The 29 GB Q8 model is intentionally not committed. A GPU worker downloads and verifies the pinned V3 artifact with:

```bash
DIV3RSA_MODEL_DIR=/models/qwen-v3 npm run model:fetch:q8
```

For a self-contained GPU host, start the local inference server and worker together with:

```bash
docker compose -f infra/docker/model-worker.compose.yaml up --build
```

For an agent worker that talks to an already-running external authenticated llama.cpp endpoint, provide the server-only environment variables and start only the worker profile:

```bash
QWEN_INFERENCE_BASE_URL=https://b8kxzn86fvrejm-8080.proxy.runpod.net/v1 \
  docker compose -f infra/docker/agent-worker.external.compose.yaml up --build -d
```

`QWEN_INFERENCE_API_KEY`, `SUPABASE_SECRET_KEY` and other secrets must come from the deployment secret store; they are intentionally absent from the command and repository.

## RunPod production autostart

Production Pods must not rely on a terminal session to start either inference or the queue worker. `infra/runpod/start-production.sh` is the canonical Pod boot supervisor. It starts the RunPod base services when present, launches the verified llama.cpp model, waits until `/health` is ready, then launches the durable agent queue worker. If either managed process exits, the supervisor exits so the Pod/container lifecycle can restart the runtime cleanly.

The currently verified persistent production paths are:

```text
DIV3RSA_REPO_DIR=/workspace/localai-app
DIV3RSA_LLAMA_SERVER_BIN=/workspace/localai/llama.cpp/build/bin/llama-server
DIV3RSA_MODEL_PATH=/workspace/localai/models/qwen38-v3-q8/Qwen3.8-27B-OBLITERATED-Q8_0.gguf
```

These remain overridable through environment variables for future GPU/provider moves. The RunPod template must also provide the server-only secrets:

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
QWEN_INFERENCE_API_KEY
```

The RunPod template/container start command is:

```bash
bash -lc 'bash "${DIV3RSA_REPO_DIR:-/workspace/localai-app}/infra/runpod/start-production.sh"'
```

The start command must be configured in the RunPod template so it runs whenever the Pod starts; merely having `restart: unless-stopped` inside a Compose file does not start that Compose project after a fresh Pod boot.

The agent worker also tolerates a model cold start. `DIV3RSA_MODEL_STARTUP_TIMEOUT_MS` controls how long it waits for inference to become healthy before failing the container, and `DIV3RSA_MODEL_STARTUP_POLL_MS` controls the readiness poll interval. Defaults are 15 minutes and 5 seconds.

Runtime logs are written under `DIV3RSA_RUNPOD_LOG_DIR` (default `/workspace/logs/div3rsa`) so model and worker boot failures can be diagnosed independently.