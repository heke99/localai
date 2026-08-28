import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import type { ClaimedRun } from "./processor";
import { SupabaseAgentQueue } from "./supabase-queue";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "run-1",
  mode: "chat",
  modelAlias: "general-prod",
  prompt: "hello",
  requestId: "request-1",
  traceId: "trace-1",
  resourceContext: []
};

type RpcResult = { data: unknown; error: { message: string } | null };

function queueWith(rpc: ReturnType<typeof vi.fn>) {
  return new SupabaseAgentQueue({ rpc } as unknown as SupabaseClient<Database>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SupabaseAgentQueue latency controls", () => {
  it("does not make token delivery wait on a pending stream RPC and drains before completion", async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const rpc = vi.fn(async (name: string): Promise<RpcResult> => {
      if (name === "worker_append_agent_run_stream") {
        await appendGate;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });
    const queue = queueWith(rpc);

    // Crossing the coalescing threshold starts persistence, but stream() must
    // acknowledge immediately so the model reader can keep consuming tokens.
    await queue.stream(run.runId, "x".repeat(2_048));
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledWith("worker_append_agent_run_stream", expect.objectContaining({
      target_run_id: run.runId,
      reset_stream: false
    }));

    let completed = false;
    const completion = queue.complete(run, { content: "done", modelVersionId: "model", usage: {} }).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(rpc.mock.calls.some(([name]) => name === "worker_complete_agent_run")).toBe(false);

    releaseAppend();
    await completion;
    expect(rpc.mock.calls.some(([name]) => name === "worker_complete_agent_run")).toBe(true);
  });

  it("coalesces adjacent deltas into one durable append before completing", async () => {
    const rpc = vi.fn(async (): Promise<RpcResult> => ({ data: null, error: null }));
    const queue = queueWith(rpc);

    await queue.stream(run.runId, "Hel");
    await queue.stream(run.runId, "lo");
    await queue.complete(run, { content: "Hello", modelVersionId: "model", usage: {} });

    const appendCalls = rpc.mock.calls.filter(([name]) => name === "worker_append_agent_run_stream");
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.[1]).toEqual(expect.objectContaining({ delta: "Hello", reset_stream: false }));
    const appendOrder = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([name]) => name === "worker_append_agent_run_stream")]!;
    const completeOrder = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([name]) => name === "worker_complete_agent_run")]!;
    expect(appendOrder).toBeLessThan(completeOrder);
  });

  it("deduplicates cancellation checks for 400ms while preserving a fresh check afterward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T15:00:00Z"));
    const rpc = vi.fn(async (name: string): Promise<RpcResult> => ({ data: name === "worker_is_agent_run_cancelled" ? false : null, error: null }));
    const queue = queueWith(rpc);

    await expect(queue.isCancelled(run.runId)).resolves.toBe(false);
    await expect(queue.isCancelled(run.runId)).resolves.toBe(false);
    expect(rpc.mock.calls.filter(([name]) => name === "worker_is_agent_run_cancelled")).toHaveLength(1);

    vi.advanceTimersByTime(401);
    await expect(queue.isCancelled(run.runId)).resolves.toBe(false);
    expect(rpc.mock.calls.filter(([name]) => name === "worker_is_agent_run_cancelled")).toHaveLength(2);
  });
});
