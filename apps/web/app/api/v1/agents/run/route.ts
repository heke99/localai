import { inferConversationRelationships } from "../../../../../lib/integrations/relationship-inference";
import { authenticatedV1, jsonBody, traceId, v1Error, v1Success } from "../../../../../lib/api/v1";

const modes = new Set(["chat", "code", "lab", "research"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function POST(request: Request) {
  const auth = await authenticatedV1(request);
  if (!auth.ok) return auth.response;
  const body = await jsonBody<{ workspaceId?: unknown; conversationId?: unknown; mode?: unknown; prompt?: unknown; resourceIds?: unknown }>(request, 150_000);
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
  const mode = typeof body?.mode === "string" ? body.mode : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const resourceIds = Array.isArray(body?.resourceIds) ? [...new Set(body.resourceIds.filter((value): value is string => typeof value === "string" && uuid.test(value)))].slice(0, 20) : [];
  if (!uuid.test(workspaceId) || !modes.has(mode) || !prompt || prompt.length > 100_000 || (conversationId && !uuid.test(conversationId))) return v1Error("invalid_request", auth.requestId, 400);
  const rpc = auth.supabase as unknown as RpcClient;

  if (conversationId) {
    const { error } = await rpc.rpc<Record<string, unknown>>("set_conversation_resources", { target_conversation_id: conversationId, target_resource_ids: resourceIds });
    if (error) {
      const denied = /permission_denied|workspace_access_denied|conversation_access_denied|resource_not_available/.test(error.message);
      return v1Error(denied ? "resource_or_access_denied" : "run_start_failed", auth.requestId, denied ? 403 : 500);
    }
    if (resourceIds.length) await inferConversationRelationships(conversationId);
  }

  const runTraceId = traceId(request);
  const { data, error } = await rpc.rpc<Array<{ run_id: string; resolved_conversation_id: string }>>("start_agent_run", {
    workspace_id: workspaceId,
    conversation_id: conversationId ?? null,
    mode,
    prompt,
    request_id: auth.requestId,
    trace_id: runTraceId,
    resource_ids: conversationId ? null : resourceIds
  });
  if (error) {
    if (/subscription_access_required/.test(error.message)) return v1Error("subscription_required", auth.requestId, 402);
    if (/permission_denied|workspace_access_denied|conversation_access_denied|resource_not_available|project_required_for_integration_resources/.test(error.message)) return v1Error("resource_or_access_denied", auth.requestId, 403);
    if (/conversation_mode_mismatch/.test(error.message)) return v1Error("conflict", auth.requestId, 409, "conversation_mode_mismatch");
    return v1Error("run_start_failed", auth.requestId, 500);
  }
  const run = data?.[0];
  if (!run) return v1Error("run_start_failed", auth.requestId, 500);
  return v1Success({ runId: run.run_id, conversationId: run.resolved_conversation_id, traceId: runTraceId, status: "queued" }, auth.requestId, 202, { Location: `/api/v1/runs/${run.run_id}`, "Cache-Control": "no-store" });
}
