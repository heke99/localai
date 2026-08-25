# RunPod wake-on-demand

The production web app can prewarm the LocalAI RunPod when an authorized user begins typing and can wake it again when a run is submitted.

## Server-only web environment

Configure these in Vercel Production. Never expose `RUNPOD_API_KEY` through a `NEXT_PUBLIC_*` variable.

```text
RUNPOD_API_KEY=<RunPod API key>
RUNPOD_POD_ID=b8kxzn86fvrejm
RUNPOD_RUNTIME_HEALTH_URL=https://b8kxzn86fvrejm-8080.proxy.runpod.net/health
RUNPOD_RESTART_UNHEALTHY=1
RUNPOD_API_TIMEOUT_MS=5000
RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS=2000
RUNPOD_RUNTIME_RUNNING_CACHE_MS=15000
RUNPOD_RUNTIME_RESTART_GRACE_MS=300000
```

The prewarm endpoint authenticates the user and verifies workspace/agent access before it can trigger paid GPU compute. The API key remains server-side.

## Pod resume command

A resumed Pod also needs to start the LocalAI supervisor automatically. Configure the Pod/template start command to invoke:

```text
bash /workspace/localai-app/infra/runpod/auto-start.sh
```

`auto-start.sh` delegates to `infra/runpod/start-production.sh`, which starts RunPod base services, Qwen llama.cpp inference and the queue worker, then supervises the worker.

The Pod environment must continue to provide the production values required by `start-production.sh`, including `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `QWEN_INFERENCE_API_KEY`.

## Runtime behavior

1. The first non-empty composer input schedules a debounced prewarm request.
2. The server checks the runtime health endpoint before using the RunPod control API.
3. If the Pod is stopped, the server calls RunPod's Pod start endpoint.
4. If the Pod is already running and has only just started, it is treated as booting and is not restarted.
5. If the Pod has been running longer than the configured grace period but the runtime is still unhealthy, `RUNPOD_RESTART_UNHEALTHY=1` allows one wake request to restart the Pod.
6. Submitting a run independently invokes the same wake controller, so sending remains a fallback even when browser prewarm did not run.

Run creation is not rejected if RunPod wake fails. The run remains in the durable Supabase queue and can be claimed when a healthy worker becomes available.
