import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const modes = new Set(["chat", "code", "lab", "research"]);
type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as { workspaceId?: string; conversationId?: string; mode?: string; prompt?: string; resourceIds?: string[] } | null;
  const prompt = body?.prompt?.trim() ?? "";
  const resourceIds = Array.isArray(body?.resourceIds) ? [...new Set(body.resourceIds.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 20) : [];
  if (!body?.workspaceId || !body.mode || !modes.has(body.mode) || prompt.length < 1 || prompt.length > 100_000) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const requestId = crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Array<{ run_id: string; resolved_conversation_id: string }>>("start_agent_run", {
    workspace_id: body.workspaceId,
    conversation_id: body.conversationId ?? null,
    mode: body.mode,
    prompt,
    request_id: requestId,
    trace_id: traceId,
    resource_ids: resourceIds
  });

  if (error) {
    const denied = /permission_denied|workspace_access_denied|conversation_access_denied|resource_not_available|project_required_for_integration_resources/.test(error.message);
    const conflict = /conversation_mode_mismatch/.test(error.message);
    return NextResponse.json({ error: denied ? "resource_or_access_denied" : conflict ? "conversation_mode_mismatch" : "run_start_failed", requestId }, { status: denied ? 403 : conflict ? 409 : 500 });
  }

  const run = data?.[0];
  if (!run) return NextResponse.json({ error: "run_start_failed", requestId }, { status: 500 });
  return NextResponse.json({ runId: run.run_id, conversationId: run.resolved_conversation_id, requestId, traceId }, { status: 202 });
}
