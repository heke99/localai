import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { inferConversationRelationships } from "../../../../../lib/integrations/relationship-inference";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { conversationId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const body = await request.json().catch(() => null) as { resourceIds?: string[] } | null;
  const resourceIds = Array.isArray(body?.resourceIds)
    ? [...new Set(body.resourceIds.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 20)
    : [];

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("set_conversation_resources", {
    target_conversation_id: conversationId,
    target_resource_ids: resourceIds
  });

  if (error) {
    const denied = /authentication_required|conversation_access_denied|resource_not_available|permission_denied|workspace_access_denied/.test(error.message);
    return NextResponse.json({ error: denied ? "resource_or_access_denied" : "resource_selection_failed" }, { status: denied ? 403 : 500 });
  }

  if (resourceIds.length) await inferConversationRelationships(conversationId);
  return NextResponse.json({ selection: data });
}
