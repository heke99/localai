import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const providers = new Set(["github", "supabase", "vercel"]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as { workspaceId?: string; provider?: string } | null;
  const provider = body?.provider?.trim().toLowerCase() ?? "";
  if (!body?.workspaceId || !providers.has(provider)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("request_integration_connection", {
    target_workspace_id: body.workspaceId,
    target_provider: provider
  });

  if (error) {
    const denied = /permission_denied|workspace_access_denied/.test(error.message);
    return NextResponse.json({ error: denied ? "access_denied" : "integration_request_failed" }, { status: denied ? 403 : 500 });
  }

  return NextResponse.json({ connection: data }, { status: 202 });
}
