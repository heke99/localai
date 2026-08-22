import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

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
