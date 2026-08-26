import { afterEach, describe, expect, it, vi } from "vitest";

const managedEnvironment = [
  "RUNPOD_API_KEY",
  "RUNPOD_POD_ID",
  "RUNPOD_RUNTIME_HEALTH_URL",
  "RUNPOD_RUNTIME_HEALTH_PORT",
  "RUNPOD_RUNTIME_HEALTH_PATH",
  "RUNPOD_RESTART_UNHEALTHY",
  "RUNPOD_AUTO_REPLACE_UNAVAILABLE",
  "RUNPOD_NETWORK_VOLUME_ID",
  "RUNPOD_FAILOVER_TEMPLATE_ID",
  "RUNPOD_FAILOVER_GPU_COUNT",
  "RUNPOD_FAILOVER_GPU_TYPE_IDS",
  "RUNPOD_RUNTIME_FAMILY_NAME",
  "RUNPOD_API_TIMEOUT_MS",
  "RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS",
  "RUNPOD_RUNTIME_RUNNING_CACHE_MS",
  "RUNPOD_RUNTIME_RESTART_GRACE_MS",
  "RUNPOD_START_ATTEMPTS",
  "RUNPOD_START_RETRY_BASE_MS",
  "RUNPOD_GRAPHQL_API_URL"
] as const;

const originalEnvironment = Object.fromEntries(managedEnvironment.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of managedEnvironment) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

function configure() {
  process.env.RUNPOD_API_KEY = "test-key";
  process.env.RUNPOD_POD_ID = "pod-test";
  process.env.RUNPOD_RUNTIME_HEALTH_URL = "https://runtime.example/health";
  process.env.RUNPOD_RUNTIME_RUNNING_CACHE_MS = "0";
}

function stoppedSourcePod() {
  return {
    id: "pod-test",
    name: "localai-production",
    desiredStatus: "EXITED",
    image: "runpod/pytorch:test",
    containerDiskInGb: 50,
    dockerEntrypoint: [],
    dockerStartCmd: ["bash", "/workspace/localai-app/infra/runpod/auto-start.sh"],
    env: { TEST_ENV: "value" },
    gpu: { id: "NVIDIA L40S", count: 2 },
    machine: { gpuTypeId: "NVIDIA L40S", dataCenterId: "EU-SE-1", supportPublicIp: true },
    networkVolume: { id: "volume-test", dataCenterId: "EU-SE-1", name: "localai" },
    ports: ["8080/http", "22/tcp"],
    volumeMountPath: "/workspace"
  };
}

describe("ensureRunpodRuntimeAwake", () => {
  it("degrades safely when wake-on-demand is not configured", async () => {
    delete process.env.RUNPOD_API_KEY;
    delete process.env.RUNPOD_POD_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toEqual({ configured: false, state: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns healthy without calling the RunPod control API", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "healthy", podId: "pod-test", replacement: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts a stopped Pod after the runtime health check fails", async () => {
    configure();
    process.env.RUNPOD_AUTO_REPLACE_UNAVAILABLE = "0";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "starting", desiredStatus: "RUNNING", podId: "pod-test" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://rest.runpod.io/v1/pods/pod-test/start", expect.objectContaining({ method: "POST" }));
  });

  it("accepts a control-plane 5xx when the Pod actually reached RUNNING", async () => {
    configure();
    process.env.RUNPOD_AUTO_REPLACE_UNAVAILABLE = "0";
    process.env.RUNPOD_START_ATTEMPTS = "2";
    process.env.RUNPOD_START_RETRY_BASE_MS = "0";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("internal", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "starting" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to GraphQL podResume after retryable REST start failures using the Pod GPU count", async () => {
    configure();
    process.env.RUNPOD_AUTO_REPLACE_UNAVAILABLE = "0";
    process.env.RUNPOD_START_ATTEMPTS = "2";
    process.env.RUNPOD_START_RETRY_BASE_MS = "0";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED", gpu: { id: "NVIDIA L40S", count: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("internal", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED", gpu: { count: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("internal", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED", gpu: { count: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { podResume: { id: "pod-test", desiredStatus: "RUNNING" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "starting", desiredStatus: "RUNNING" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      "https://api.runpod.io/graphql?api_key=test-key",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("gpuCount: 2")
      })
    );
  });

  it("uses an already-created managed replacement instead of retrying the unavailable primary Pod", async () => {
    configure();
    const source = stoppedSourcePod();
    const replacement = {
      ...source,
      id: "pod-replacement",
      name: "localai-production-failover-abc",
      desiredStatus: "RUNNING",
      lastStartedAt: new Date().toISOString()
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([source, replacement]), { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({
      configured: true,
      state: "healthy",
      podId: "pod-replacement",
      replacement: true
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://pod-replacement-8080.proxy.runpod.net/health",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("creates a replacement Pod on the same network volume after resume fails for capacity", async () => {
    configure();
    process.env.RUNPOD_START_ATTEMPTS = "1";
    process.env.RUNPOD_START_RETRY_BASE_MS = "0";
    const source = stoppedSourcePod();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([source]), { status: 200 }))
      .mockResolvedValueOnce(new Response("capacity", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "No GPU available" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([source]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-new", desiredStatus: "RUNNING" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({
      configured: true,
      state: "replacing",
      podId: "pod-new",
      replacement: true
    });

    const createCall = fetchMock.mock.calls[8];
    expect(createCall?.[0]).toBe("https://rest.runpod.io/v1/pods");
    expect(createCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String((createCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      cloudType: "SECURE",
      gpuCount: 2,
      networkVolumeId: "volume-test",
      dataCenterIds: ["EU-SE-1"],
      imageName: "runpod/pytorch:test"
    });
    expect(body.gpuTypeIds).toEqual(expect.arrayContaining([
      "NVIDIA L40S",
      "NVIDIA L40",
      "NVIDIA RTX A6000",
      "NVIDIA A40",
      "NVIDIA RTX 6000 Ada Generation"
    ]));
  });

  it("replaces a RUNNING Pod that Runpod explicitly reports with zero GPUs", async () => {
    configure();
    const source = { ...stoppedSourcePod(), desiredStatus: "RUNNING", gpu: { id: "NVIDIA L40S", count: 0 } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([source]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-new", desiredStatus: "RUNNING" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ state: "replacing", podId: "pod-new", replacement: true });
  });

  it("restarts a stale running Pod when runtime health is down and restart is enabled", async () => {
    configure();
    process.env.RUNPOD_RESTART_UNHEALTHY = "1";
    process.env.RUNPOD_RUNTIME_RESTART_GRACE_MS = "1000";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING", lastStartedAt: "2020-01-01T00:00:00.000Z", gpu: { count: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "restarting" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://rest.runpod.io/v1/pods/pod-test/restart", expect.objectContaining({ method: "POST" }));
  });
});
