import { describe, expect, it, vi } from "vitest";
import { isConversationHistoryRpcUnavailable, withConversationHistoryRpcCompatibility, type HistoryRpcClient } from "./conversation-history-availability";

function client(result: { data: unknown; error: { code?: string; message?: string; details?: string; hint?: string } | null }): HistoryRpcClient {
  return { rpc: vi.fn(async () => result) as HistoryRpcClient["rpc"] };
}

describe("conversation history RPC compatibility", () => {
  it("recognizes PostgREST missing-function responses", () => {
    expect(isConversationHistoryRpcUnavailable({ code: "PGRST202", message: "Could not find the function public.worker_load_agent_conversation_history in the schema cache" })).toBe(true);
    expect(isConversationHistoryRpcUnavailable(new Error("agent_conversation_history_read_failed:PGRST202:missing"))).toBe(true);
  });

  it("degrades only the missing history RPC to an empty history result", async () => {
    const logger = { warn: vi.fn() };
    const wrapped = withConversationHistoryRpcCompatibility(client({
      data: null,
      error: { code: "PGRST202", message: "Could not find worker_load_agent_conversation_history in the schema cache" }
    }), logger);

    await expect(wrapped.rpc<unknown[]>("worker_load_agent_conversation_history", { target_request_id: "req", target_limit: 12 }))
      .resolves.toEqual({ data: [], error: null });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("preserves real database failures and unrelated RPC failures", async () => {
    const unavailable = client({ data: null, error: { code: "PGRST301", message: "503 connection unavailable" } });
    const wrapped = withConversationHistoryRpcCompatibility(unavailable, { warn: vi.fn() });

    await expect(wrapped.rpc("worker_load_agent_conversation_history", {})).resolves.toEqual({
      data: null,
      error: { code: "PGRST301", message: "503 connection unavailable" }
    });
    await expect(wrapped.rpc("worker_claim_agent_run", {})).resolves.toEqual({
      data: null,
      error: { code: "PGRST301", message: "503 connection unavailable" }
    });
  });
});
