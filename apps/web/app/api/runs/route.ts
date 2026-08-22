import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const modes = new Set(["chat", "code", "lab", "research"]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const body = await request.json().catch(() => null) as { workspaceId?: string; conversationId?: string; mode?: string; prompt?: string; labAuthorizationId?: string } | null;
  const prompt = body?.prompt?.trim() ?? "";
  if (!body?.workspaceId || !body.mode || !modes.has(body.mode) || prompt.length < 1 || prompt.length > 100_000) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const requestId = crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const { data, error } = await supabase.rpc("start_agent_run", { workspace_id: body.workspaceId, conversation_id: body.conversationId ?? null, mode: body.mode, prompt, request_id: requestId, trace_id: traceId, lab_authorization_id: body.labAuthorizationId ?? null });
  if (error) {
    const denied = /permission_denied|workspace_access_denied|conversation_access_denied/.test(error.message);
    return NextResponse.json({ error: denied ? "access_denied" : "run_start_failed", requestId }, { status: denied ? 403 : 500 });
  }
  const run = data?.[0];
  if (!run) return NextResponse.json({ error: "run_start_failed", requestId }, { status: 500 });
  return NextResponse.json({ runId: run.run_id, conversationId: run.resolved_conversation_id, requestId, traceId }, { status: 202 });
}
