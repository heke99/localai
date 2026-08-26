import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredRuntimeRoute, RuntimeBootstrapIssuer } from "../contracts";
import { HyperstackRuntimeProvider } from "./hyperstack";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function configure() {
  process.env.HYPERSTACK_API_KEY = "test-key";
  process.env.HYPERSTACK_ENVIRONMENT_NAME = "prod-CANADA-1";
  process.env.HYPERSTACK_KEY_NAME = "runtime-key";
  process.env.HYPERSTACK_REGION = "CANADA-1";
  process.env.HYPERSTACK_GPU_FLAVORS = "n3-L40x2,n3-RTX-A6000x2";
  process.env.HYPERSTACK_RUNTIME_PUBLIC_HOST_SUFFIX = "sslip.io";
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function issuer(): RuntimeBootstrapIssuer {
  return {
    issue: vi.fn().mockResolvedValue({
      token: "short-lived-bootstrap-token",
      bootstrapUrl: "https://system.div3rsa.com/api/internal/runtime/bootstrap",
      expiresInSeconds: 1800
    })
  };
}

function route(overrides: Partial<RegisteredRuntimeRoute> = {}): RegisteredRuntimeRoute {
  return {
    providerKey: "hyperstack",
    providerKind: "managed",
    providerPriority: 200,
    workerId: "worker-1",
    externalId: "div3rsa-general-test",
    state: "warming",
    endpoint: "https://runtime-pending.invalid/v1",
    healthUrl: null,
    profile: "large_96gb",
    region: "CANADA-1",
    gpuType: "L40",
    gpuCount: 2,
    vramTotalBytes: null,
    routePriority: 100,
    routeWeight: 1,
    lastHealthAt: null,
    updatedAt: new Date().toISOString(),
    metadata: { vmId: 123 },
    ...overrides
  };
}

describe("HyperstackRuntimeProvider", () => {
  it("is inert until server-only provider credentials are configured", () => {
    delete process.env.HYPERSTACK_API_KEY;
    delete process.env.HYPERSTACK_ENVIRONMENT_NAME;
    delete process.env.HYPERSTACK_KEY_NAME;
    expect(new HyperstackRuntimeProvider(issuer(), vi.fn() as unknown as typeof fetch).configured()).toBe(false);
  });

  it("selects available preferred capacity and provisions with only a short-lived bootstrap token", async () => {
    configure();
    let createBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/core/flavors")) {
        return jsonResponse({ flavors: [
          { name: "n3-L40x2", region_name: "CANADA-1", gpu: "L40", gpu_count: 2, stock_available: true }
        ] });
      }
      if (url.endsWith("/core/virtual-machines") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createBody = body;
        return jsonResponse({ instances: [{
          id: 123,
          name: body.name,
          status: "CREATING",
          environment: { region: "CANADA-1" },
          flavor: { name: "n3-L40x2", gpu: "L40", gpu_count: 2 }
        }] });
      }
      throw new Error(`unexpected:${url}`);
    });
    const bootstrapIssuer = issuer();
    const provider = new HyperstackRuntimeProvider(bootstrapIssuer, fetchMock as unknown as typeof fetch);

    const result = await provider.ensure({ alias: "general-prod", profile: "large_96gb", preferred: null });
    const body = createBody as unknown as Record<string, unknown>;

    expect(result.state).toBe("provisioning");
    expect(result.metadata?.vmId).toBe(123);
    expect(result.gpuType).toBe("L40");
    expect(result.gpuCount).toBe(2);
    expect(bootstrapIssuer.issue).toHaveBeenCalledTimes(1);
    expect(body.flavor_name).toBe("n3-L40x2");
    expect(body.assign_floating_ip).toBe(true);
    const rules = body.security_rules as Array<Record<string, unknown>>;
    expect(rules.map((rule) => rule.port_range_min)).toEqual([80, 443]);
    const userData = String(body.user_data ?? "");
    expect(userData).toContain("short-lived-bootstrap-token");
    expect(userData).toContain("/api/internal/runtime/bootstrap");
    expect(userData).not.toContain("SUPABASE_SECRET_KEY");
    expect(userData).not.toContain("DIV3RSA_INFERENCE_API_KEY");
  });

  it("starts an existing stopped VM instead of provisioning a duplicate", async () => {
    configure();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/core/virtual-machines/123")) {
        return jsonResponse({ instance: {
          id: 123,
          name: "div3rsa-general-test",
          status: "SHUTOFF",
          environment: { region: "CANADA-1" },
          flavor: { name: "n3-L40x2", gpu: "L40", gpu_count: 2 }
        } });
      }
      if (url.endsWith("/core/virtual-machines/123/start")) return jsonResponse({ status: true });
      throw new Error(`unexpected:${url}`);
    });
    const provider = new HyperstackRuntimeProvider(issuer(), fetchMock as unknown as typeof fetch);

    const result = await provider.ensure({ alias: "general-prod", profile: "large_96gb", preferred: route() });

    expect(result.state).toBe("warming");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves a healthy active VM through the provider-neutral HTTPS runtime contract", async () => {
    configure();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/core/virtual-machines/123")) {
        return jsonResponse({ instance: {
          id: 123,
          name: "div3rsa-general-test",
          status: "ACTIVE",
          floating_ip: "203.0.113.42",
          environment: { region: "CANADA-1" },
          flavor: { name: "n3-L40x2", gpu: "L40", gpu_count: 2 }
        } });
      }
      if (url === "https://203-0-113-42.sslip.io/health") return new Response("ok", { status: 200 });
      throw new Error(`unexpected:${url}`);
    });
    const provider = new HyperstackRuntimeProvider(issuer(), fetchMock as unknown as typeof fetch);

    const result = await provider.ensure({ alias: "general-prod", profile: "large_96gb", preferred: route() });

    expect(result.state).toBe("ready");
    expect(result.endpoint).toBe("https://203-0-113-42.sslip.io/v1");
    expect(result.healthUrl).toBe("https://203-0-113-42.sslip.io/health");
  });
});
