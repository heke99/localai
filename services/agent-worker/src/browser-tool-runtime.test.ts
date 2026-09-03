import { describe, expect, it } from "vitest";
import type { ClaimedRun } from "./processor";
import { BrowserToolRuntime } from "./browser-tool-runtime";

function run(capabilities: string[], mode: ClaimedRun["mode"] = "lab"): ClaimedRun {
  return {
    jobId: "job-1",
    runId: "run-1",
    mode,
    modelAlias: "lab-prod",
    prompt: "inspect authorized target",
    requestId: "req-1",
    traceId: "trace-1",
    resourceContext: [{
      resourceId: "scope-1",
      connectionId: "conn-1",
      provider: "security",
      resourceType: "security_scope",
      externalResourceId: "scope-1",
      displayName: "Authorized target",
      capabilities,
      metadata: { allowHosts: ["Example.Test"], allowIpv4Cidrs: ["203.0.113.0/24"] }
    }]
  };
}

describe("BrowserToolRuntime", () => {
  it("stays hidden when executor configuration is absent", async () => {
    const runtime = new BrowserToolRuntime();
    expect(await runtime.list(run(["security.active"]))).toEqual([]);
  });

  it("exposes only passive browser tools for security.passive", async () => {
    const runtime = new BrowserToolRuntime({ endpoint: "http://browser:7320", bearerToken: "token" });
    expect((await runtime.list(run(["security.passive"]))).map((tool) => tool.name)).toEqual([
      "browser_navigate", "browser_read", "browser_screenshot"
    ]);
  });

  it("exposes active interaction tools only for security.active", async () => {
    const runtime = new BrowserToolRuntime({ endpoint: "http://browser:7320", bearerToken: "token" });
    expect((await runtime.list(run(["security.active"]))).map((tool) => tool.name)).toEqual([
      "browser_navigate", "browser_read", "browser_screenshot", "browser_click", "browser_type"
    ]);
    expect(await runtime.list(run(["security.active"], "chat"))).toEqual([]);
  });

  it("forwards the normalized run scope and bearer token to the isolated executor", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = new BrowserToolRuntime({
      endpoint: "http://browser:7320",
      bearerToken: "secret",
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, action: "browser_navigate" }), { status: 200 });
      }
    });

    const result = await runtime.execute(run(["security.active"]), {
      id: "call-1",
      name: "browser_navigate",
      input: { url: "https://example.test" }
    });

    expect(result).toEqual({ ok: true, action: "browser_navigate" });
    expect(requests[0]?.url).toBe("http://browser:7320/v1/execute");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.scope).toEqual({ scopeId: "scope-1", allowHosts: ["example.test"], allowIpv4Cidrs: ["203.0.113.0/24"] });
    expect(body.executionClass).toBe("passive");
  });

  it("rejects active browser calls when the run is passive-only", async () => {
    const runtime = new BrowserToolRuntime({ endpoint: "http://browser:7320", bearerToken: "token", fetcher: async () => new Response("{}") });
    await expect(runtime.execute(run(["security.passive"]), { id: "call-1", name: "browser_click", input: { selector: "button" } }))
      .rejects.toThrow("browser_tool_not_allowed:browser_click");
  });
});
