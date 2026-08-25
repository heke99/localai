import { afterEach, describe, expect, it, vi } from "vitest";

const managedEnvironment = [
  "RUNPOD_API_KEY",
  "RUNPOD_POD_ID",
  "RUNPOD_RUNTIME_HEALTH_URL",
  "RUNPOD_RESTART_UNHEALTHY",
  "RUNPOD_API_TIMEOUT_MS",
  "RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS",
  "RUNPOD_RUNTIME_RUNNING_CACHE_MS",
  "RUNPOD_RUNTIME_RESTART_GRACE_MS"
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

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "healthy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts a stopped Pod after the runtime health check fails", async () => {
    configure();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "EXITED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "starting", desiredStatus: "RUNNING" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://rest.runpod.io/v1/pods/pod-test/start", expect.objectContaining({ method: "POST" }));
  });

  it("restarts a stale running Pod when runtime health is down and restart is enabled", async () => {
    configure();
    process.env.RUNPOD_RESTART_UNHEALTHY = "1";
    process.env.RUNPOD_RUNTIME_RESTART_GRACE_MS = "1000";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING", lastStartedAt: "2020-01-01T00:00:00.000Z" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pod-test", desiredStatus: "RUNNING" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureRunpodRuntimeAwake } = await import("./runtime");

    await expect(ensureRunpodRuntimeAwake()).resolves.toMatchObject({ configured: true, state: "restarting" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://rest.runpod.io/v1/pods/pod-test/restart", expect.objectContaining({ method: "POST" }));
  });
});
