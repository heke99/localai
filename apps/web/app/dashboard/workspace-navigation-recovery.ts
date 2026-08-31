export type DashboardRecoveryRequest = {
  conversationId: string;
  runId: string | null;
  section: string | null;
};

export function dashboardRecoveryRequest(search: string, knownConversationIds: readonly string[]): DashboardRecoveryRequest | null {
  const params = new URLSearchParams(search);
  const conversationId = params.get("conversation")?.trim() ?? "";
  if (!conversationId || knownConversationIds.includes(conversationId)) return null;
  return {
    conversationId,
    runId: params.get("run")?.trim() || null,
    section: params.get("section")?.trim() || null
  };
}

export function upsertRecoveredConversation<T extends { id: string }>(current: readonly T[], recovered: T): T[] {
  return [recovered, ...current.filter((conversation) => conversation.id !== recovered.id)];
}
