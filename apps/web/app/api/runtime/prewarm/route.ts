import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import { ensureRunpodRuntimeAwake } from "../../../../lib/runpod/runtime";

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as { workspaceId?: string } | null;
  if (!body?.workspaceId || !/^[0-9a-f-]{36}$/i.test(body.workspaceId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const isSuperadmin = user.app_metadata?.system_role === "superadmin";
  if (!isSuperadmin) {
    const { data, error } = await supabase.rpc("my_agent_access_snapshot", { target_workspace_id: body.workspaceId });
    const access = (data ?? {}) as { allowed?: boolean };
    if (error || !access.allowed) return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
  }

  try {
    const runtime = await ensureRunpodRuntimeAwake();
    return NextResponse.json(runtime, { status: runtime.configured ? 200 : 503 });
  } catch (error) {
    console.error("[runtime-prewarm] wake failed", error);
    return NextResponse.json({ error: "runtime_wake_failed" }, { status: 503 });
  }
}
