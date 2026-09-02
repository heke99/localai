import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter } from "@div3rsa/model-sdk";
import { RuntimeInferenceRouter, type RuntimeInferenceRpcClient } from "./runtime-inference-router";

const request: GenerateRequest = { requestId: "req-1", alias: "general-prod", messages: [{ role: "user", content: "hello" }] };

function rpcClient(rows: Array<Record<string, unknown>>) {
  const rpc = vi.fn(async <T>(name: string, _args: Record<string, unknown>) => {
    if (name === "runtime_resolve_model_routes") return { data: rows as T, error: null };
    return { data: true as T, error: null };
  });
  return { client: { rpc } as RuntimeInferenceRpcClient, rpc };
}

function adapter(endpoint: string, calls: string[], mode: "fail" | "ok" | "stream-fail-after-delta" = "ok"): ModelAdapter {
  return {
    getCapabilities: () => new Set(["general"]),
    estimateTokens: async () => 1,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    generate: async () => {
      calls.push(endpoint);
      if (mode === "fail") throw new Error("node_down");
      return { modelVersionId: "m", content: endpoint, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    },
    generateStreamed: async (_request, onDelta) => {
      calls.push(endpoint);
      if (mode === "fail") throw new Error("node_down");
      if (mode === "stream-fail-after-delta") {
        await onDelta("partial");
        throw new Error("mid_stream_failure");
      }
      await onDelta(endpoint);
      return { modelVersionId: "m", content: endpoint, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    },
    async *stream() { yield endpoint; }
  };
}

function scriptedAdapter(results: GenerateResult[], requests: GenerateRequest[]): ModelAdapter {
  return {
    getCapabilities: () => new Set(["general", "tool_use"]),
    estimateTokens: async () => 1,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    generate: async (input) => {
      requests.push(input);
      const next = results.shift();
      if (!next) throw new Error("unexpected_model_call");
      return next;
    },
    async *stream() { yield "unused"; }
  };
}

const rows = [
  { provider_key: "primary", external_worker_id: "gpu-a", worker_state: "ready", endpoint: "https://gpu-a.example/v1", health_url: "https://gpu-a.example/health", route_priority: 10, provider_priority: 10 },
  { provider_key: "standby", external_worker_id: "gpu-b", worker_state: "ready", endpoint: "https://gpu-b.example/v1", health_url: "https://gpu-b.example/health", route_priority: 20, provider_priority: 20 }
];

const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };

describe("RuntimeInferenceRouter", () => {
  it("uses route priority and fails over before a response is emitted", async () => {
    const { client, rpc } = rpcClient(rows);
    const calls: string[] = [];
    const router = new RuntimeInferenceRouter(client, "key", fetch, (endpoint) => adapter(endpoint, calls, endpoint.includes("gpu-a") ? "fail" : "ok"));
    const result = await router.generate(request);
    expect(result.content).toContain("gpu-b");
    expect(calls).toEqual(["https://gpu-a.example/v1", "https://gpu-b.example/v1"]);
    expect(rpc).toHaveBeenCalledWith("runtime_mark_worker_health", expect.objectContaining({ target_provider_key: "primary", target_state: "failed" }));
  });

  it("fails closed rather than duplicating a stream after visible output", async () => {
    const { client } = rpcClient(rows);
    const calls: string[] = [];
    const router = new RuntimeInferenceRouter(client, "key", fetch, (endpoint) => adapter(endpoint, calls, endpoint.includes("gpu-a") ? "stream-fail-after-delta" : "ok"));
    const deltas: string[] = [];
    await expect(router.generateStreamed!(request, (delta) => { deltas.push(delta); })).rejects.toThrow("mid_stream_failure");
    expect(deltas).toEqual(["partial"]);
    expect(calls).toEqual(["https://gpu-a.example/v1"]);
  });

  it("recovers a textual curl attempt into a structured tool call before anything is streamed", async () => {
    const { client } = rpcClient([rows[0]!]);
    const requests: GenerateRequest[] = [];
    const runtimeModel = scriptedAdapter([
      { modelVersionId: "m", content: "Jag behöver bekräfta live.\n```bash\ncurl https://example.test\n```", finishReason: "stop", usage },
      { modelVersionId: "m", content: "", finishReason: "tool_call", toolCalls: [{ id: "call-1", name: "security_scan", input: { tool: "http_probe", target: "https://example.test" } }], usage }
    ], requests);
    const router = new RuntimeInferenceRouter(client, "key", fetch, () => runtimeModel);
    const deltas: string[] = [];
    const result = await router.generateStreamed!({
      ...request,
      tools: [{ name: "security_scan", description: "Authorized security checks", inputSchema: { type: "object" } }]
    }, (delta) => { deltas.push(delta); });

    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls?.[0]?.name).toBe("security_scan");
    expect(deltas).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain("Runtime recovery");
  });

  it("returns TOOL_UNAVAILABLE guidance when execution is implied but no tools are exposed", async () => {
    const { client } = rpcClient([rows[0]!]);
    const requests: GenerateRequest[] = [];
    const runtimeModel = scriptedAdapter([
      { modelVersionId: "m", content: "I need to verify this live.\n```bash\ncurl https://example.test\n```", finishReason: "stop", usage },
      { modelVersionId: "m", content: "TOOL_UNAVAILABLE: I cannot execute that request in this run.", finishReason: "stop", usage }
    ], requests);
    const router = new RuntimeInferenceRouter(client, "key", fetch, () => runtimeModel);
    const result = await router.generate({ ...request, tools: [] });

    expect(result.content).toContain("TOOL_UNAVAILABLE");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain("no execution tools");
  });

  it("ignores non-ready and unsafe routes", async () => {
    const { client } = rpcClient([
      { ...rows[0], worker_state: "draining" },
      { ...rows[1], endpoint: "http://remote-insecure.example/v1" }
    ]);
    const router = new RuntimeInferenceRouter(client, "key", fetch, () => adapter("unused", []));
    await expect(router.generate(request)).rejects.toThrow("runtime_inference_route_unavailable");
  });

  it("reaps stale registry workers before resolving traffic", async () => {
    const { client, rpc } = rpcClient(rows);
    const router = new RuntimeInferenceRouter(client, "key", fetch, (endpoint) => adapter(endpoint, []), { staleSeconds: 90, reapIntervalMs: 30_000 });
    await router.generate(request);
    expect(rpc.mock.calls[0]?.[0]).toBe("runtime_reap_stale_workers");
    expect(rpc.mock.calls[0]?.[1]).toEqual({ target_stale_seconds: 90 });
  });

  it("marks a failed primary health probe and continues to healthy standby", async () => {
    const { client, rpc } = rpcClient(rows);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response("", { status: String(input).includes("gpu-a") ? 503 : 200 })) as typeof fetch;
    const router = new RuntimeInferenceRouter(client, "key", fetcher, (endpoint) => adapter(endpoint, []));
    const health = await router.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toBe("standby:gpu-b");
    expect(rpc).toHaveBeenCalledWith("runtime_mark_worker_health", expect.objectContaining({
      target_provider_key: "primary",
      target_external_worker_id: "gpu-a",
      target_state: "failed",
      target_last_error_code: "health_http_503"
    }));
  });
});
