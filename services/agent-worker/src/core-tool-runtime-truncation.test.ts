import { describe, expect, it, vi } from "vitest";
import type { ClaimedRun } from "./processor";
import { CoreToolRuntime } from "./core-tool-runtime";

const run: ClaimedRun = {
  jobId: "job",
  runId: "run",
  mode: "research",
  modelAlias: "research-prod",
  prompt: "current information",
  requestId: "request",
  traceId: "trace",
  resourceContext: []
};

describe("CoreToolRuntime bounded large-page fetch", () => {
  it("returns a bounded truncated prefix instead of rejecting a large readable public page", async () => {
    const useful = "Den generella momssatsen är 25 procent.";
    const largeHtml = `<html><head><title>Momssatser</title></head><body><main><p>${useful}</p>${"<p>navigation and boilerplate</p>".repeat(2000)}</main></body></html>`;
    const fetcher = vi.fn(async () => new Response(largeHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(new TextEncoder().encode(largeHtml).byteLength)
      }
    }));
    const runtime = new CoreToolRuntime({
      fetcher: fetcher as typeof fetch,
      resolveHost: async () => ["93.184.216.34"],
      maxFetchBytes: 16_384
    });

    const result = await runtime.execute(run, {
      id: "fetch-large",
      name: "web_fetch",
      input: { url: "https://www.skatteverket.se/foretag/moms/momssatser.html" }
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      url: "https://www.skatteverket.se/foretag/moms/momssatser.html",
      title: "Momssatser",
      contentType: "text/html",
      truncated: true
    });
    expect(Number(result.bytes)).toBeLessThanOrEqual(16_384);
    expect(Number(result.declaredBytes)).toBeGreaterThan(16_384);
    expect(String(result.text)).toContain(useful);
  });
});
