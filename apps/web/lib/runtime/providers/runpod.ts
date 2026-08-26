import { ensureRunpodRuntimeAwake } from "../../runpod/runtime";
import type { RegisteredRuntimeRoute, RuntimeEnsureRequest, RuntimeInstance, RuntimeProviderAdapter, RuntimeState } from "../contracts";

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function healthUrlForPod(podId: string) {
  const primaryId = process.env.RUNPOD_POD_ID?.trim();
  const configuredHealth = process.env.RUNPOD_RUNTIME_HEALTH_URL?.trim();
  if (primaryId === podId && configuredHealth) return configuredHealth;
  const port = positiveInteger(process.env.RUNPOD_RUNTIME_HEALTH_PORT, 8080);
  const pathValue = process.env.RUNPOD_RUNTIME_HEALTH_PATH?.trim() || "/health";
  const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  return `https://${podId}-${port}.proxy.runpod.net${path}`;
}

function inferenceEndpointForPod(podId: string) {
  const port = positiveInteger(process.env.DIV3RSA_MODEL_PORT, 8080);
  return `https://${podId}-${port}.proxy.runpod.net/v1`;
}

function workerState(state: string): RuntimeState {
  return state === "healthy" ? "ready" : "warming";
}

async function healthy(url: string) {
  try {
    const timeout = positiveInteger(process.env.RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS, 2000);
    const response = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(timeout) });
    return response.ok;
  } catch {
    return false;
  }
}

export class RunpodRuntimeProvider implements RuntimeProviderAdapter {
  readonly key = "runpod";
  readonly kind = "managed" as const;
  readonly defaultPriority = 100;

  configured() {
    return Boolean(process.env.RUNPOD_API_KEY?.trim() && process.env.RUNPOD_POD_ID?.trim());
  }

  async health(route: RegisteredRuntimeRoute) {
    return healthy(route.healthUrl || healthUrlForPod(route.externalId));
  }

  async ensure(request: RuntimeEnsureRequest): Promise<RuntimeInstance> {
    if (!this.configured()) throw new Error("runpod_unconfigured");
    const wake = await ensureRunpodRuntimeAwake();
    if (!wake.configured || !wake.podId) throw new Error("runpod_runtime_unavailable");

    const gpuCount = process.env.RUNPOD_FAILOVER_GPU_COUNT?.trim();
    return {
      providerKey: this.key,
      providerKind: this.kind,
      providerPriority: this.defaultPriority,
      externalId: wake.podId,
      profile: request.profile,
      state: workerState(wake.state),
      endpoint: inferenceEndpointForPod(wake.podId),
      healthUrl: healthUrlForPod(wake.podId),
      gpuCount: gpuCount && Number.isInteger(Number(gpuCount)) ? Number(gpuCount) : null,
      routePriority: 100,
      metadata: {
        replacement: Boolean(wake.replacement),
        desiredStatus: wake.desiredStatus ?? null,
        wakeState: wake.state
      }
    };
  }
}
