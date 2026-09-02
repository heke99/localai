const HISTORY_RPC_NAME = "worker_load_agent_conversation_history";

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
