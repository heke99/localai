const HISTORY_RPC_NAME = "worker_load_agent_conversation_history";

export type HistoryRpcError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export type HistoryRpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: HistoryRpcError | null }>;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [record.code, record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
  }
  return "";
}

export function isConversationHistoryRpcUnavailable(error: unknown): boolean {
  const text = errorText(error);
  if (!text) return false;
  if (/\bPGRST202\b/i.test(text)) return true;
  if (!new RegExp(HISTORY_RPC_NAME, "i").test(text)) return false;
  return /schema cache|could not find|not found|does not exist|undefined function/i.test(text);
}

export function withConversationHistoryRpcCompatibility(
  client: HistoryRpcClient,
  logger: Pick<Console, "warn"> = console
): HistoryRpcClient {
  return {
    async rpc<T>(name: string, args: Record<string, unknown>) {
      const result = await client.rpc<T>(name, args);
      if (name !== HISTORY_RPC_NAME || !result.error || !isConversationHistoryRpcUnavailable(result.error)) return result;
      logger.warn("[agent-worker] conversation history RPC unavailable; continuing without prior turns", {
        code: result.error.code ?? "unknown",
        message: result.error.message ?? "unknown"
      });
      return { data: [] as unknown as T, error: null };
    }
  };
}
