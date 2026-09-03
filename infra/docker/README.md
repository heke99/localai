# Docker runtime wiring

The web application stays on Vercel. Qwen and execution tools run on the GPU/agent host.

## Local Qwen stack

Use `infra/docker/model-worker.compose.yaml` when Qwen runs on the same Docker host.

Required server-side values:

```bash
export SUPABASE_URL='https://<project>.supabase.co'
export SUPABASE_SECRET_KEY='<server-only-secret>'
export QWEN_INFERENCE_API_KEY="$(openssl rand -hex 32)"
export SEARXNG_SECRET="$(openssl rand -hex 32)"
export DIV3RSA_BROWSER_EXECUTOR_TOKEN="$(openssl rand -hex 32)"
export DIV3RSA_BROWSER_EXECUTOR_URL='http://browser-executor:7320'
export DIV3RSA_MODEL_DIR='/absolute/path/to/verified/model-directory'

# Pin all runtime images to verified immutable digests.
export NODE_IMAGE='node:24-bookworm-slim@sha256:<verified-digest>'
export LLAMA_CPP_IMAGE='ghcr.io/ggml-org/llama.cpp:<verified-tag>@sha256:<verified-digest>'
export PLAYWRIGHT_IMAGE='mcr.microsoft.com/playwright:v1.62.1-noble@sha256:<verified-digest>'
```

Start Qwen, the agent worker, SearXNG, controlled egress and the scoped browser executor:

```bash
docker compose \
  -f infra/docker/model-worker.compose.yaml \
  --profile browser \
  up -d --build
```

Check state and logs:

```bash
docker compose -f infra/docker/model-worker.compose.yaml --profile browser ps
docker compose -f infra/docker/model-worker.compose.yaml --profile browser logs --tail=200 agent-worker
docker compose -f infra/docker/model-worker.compose.yaml --profile browser logs --tail=200 egress-proxy
docker compose -f infra/docker/model-worker.compose.yaml --profile browser logs --tail=200 browser-executor
```

The local inference URL is fixed inside Compose as `http://qwen-v3-q8:8080/v1`. The worker `NO_PROXY` list includes `qwen-v3-q8`, `searxng`, `egress-proxy` and `browser-executor`, so internal control traffic is not accidentally sent through public egress.

## External inference stack

Use `infra/docker/agent-worker.external.compose.yaml` when Qwen is provided by a separate OpenAI-compatible endpoint.

In addition to the values above, set:

```bash
export QWEN_INFERENCE_BASE_URL='https://<trusted-inference-host>/v1'
```

If that endpoint is a private/internal hostname rather than public HTTPS, append its hostname to `NO_PROXY` before starting the stack:

```bash
export NO_PROXY="localhost,127.0.0.1,::1,searxng,egress-proxy,browser-executor,<private-qwen-host>"
```

Then start:

```bash
docker compose \
  -f infra/docker/agent-worker.external.compose.yaml \
  --profile browser \
  up -d --build
```

## Network boundaries

- Qwen never receives a raw network socket or Docker socket.
- `web_search` talks only to the internal SearXNG service.
- SearXNG sends search-engine traffic through `egress-proxy`.
- `web_fetch` and ordinary worker HTTP clients use the Node proxy environment in Docker.
- Lab `http_request` calls the internal egress proxy directly and requires `security.active`.
- Browser actions run in the isolated Playwright executor and require an attached `security_scope`; click/type require `security.active`.
- `egress-proxy` resolves and pins public destinations and blocks loopback, RFC1918/private, link-local, metadata and unsupported ports.
- Ports 3128, 7320, 8080 (SearXNG) and Qwen 8080 are `expose`-only and must not be published to the public host interface.
- Never mount `/var/run/docker.sock` into model or tool containers.

## Lab scope

Network tools are not unlocked by prompt text alone. The Lab run must carry a `security_scope` resource with authorized hosts and capability grants, for example:

```json
{
  "resourceType": "security_scope",
  "capabilities": ["security.passive", "security.active"],
  "metadata": {
    "allowHosts": ["authorized.example.com"],
    "allowIpv4Cidrs": []
  }
}
```

`security.active` exposes active browser actions and `http_request`. Existing `security_scan` operations remain separately capability-gated by the security executor.

## Production web

`system.div3rsa.com` is deployed from `main` through Vercel. Docker services are not hosted on Vercel; run them on the trusted GPU/agent host and keep executor/proxy endpoints private to the Docker network.
