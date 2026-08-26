import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function GET(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { conversationId } = await context.params;
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id,project_id,mode,title,created_at,updated_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError || !conversation) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id,role,content,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (messagesError) return NextResponse.json({ error: "conversation_load_failed" }, { status: 500 });

  return NextResponse.json({ conversation, messages: messages ?? [] });
}

export async function DELETE(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { conversationId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("delete_conversation", { target_conversation_id: conversationId });

  if (error) {
    if (/conversation_not_found/.test(error.message)) return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    if (/conversation_has_active_run/.test(error.message)) return NextResponse.json({ error: "conversation_has_active_run" }, { status: 409 });
    if (/permission_denied|workspace_access_denied|conversation_access_denied|authentication_required/.test(error.message)) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    return NextResponse.json({ error: "conversation_delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ deleted: data });
}
