import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processPrompt } from "@div3rsa/agent-runtime";
import type { Database } from "@div3rsa/db";
import { SupabaseAgentQueue } from "./supabase-queue";

type RpcResult = { data: unknown; error: { message: string } | null };

type RpcMock = ReturnType<typeof vi.fn<(name: string, args?: Record<string, unknown>) => Promise<RpcResult>>>;

const claimedRow = {
  job_id: "00000000-0000-0000-0000-000000000001",
  run_id: "00000000-0000-0000-0000-000000000002",
  conversation_id: "00000000-0000-0000-0000-000000000003",
  organization_id: "00000000-0000-0000-0000-000000000004",
  requested_by: "00000000-0000-0000-0000-000000000005",
  mode: "chat",
  model_alias: "general-prod",
  prompt: "Och Norge?",
  request_id: "request-1",
  trace_id: "trace-1",
  resource_context: []
};

function queueWith(rpc: RpcMock) {
  return new SupabaseAgentQueue({ rpc } as unknown as SupabaseClient<Database>);
}

describe("SupabaseAgentQueue follow-up routing context", () => {
  it("loads prior user turns for routing while preserving the exact current prompt seen by the model contract", async () => {
    const rpc = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<RpcResult>>(async (name) => {
      if (name === "worker_claim_agent_run") return { data: [claimedRow], error: null };
      if (name === "worker_load_agent_conversation_history") {
        return {
          data: [
            { role: "user", content: "Vad är den aktuella momssatsen i Sverige?" },
            { role: "assistant", content: "Tidigare svar" }
          ],
          error: null
        };
      }
      return { data: null, error: null };
    });

    const run = await queueWith(rpc).claim("worker-1");
    expect(run).not.toBeNull();
    const contract = processPrompt(run!.mode, run!.prompt);

    expect(contract.normalizedPrompt).toBe("Och Norge?");
    expect(contract.freshness).toBe("current");
    expect(contract.requires.web).toBe(true);
    expect(rpc).toHaveBeenCalledWith("worker_load_agent_conversation_history", {
      target_request_id: "request-1",
      target_limit: 12
    });
  });

  it("persists a terminal failure for a claimed run when routing history cannot be loaded", async () => {
    const rpc = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<RpcResult>>(async (name) => {
      if (name === "worker_claim_agent_run") return { data: [claimedRow], error: null };
      if (name === "worker_load_agent_conversation_history") return { data: null, error: { message: "PGRST202 function missing" } };
      if (name === "worker_fail_agent_run") return { data: null, error: null };
      return { data: null, error: null };
    });

    await expect(queueWith(rpc).claim("worker-1")).rejects.toThrow(/agent_routing_history_read_failed/);
    expect(rpc).toHaveBeenCalledWith("worker_fail_agent_run", expect.objectContaining({
      target_run_id: claimedRow.run_id,
      target_job_id: claimedRow.job_id,
      retryable: false
    }));
  });

  it("marks transient routing-history failures retryable instead of leaving the claimed job running", async () => {
    const rpc = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<RpcResult>>(async (name) => {
      if (name === "worker_claim_agent_run") return { data: [claimedRow], error: null };
      if (name === "worker_load_agent_conversation_history") return { data: null, error: { message: "503 connection unavailable" } };
      if (name === "worker_fail_agent_run") return { data: null, error: null };
      return { data: null, error: null };
    });

    await expect(queueWith(rpc).claim("worker-1")).rejects.toThrow(/agent_routing_history_read_failed/);
    expect(rpc).toHaveBeenCalledWith("worker_fail_agent_run", expect.objectContaining({ retryable: true }));
  });
});