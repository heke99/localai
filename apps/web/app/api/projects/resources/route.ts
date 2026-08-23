import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as { projectId?: string; resourceId?: string; capabilities?: string[]; enabled?: boolean } | null;
  if (!body?.projectId || !body.resourceId || !/^[0-9a-f-]{36}$/i.test(body.projectId) || !/^[0-9a-f-]{36}$/i.test(body.resourceId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const capabilities = Array.isArray(body.capabilities) ? [...new Set(body.capabilities.filter((value): value is string => typeof value === "string" && /^[a-z0-9_.-]{3,120}$/.test(value)))].slice(0, 80) : [];
  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("configure_project_integration_resource", {
    target_project_id: body.projectId,
    target_resource_id: body.resourceId,
    target_capabilities: capabilities,
    target_enabled: body.enabled !== false
  });
  if (error) {
    const denied = /authentication_required|project_access_denied|permission_denied|integration_not_connected|provider_capability_not_granted/.test(error.message);
    return NextResponse.json({ error: denied ? "access_or_capability_denied" : "resource_configuration_failed" }, { status: denied ? 403 : 500 });
  }
  return NextResponse.json({ binding: data });
}
