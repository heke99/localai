export type DashboardRecoveryRequest = {
  conversationId: string;
  runId: string | null;
  section: string | null;
};

export function dashboardRecoveryRequest(search: string, knownConversationIds: readonly string[]): DashboardRecoveryRequest | null {
  const params = new URLSearchParams(search);
  const conversationId = params.get("conversation")?.trim() ?? "";
  const runId = params.get("run")?.trim() || null;
  if (!conversationId) return null;

  // A run id in the URL is only a navigation hint. Even when the conversation
  // is already present in the dashboard snapshot we recover it once from the
  // server so stale run query parameters can never become client-side truth.
  if (knownConversationIds.includes(conversationId) && !runId) return null;
  return {
    conversationId,
    runId,
    section: params.get("section")?.trim() || null
  };
}

export function withoutProvisionalRun(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("run");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function upsertRecoveredConversation<T extends { id: string }>(current: readonly T[], recovered: T): T[] {
  return [recovered, ...current.filter((conversation) => conversation.id !== recovered.id)];
}
