# Provider-neutral GPU runtime

The application routes work by logical model aliases (`general-prod`, `code-prod`, `lab-prod`, `research-prod`). A physical GPU, Pod, VM or vendor endpoint is never a permanent application identity.

## Runtime selection

`RuntimeManager` resolves a logical alias through the service-role-only Supabase runtime registry. It reuses a healthy `ready` worker first. If capacity must be started/provisioned, managed providers are tried in configured priority order. A distributed `(alias, provider)` lease prevents duplicate provisioning from concurrent serverless instances.

Managed `ready` routes must have a recent agent-worker heartbeat. The default worker heartbeat is 30 seconds and the DB route freshness window is 90 seconds. Model `/health` alone is not sufficient to prove the agent queue can be processed.

## Provider paths

### RunPod

RunPod remains the first managed adapter. The original Pod ID is only a bootstrap candidate. Existing managed failover can reuse or create a replacement Pod on the persistent Network Volume. The web/API layer never calls RunPod directly.

### Hyperstack

The Hyperstack managed adapter queries current flavor stock, selects from the configured GPU preference list, creates/resumes a VM and uses cloud-init for first boot. Provisioning data receives only a short-lived one-time bootstrap token; long-lived Supabase/inference credentials are exchanged over HTTPS after boot.

### Rented/raw GPU

Any trusted apt-based Ubuntu/CUDA NVIDIA GPU host can join without a vendor-specific adapter:

1. Configure runtime identity/secrets on the host.
2. Run `infra/runtime/bootstrap-host.sh` as root.
3. The script verifies the NVIDIA runtime, installs a pinned Node release, builds a pinned CUDA `llama.cpp`, downloads the checksum-pinned Qwen Q8 artifact, configures HTTPS ingress/systemd, starts `infra/runtime/start-production.sh`, and launches the agent worker.
4. The agent worker self-registers `runtimeContract=div3rsa-runtime-v1` and heartbeats the runtime registry.
5. `RuntimeManager` can reuse that worker even when its provider key (for example `manual-gpu` or a new rental vendor) has no adapter in the web application.

This is the lowest-coupling migration path when renting GPU compute from a vendor that only supplies a normal Linux VM.

### Generic OpenAI-compatible endpoint

A static OpenAI-compatible adapter remains available for externally managed inference. Full agent/chat execution still requires an agent worker capable of serving the queue; for general rented GPU compute, the `div3rsa-runtime-v1` bootstrap path is preferred.

## Security boundaries

- Provider/API credentials are server-only environment variables.
- Runtime registry rows contain routing/health metadata, never provider secrets.
- Managed cloud-init receives only an expiring single-use bootstrap token.
- The database stores only the SHA-256 hash of bootstrap tokens.
- Bootstrap exchange responses are `no-store` and tokens are consumed atomically.
- Runtime control/bootstrap/lease RPCs are `service_role` only with pinned empty `search_path`.
- Raw/self-registered runtime reuse requires HTTPS and the `div3rsa-runtime-v1` worker contract.

## Switching providers

Changing provider priority or disabling a provider does not require changes in conversations, projects, queue records or model aliases. Provider-specific lifecycle code is isolated behind `RuntimeProviderAdapter`; raw GPU hosts can bypass lifecycle adapters entirely by self-registering the common runtime contract.
