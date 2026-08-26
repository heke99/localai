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
      gpuCount: 2
    });
    expect(config?.aliases).toEqual(["general-prod", "code-prod", "lab-prod", "research-prod"]);
  });

  it("registers all supported aliases then heartbeats the physical runtime", async () => {
    process.env.DIV3RSA_RUNTIME_PROVIDER = "provider-x";
    process.env.DIV3RSA_RUNTIME_PROVIDER_KIND = "static";
    process.env.DIV3RSA_RUNTIME_EXTERNAL_ID = "runtime-x";
    process.env.DIV3RSA_RUNTIME_PUBLIC_ENDPOINT = "https://runtime.example/v1";
    process.env.DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL = "https://runtime.example/health";
    process.env.DIV3RSA_RUNTIME_ALIASES = "general-prod,code-prod";
    const config = runtimeRegistrationConfigFromEnvironment(8080)!;
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({ data: name === "runtime_worker_heartbeat" ? true : "worker-db-id", error: null }));
    const registration = new RuntimeRegistration({ rpc } as unknown as RuntimeRpcClient, config, "agent-worker-x");

    await expect(registration.sync()).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe("runtime_register_worker");
    expect(rpc.mock.calls[1]?.[0]).toBe("runtime_register_worker");
    expect(rpc.mock.calls[2]?.[0]).toBe("runtime_worker_heartbeat");
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ target_model_alias: "general-prod", target_state: "ready" }));
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
