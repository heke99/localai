import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import { publicRuntimeWake, runtimeAliasForMode } from "../../../../lib/runtime/contracts";
import { ensureModelRuntime } from "../../../../lib/runtime/production";

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as { workspaceId?: string; mode?: string } | null;
  if (!body?.workspaceId || !/^[0-9a-f-]{36}$/i.test(body.workspaceId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const isSuperadmin = user.app_metadata?.system_role === "superadmin";
  if (!isSuperadmin) {
    const { data, error } = await supabase.rpc("my_agent_access_snapshot", { target_workspace_id: body.workspaceId });
    const access = (data ?? {}) as { allowed?: boolean };
    if (error || !access.allowed) return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
  }

  const alias = runtimeAliasForMode(body.mode);
  try {
    const runtime = await ensureModelRuntime(alias);
    return NextResponse.json(publicRuntimeWake(runtime), { status: 200 });
  } catch (error) {
    console.error("[runtime-prewarm] ensure failed", error instanceof Error ? error.message : "runtime_wake_failed");
    return NextResponse.json({ error: "runtime_wake_failed", alias }, { status: 503 });
  }
}
