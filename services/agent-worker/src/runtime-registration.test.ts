import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeRegistration, runtimeRegistrationConfigFromEnvironment, type RuntimeRpcClient } from "./runtime-registration";

const keys = [
  "RUNPOD_POD_ID",
  "DIV3RSA_RUNTIME_PROVIDER",
  "DIV3RSA_RUNTIME_PROVIDER_KIND",
  "DIV3RSA_RUNTIME_PROVIDER_PRIORITY",
  "DIV3RSA_RUNTIME_EXTERNAL_ID",
  "DIV3RSA_RUNTIME_PUBLIC_ENDPOINT",
  "DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL",
  "DIV3RSA_RUNTIME_PROFILE",
  "DIV3RSA_RUNTIME_ALIASES",
  "DIV3RSA_RUNTIME_GPU_COUNT",
  "DIV3RSA_RUNTIME_VRAM_GB",
  "DIV3RSA_RUNTIME_ROLE",
  "DIV3RSA_INFERENCE_PROTOCOL",
  "DIV3RSA_INFERENCE_MODEL_VERSION_ID",
  "RUNPOD_FAILOVER_GPU_COUNT"
] as const;
const originals = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = originals[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("runtime registration", () => {
  it("derives the standardized runtime identity from Runpod system metadata", () => {
    process.env.RUNPOD_POD_ID = "pod-123";
    process.env.RUNPOD_FAILOVER_GPU_COUNT = "2";
    const config = runtimeRegistrationConfigFromEnvironment(8080);

    expect(config).toMatchObject({
      providerKey: "runpod",
      providerKind: "managed",
      providerPriority: 100,
      externalId: "pod-123",
      endpoint: "https://pod-123-8080.proxy.runpod.net/v1",
      healthUrl: "https://pod-123-8080.proxy.runpod.net/health",
      profile: "large_96gb",
      gpuCount: 2,
      runtimeRole: "combined",
      inferenceProtocol: "qwen-llamacpp"
    });
    expect(config?.aliases).toEqual(["general-prod", "code-prod", "lab-prod", "research-prod"]);
  });

  it("registers all supported aliases with the model protocol contract then heartbeats the physical runtime", async () => {
    process.env.DIV3RSA_RUNTIME_PROVIDER = "provider-x";
    process.env.DIV3RSA_RUNTIME_PROVIDER_KIND = "static";
    process.env.DIV3RSA_RUNTIME_EXTERNAL_ID = "runtime-x";
    process.env.DIV3RSA_RUNTIME_PUBLIC_ENDPOINT = "https://runtime.example/v1";
    process.env.DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL = "https://runtime.example/health";
    process.env.DIV3RSA_RUNTIME_ALIASES = "general-prod,code-prod";
    process.env.DIV3RSA_INFERENCE_PROTOCOL = "generic-openai";
    process.env.DIV3RSA_INFERENCE_MODEL_VERSION_ID = "replacement-v1";
    const config = runtimeRegistrationConfigFromEnvironment(8080)!;
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({ data: name === "runtime_worker_heartbeat" ? true : "worker-db-id", error: null }));
    const registration = new RuntimeRegistration({ rpc } as unknown as RuntimeRpcClient, config, "agent-worker-x");

    await expect(registration.sync()).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe("runtime_register_worker");
    expect(rpc.mock.calls[1]?.[0]).toBe("runtime_register_worker");
    expect(rpc.mock.calls[2]?.[0]).toBe("runtime_worker_heartbeat");
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ target_model_alias: "general-prod", target_state: "ready" }));
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      target_metadata: expect.objectContaining({
        runtimeRole: "combined",
        source: "agent-worker",
        modelProtocolContractVersion: 1,
        inferenceProtocol: "generic-openai",
        modelVersionId: "replacement-v1"
      })
    }));
  });

  it("registers inference-only nodes without pretending the registrar is an agent worker", async () => {
    process.env.DIV3RSA_RUNTIME_PROVIDER = "gpuhub";
    process.env.DIV3RSA_RUNTIME_PROVIDER_KIND = "static";
    process.env.DIV3RSA_RUNTIME_EXTERNAL_ID = "gpu-1";
    process.env.DIV3RSA_RUNTIME_PUBLIC_ENDPOINT = "https://gpu.example/v1";
    process.env.DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL = "https://gpu.example/health";
    process.env.DIV3RSA_RUNTIME_ALIASES = "general-prod";
    process.env.DIV3RSA_RUNTIME_ROLE = "inference";
    const config = runtimeRegistrationConfigFromEnvironment(8080)!;
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({ data: name === "runtime_worker_heartbeat" || name === "runtime_mark_worker_health" ? true : "worker-db-id", error: null }));
    const registration = new RuntimeRegistration({ rpc } as unknown as RuntimeRpcClient, config, "registrar-1");

    expect(config.runtimeRole).toBe("inference");
    await expect(registration.sync()).resolves.toBe(true);
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      target_state: "ready",
      target_metadata: expect.objectContaining({ source: "inference-node-registrar", runtimeRole: "inference", modelProtocolContractVersion: 1 })
    }));

    await expect(registration.drain("planned_maintenance")).resolves.toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("runtime_mark_worker_health", expect.objectContaining({
      target_state: "draining",
      target_metadata: expect.objectContaining({ drainReason: "planned_maintenance", runtimeRole: "inference" })
    }));
  });

  it("retries registration after a rollout where the RPC is not installed yet", async () => {
    process.env.DIV3RSA_RUNTIME_PROVIDER = "provider-x";
    process.env.DIV3RSA_RUNTIME_EXTERNAL_ID = "runtime-x";
    process.env.DIV3RSA_RUNTIME_PUBLIC_ENDPOINT = "https://runtime.example/v1";
    process.env.DIV3RSA_RUNTIME_ALIASES = "general-prod";
    const config = runtimeRegistrationConfigFromEnvironment(8080)!;
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })
      .mockResolvedValueOnce({ data: "worker-db-id", error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const registration = new RuntimeRegistration({ rpc } as unknown as RuntimeRpcClient, config, "agent-worker-x");

    await expect(registration.sync()).resolves.toBe(false);
    await expect(registration.sync()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
