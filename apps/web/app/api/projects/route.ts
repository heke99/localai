import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const modes = new Set(["chat", "code", "lab", "research"]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    workspaceId?: string;
    name?: string;
    description?: string;
    mode?: string;
  } | null;

  const name = body?.name?.trim() ?? "";
  const description = body?.description?.trim() ?? "";
  const mode = body?.mode?.trim().toLowerCase() ?? "";
  if (!body?.workspaceId || name.length < 1 || name.length > 120 || description.length > 2000 || !modes.has(mode)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("create_project", {
    target_workspace_id: body.workspaceId,
    target_name: name,
    target_description: description || null,
    target_mode: mode
  });

  if (error) {
    const denied = /permission_denied|workspace_access_denied/.test(error.message);
    return NextResponse.json({ error: denied ? "access_denied" : "project_create_failed" }, { status: denied ? 403 : 500 });
  }

  return NextResponse.json({ project: data }, { status: 201 });
}
