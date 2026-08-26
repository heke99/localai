import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { projectId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("delete_project", { target_project_id: projectId });

  if (error) {
    if (/project_not_found/.test(error.message)) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    if (/project_has_active_run/.test(error.message)) return NextResponse.json({ error: "project_has_active_run" }, { status: 409 });
    if (/permission_denied|workspace_access_denied|project_access_denied|authentication_required/.test(error.message)) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    return NextResponse.json({ error: "project_delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ deleted: data });
}
