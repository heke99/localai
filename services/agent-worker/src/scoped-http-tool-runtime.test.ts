import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ClaimedRun } from "./processor";
import { ScopedHttpToolRuntime } from "./scoped-http-tool-runtime";

function run(capabilities: string[] = ["security.active"]): ClaimedRun {
  return {
    jobId: "job-http",
    runId: "run-http",
    mode: "lab",
    modelAlias: "lab-prod",
    prompt: "authorized HTTP validation",
    requestId: "req-http",
    traceId: "trace-http",
    resourceContext: [{
      resourceId: "scope-http",
      connectionId: "scope-http",
      provider: "security",
      resourceType: "security_scope",
      externalResourceId: "scope-http",
      displayName: "Authorized target",
      capabilities,
      metadata: { allowHosts: ["example.test"], allowIpv4Cidrs: [] }
    }]
  };
}

async function withProxy(handler: Parameters<typeof createServer>[0], test: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_proxy_address_missing");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("ScopedHttpToolRuntime", () => {
  it("exposes http_request only for active Lab scopes and advertises bounded methods", async () => {
    const runtime = new ScopedHttpToolRuntime({ egressProxyUrl: "http://egress-proxy:3128" });
    const active = await runtime.list(run());
    const passive = await runtime.list(run(["security.passive"]));
    const definition = active.find((tool) => tool.name === "http_request");

    expect(definition).toBeTruthy();
    expect(definition?.inputSchema.properties?.method).toMatchObject({ enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] });
    expect(passive).toEqual([]);
  });

  it("sends an authorized request through the configured egress proxy", async () => {
    await withProxy((request, response) => {
      expect(request.url).toBe("https://example.test/api/check?x=1");
      expect(request.method).toBe("POST");
      expect(request.headers["x-test"]).toBe("yes");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        expect(body).toBe("payload");
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    }, async (proxyUrl) => {
      const runtime = new ScopedHttpToolRuntime({ egressProxyUrl: proxyUrl, resolveHost: async () => ["93.184.216.34"] });
      const output = await runtime.execute(run(), {
        id: "http-1",
        name: "http_request",
        input: { method: "POST", url: "https://example.test/api/check?x=1", headers: { "x-test": "yes" }, body: "payload" }
      }) as Record<string, unknown>;

      expect(output).toMatchObject({ ok: true, status: 200, url: "https://example.test/api/check?x=1" });
      expect(String(output.body)).toContain('"ok":true');
    });
  });

  it("rejects a target outside the attached security scope before proxy execution", async () => {
    let requests = 0;
    await withProxy((_request, response) => { requests += 1; response.end(); }, async (proxyUrl) => {
      const runtime = new ScopedHttpToolRuntime({ egressProxyUrl: proxyUrl, resolveHost: async () => ["93.184.216.34"] });
      await expect(runtime.execute(run(), {
        id: "http-2",
        name: "http_request",
        input: { method: "GET", url: "https://outside.test/" }
      })).rejects.toThrow("http_target_out_of_scope");
      expect(requests).toBe(0);
    });
  });

  it("revalidates redirect destinations and refuses scope expansion", async () => {
    await withProxy((_request, response) => {
      response.writeHead(302, { location: "https://outside.test/next" });
      response.end();
    }, async (proxyUrl) => {
      const runtime = new ScopedHttpToolRuntime({ egressProxyUrl: proxyUrl, resolveHost: async () => ["93.184.216.34"] });
      await expect(runtime.execute(run(), {
        id: "http-3",
        name: "http_request",
        input: { method: "GET", url: "https://example.test/start" }
      })).rejects.toThrow("http_target_out_of_scope");
    });
  });

  it("blocks hop-by-hop/authority headers and oversized bodies", async () => {
    const runtime = new ScopedHttpToolRuntime({ egressProxyUrl: "http://egress-proxy:3128", resolveHost: async () => ["93.184.216.34"] });
    await expect(runtime.execute(run(), {
      id: "http-4",
      name: "http_request",
      input: { method: "POST", url: "https://example.test/", headers: { host: "evil.test" } }
    })).rejects.toThrow("http_header_not_allowed:host");
    await expect(runtime.execute(run(), {
      id: "http-5",
      name: "http_request",
      input: { method: "POST", url: "https://example.test/", body: "x".repeat(65_537) }
    })).rejects.toThrow("http_body_too_large");
  });
});
