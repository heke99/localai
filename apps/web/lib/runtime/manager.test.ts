import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./manager";
import type {
  EnabledRuntimeProvider,
  RegisteredRuntimeRoute,
  RuntimeAlias,
  RuntimeInstance,
  RuntimeProviderAdapter,
  RuntimeRegistry,
  RuntimeState
} from "./contracts";

class FakeRegistry implements RuntimeRegistry {
  routes: RegisteredRuntimeRoute[] = [];
  providers: EnabledRuntimeProvider[] = [];
  registrations: Array<{ alias: RuntimeAlias; instance: RuntimeInstance }> = [];
  health: Array<{ providerKey: string; externalId: string; state: RuntimeState }> = [];

  async enabledProviders() { return this.providers; }
  async resolve() { return this.routes; }
  async register(alias: RuntimeAlias, instance: RuntimeInstance) {
    this.registrations.push({ alias, instance });
    return "worker-id";
  }
  async markHealth(providerKey: string, externalId: string, state: RuntimeState) {
    this.health.push({ providerKey, externalId, state });
  }
}

function route(providerKey = "runpod"): RegisteredRuntimeRoute {
  return {
    providerKey,
    providerKind: "managed",
    providerPriority: 100,
    workerId: "worker-1",
    externalId: "runtime-1",
    state: "ready",
    endpoint: "https://runtime.example/v1",
    healthUrl: "https://runtime.example/health",
    profile: "large_96gb",
    region: null,
    gpuType: null,
    gpuCount: 2,
    vramTotalBytes: null,
    routePriority: 100,
    routeWeight: 1,
    lastHealthAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {}
  };
}

function adapter(key: string, options: { healthy?: boolean; fail?: boolean; kind?: "managed" | "static"; priority?: number } = {}): RuntimeProviderAdapter {
  return {
    key,
    kind: options.kind ?? "managed",
    defaultPriority: options.priority ?? 100,
    configured: () => true,
    health: vi.fn().mockResolvedValue(options.healthy ?? false),
    ensure: vi.fn().mockImplementation(async (request) => {
      if (options.fail) throw new Error(`${key}_capacity_unavailable`);
      return {
        providerKey: key,
        providerKind: options.kind ?? "managed",
        providerPriority: options.priority ?? 100,
        externalId: `${key}-runtime`,
        profile: request.profile,
        state: "ready",
        endpoint: `https://${key}.example/v1`,
        healthUrl: `https://${key}.example/health`,
        metadata: {}
      } satisfies RuntimeInstance;
    })
  };
}

describe("RuntimeManager", () => {
  it("reuses a healthy registered route without provisioning", async () => {
    const registry = new FakeRegistry();
    registry.routes = [route()];
    const runpod = adapter("runpod", { healthy: true });
    const manager = new RuntimeManager(registry, [runpod], { cacheMs: 0, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const result = await manager.ensure("general-prod");

    expect(result.reused).toBe(true);
    expect(result.instance.externalId).toBe("runtime-1");
    expect(runpod.ensure).not.toHaveBeenCalled();
    expect(registry.health).toContainEqual({ providerKey: "runpod", externalId: "runtime-1", state: "ready" });
  });

  it("fails over to the next configured provider and registers the winner", async () => {
    const registry = new FakeRegistry();
    registry.providers = [
      { key: "runpod", kind: "managed", priority: 100, configuration: {} },
      { key: "generic-openai", kind: "static", priority: 500, configuration: {} }
    ];
    const runpod = adapter("runpod", { fail: true, priority: 100 });
    const generic = adapter("generic-openai", { kind: "static", priority: 500 });
    const manager = new RuntimeManager(registry, [runpod, generic], { cacheMs: 0, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const result = await manager.ensure("general-prod");

    expect(result.instance.providerKey).toBe("generic-openai");
    expect(runpod.ensure).toHaveBeenCalledTimes(1);
    expect(generic.ensure).toHaveBeenCalledTimes(1);
    expect(registry.registrations).toHaveLength(1);
    expect(registry.registrations[0]?.instance.providerKey).toBe("generic-openai");
  });

  it("honors explicit provider order without changing callers", async () => {
    const registry = new FakeRegistry();
    const runpod = adapter("runpod", { priority: 100 });
    const generic = adapter("generic-openai", { kind: "static", priority: 500 });
    const manager = new RuntimeManager(registry, [runpod, generic], {
      providerOrder: ["generic-openai", "runpod"],
      cacheMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    const result = await manager.ensure("code-prod");

    expect(result.instance.providerKey).toBe("generic-openai");
    expect(generic.ensure).toHaveBeenCalledTimes(1);
    expect(runpod.ensure).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent provisioning for the same logical alias", async () => {
    const registry = new FakeRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runpod = adapter("runpod");
    const originalEnsure = runpod.ensure;
    runpod.ensure = vi.fn(async (request) => {
      await gate;
      return originalEnsure(request);
    });
    const manager = new RuntimeManager(registry, [runpod], { cacheMs: 0, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const first = manager.ensure("lab-prod");
    const second = manager.ensure("lab-prod");
    release();
    await Promise.all([first, second]);

    expect(runpod.ensure).toHaveBeenCalledTimes(1);
    expect(registry.registrations).toHaveLength(1);
  });
});
