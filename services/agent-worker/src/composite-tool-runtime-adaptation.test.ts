import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { CompositeWorkerToolRuntime } from "./composite-tool-runtime";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

const run: ClaimedRun = {
  jobId: "job",
  runId: "run-adaptation",
  mode: "lab",
  modelAlias: "general-prod",
  prompt: "authorized security test",
  requestId: "request",
  traceId: "trace",
  resourceContext: []
};

const definition: ModelToolDefinition = {
  name: "security_scan",
  description: "synthetic",
  inputSchema: { type: "object", additionalProperties: true }
};

function call(id: string, tool: string, target = "example.test", options: Record<string, unknown> = {}): ModelToolCall {
  return { id, name: "security_scan", input: { tool, target, options } };
}

function runtime(execute: WorkerToolRuntime["execute"]): WorkerToolRuntime {
  return { list: async () => [definition], execute };
}

function options() {
  return {
    isCancellationRequested: vi.fn(async () => false),
    claimToolExecution: vi.fn(async (_run: ClaimedRun, toolCall: ModelToolCall) => ({
      executionId: toolCall.id,
      status: "running",
      executeAllowed: true,
      replayed: false,
      attempt: 1
    })),
    transitionToolExecution: vi.fn(async () => undefined),
    finalizeCancellation: vi.fn(async () => undefined)
  };
}

describe("CompositeWorkerToolRuntime adaptation guard", () => {
  it("suppresses a consecutive exact duplicate before the provider executes twice", async () => {
    const execute = vi.fn(async () => ({ ok: true, status: "completed", evidence: { value: "same" } }));
    const lifecycle = options();
    const composite = new CompositeWorkerToolRuntime([runtime(execute)], lifecycle);

    await composite.execute(run, call("one", "http_probe"));
    const duplicate = await composite.execute(run, call("two", "http_probe")) as Record<string, unknown>;

    expect(execute).toHaveBeenCalledOnce();
    expect(duplicate).toMatchObject({
      ok: false,
      status: "blocked",
      duplicateSuppressed: true,
      noProgress: true,
      adaptationRequired: true,
      error: { code: "duplicate_tool_call_suppressed", retryable: false }
    });
    expect(lifecycle.transitionToolExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: "two",
      status: "blocked",
      errorCode: "duplicate_tool_call_suppressed",
      retryable: false
    }));
  });

  it("allows the same check again after an independent intervening operation", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, toolCall: ModelToolCall) => ({
      ok: true,
      status: "completed",
      evidence: { tool: toolCall.input.tool }
    }));
    const composite = new CompositeWorkerToolRuntime([runtime(execute)], options());

    await composite.execute(run, call("one", "http_probe"));
    await composite.execute(run, call("two", "template_scan"));
    await composite.execute(run, call("three", "http_probe"));

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("marks identical material observations from changed inputs as no-progress", async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      status: "completed",
      durationMs: Math.random() * 100,
      auditId: `audit-${Math.random()}`,
      evidence: { status: 200, server: "fixture" }
    }));
    const composite = new CompositeWorkerToolRuntime([runtime(execute)], options());

    await composite.execute(run, call("one", "content_discovery", "example.test", { rateLimit: 5 }));
    const second = await composite.execute(run, call("two", "content_discovery", "example.test", { rateLimit: 10 })) as Record<string, unknown>;

    expect(execute).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ noProgress: true, adaptationRequired: true });
  });
});
