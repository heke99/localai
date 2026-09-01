import { describe, expect, it, vi } from "vitest";
import { CompositeWorkerToolRuntime } from "./composite-tool-runtime";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

const run: ClaimedRun = {
  jobId: "job",
  runId: "run",
  mode: "code",
  modelAlias: "code-prod",
  prompt: "run tool",
  requestId: "request",
  traceId: "trace",
  resourceContext: []
};

function runtime(execute: WorkerToolRuntime["execute"]): WorkerToolRuntime {
  return {
    list: vi.fn(async () => [{
      name: "strict_tool",
      description: "strict",
      inputSchema: {
        type: "object",
        required: ["target"],
        additionalProperties: false,
        properties: { target: { type: "string", minLength: 1 } }
      }
    }]),
    execute
  };
}

describe("CompositeWorkerToolRuntime input gate", () => {
  it("rejects malformed model arguments before an execution grant is claimed", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const claimToolExecution = vi.fn(async () => ({ executionId: "exec", status: "running", executeAllowed: true, replayed: false, attempt: 1 }));
    const composite = new CompositeWorkerToolRuntime([runtime(execute)], {
      isCancellationRequested: async () => false,
      claimToolExecution,
      transitionToolExecution: async () => undefined,
      finalizeCancellation: async () => undefined
    });

    await expect(composite.execute(run, { id: "call", name: "strict_tool", input: {} })).rejects.toThrow("tool_input_invalid:strict_tool:target:required");
    expect(claimToolExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows schema-valid input to proceed through the lifecycle", async () => {
    const execute = vi.fn(async () => ({ ok: true, data: { value: 1 } }));
    const claimToolExecution = vi.fn(async () => ({ executionId: "exec", status: "running", executeAllowed: true, replayed: false, attempt: 1 }));
    const transitionToolExecution = vi.fn(async () => undefined);
    const composite = new CompositeWorkerToolRuntime([runtime(execute)], {
      isCancellationRequested: async () => false,
      claimToolExecution,
      transitionToolExecution,
      finalizeCancellation: async () => undefined
    });

    await expect(composite.execute(run, { id: "call", name: "strict_tool", input: { target: "repo" } })).resolves.toEqual({ ok: true, data: { value: 1 } });
    expect(claimToolExecution).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(transitionToolExecution).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});
