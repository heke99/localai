import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };
type ActiveRun = {
  id: string;
  status: string;
  mode: string;
  model_alias: string;
  failure_code: string | null;
  conversation_id: string;
  input_message_id: string | null;
  output_message_id: string | null;
  created_at: string;
};
type DashboardSnapshot = {
  conversations?: Array<{ id?: string; selected_resource_ids?: string[] | null }>;
};

function resourceRpcUnavailable(message: string) {
  return /get_conversation_selected_resource_ids|Could not find the function|PGRST202/i.test(message);
}

export async function GET(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { conversationId } = await context.params;
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id,workspace_id,project_id,mode,title,created_at,updated_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError || !conversation) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });

  const rpc = supabase as unknown as RpcClient;
  const [{ data: messages, error: messagesError }, activeRunResult, selectedResourcesResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(500),
    rpc.rpc<ActiveRun[]>("get_active_agent_run", { target_conversation_id: conversationId }),
    rpc.rpc<string[]>("get_conversation_selected_resource_ids", { target_conversation_id: conversationId })
  ]);

  if (messagesError) return NextResponse.json({ error: "conversation_load_failed" }, { status: 500 });
  if (activeRunResult.error) {
    if (/authentication_required|conversation_access_denied|permission_denied/.test(activeRunResult.error.message)) {
      return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "conversation_run_resume_lookup_failed" }, { status: 500 });
  }

  let selectedResourceIds = selectedResourcesResult.data ?? [];
  if (selectedResourcesResult.error) {
    if (!resourceRpcUnavailable(selectedResourcesResult.error.message)) {
      return NextResponse.json({ error: "conversation_resource_resume_lookup_failed" }, { status: 500 });
    }

    // During a rolling release the lightweight RPC may not have reached the
    // production database yet. Fall back to the already-deployed dashboard
    // snapshot contract so reload never silently drops selected integrations.
    const fallback = await rpc.rpc<DashboardSnapshot>("workspace_dashboard_snapshot", {
      target_workspace_id: conversation.workspace_id
    });
    if (fallback.error) return NextResponse.json({ error: "conversation_resource_resume_lookup_failed" }, { status: 500 });
    selectedResourceIds = fallback.data?.conversations
      ?.find((item) => item.id === conversationId)
      ?.selected_resource_ids
      ?.filter((value): value is string => typeof value === "string") ?? [];
  }

  return NextResponse.json({
    conversation,
    messages: messages ?? [],
    activeRun: activeRunResult.data?.[0] ?? null,
    selectedResourceIds
  });
}

export async function DELETE(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { conversationId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const prepared = await rpc.rpc<Record<string, unknown>>("prepare_conversation_delete", { target_conversation_id: conversationId });
  if (prepared.error) {
    if (/conversation_not_found/.test(prepared.error.message)) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    if (/permission_denied|workspace_access_denied|conversation_access_denied|authentication_required/.test(prepared.error.message)) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    return NextResponse.json({ error: "conversation_cancel_failed" }, { status: 500 });
  }
  if (!prepared.data || prepared.data.ready !== true) {
    return NextResponse.json({
      error: "conversation_cancellation_in_progress",
      activeToolExecutions: Number(prepared.data?.activeToolExecutions ?? 0),
      unsafeRollbacks: Number(prepared.data?.unsafeRollbacks ?? 0),
      nonTerminalRuns: Number(prepared.data?.nonTerminalRuns ?? 0)
    }, { status: 409 });
  }

  const { data, error } = await rpc.rpc<Record<string, unknown>>("delete_conversation", { target_conversation_id: conversationId });
  if (error) {
    if (/conversation_not_found/.test(error.message)) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    if (/agent_run_delete_not_ready|conversation_has_active_run/.test(error.message)) return NextResponse.json({ error: "conversation_cancellation_in_progress" }, { status: 409 });
    if (/permission_denied|workspace_access_denied|conversation_access_denied|authentication_required/.test(error.message)) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    return NextResponse.json({ error: "conversation_delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ deleted: data });
}
