import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const modes = new Set(["chat", "code", "lab", "research"]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    workspaceId?: string;
    projectId?: string | null;
    mode?: string;
    title?: string;
  } | null;

  const title = body?.title?.trim() ?? "";
  if (!body?.workspaceId || !body.mode || !modes.has(body.mode) || title.length > 160) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("create_conversation", {
    target_workspace_id: body.workspaceId,
    target_project_id: body.projectId || null,
    target_mode: body.mode,
    target_title: title || null
  });

  if (error) {
    const denied = /permission_denied|workspace_access_denied|project_access_denied/.test(error.message);
    return NextResponse.json({ error: denied ? "access_denied" : "conversation_create_failed" }, { status: denied ? 403 : 500 });
  }

  return NextResponse.json({ conversation: data }, { status: 201 });
}
