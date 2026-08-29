import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { CompositeWorkerToolRuntime } from "./composite-tool-runtime";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "run-1",
  mode: "chat",
  modelAlias: "general-prod",
  prompt: "latest news about Iran",
  requestId: "req-1",
  traceId: "trace-1",
  resourceContext: []
};

const webDefinition: ModelToolDefinition = {
  name: "web_search",
  description: "Search current information",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
};

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("CompositeWorkerToolRuntime timeout hardening", () => {
  it("bounds a runtime that hangs while listing tools", async () => {
    vi.useFakeTimers();
    try {
      const hanging: WorkerToolRuntime = {
        list: async () => never<ModelToolDefinition[]>(),
        execute: async () => ({ ok: true })
      };
      const runtime = new CompositeWorkerToolRuntime([hanging], { listTimeoutMs: 25, executeTimeoutMs: 50 });
      const pending = runtime.list(run);
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).rejects.toThrow("tool_runtime_timeout:list:0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a runtime that hangs while executing a tool", async () => {
    vi.useFakeTimers();
    try {
      const hanging: WorkerToolRuntime = {
        list: async () => [webDefinition],
        execute: async () => never<unknown>()
      };
      const runtime = new CompositeWorkerToolRuntime([hanging], { listTimeoutMs: 25, executeTimeoutMs: 50 });
      const pending = runtime.execute(run, { id: "tool-1", name: "web_search", input: { query: "Iran latest news" } });
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).rejects.toThrow("tool_runtime_timeout:execute:web_search");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not change healthy tool execution", async () => {
    const healthy: WorkerToolRuntime = {
      list: async () => [webDefinition],
      execute: async (_run, call) => ({ query: call.input.query, ok: true })
    };
    const runtime = new CompositeWorkerToolRuntime([healthy], { listTimeoutMs: 25, executeTimeoutMs: 50 });
    await expect(runtime.execute(run, { id: "tool-1", name: "web_search", input: { query: "Iran latest news" } }))
      .resolves.toEqual({ query: "Iran latest news", ok: true });
  });
});
