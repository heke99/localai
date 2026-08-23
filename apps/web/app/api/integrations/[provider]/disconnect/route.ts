import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { isProviderKey } from "../../../../../lib/integrations/oauth";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  if (!isProviderKey(rawProvider)) return NextResponse.json({ error: "provider_not_supported" }, { status: 404 });

  let body: { workspaceId?: unknown; connectionId?: unknown } = {};
  try {
    body = await request.json() as { workspaceId?: unknown; connectionId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isUuid(body.workspaceId) || !isUuid(body.connectionId)) {
    return NextResponse.json({ error: "workspace_and_connection_required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data, error } = await supabase.rpc("disconnect_integration_connection", {
    target_workspace_id: body.workspaceId,
    target_connection_id: body.connectionId
  } as never);

  if (error || !data) {
    const message = error?.message ?? "integration_disconnect_failed";
    const status = /access_denied|permission_denied|authentication_required/i.test(message) ? 403 : 400;
    return NextResponse.json({ error: "integration_disconnect_failed" }, { status });
  }

  const result = data as { id?: string; provider?: string; status?: string };
  if (result.provider && result.provider !== rawProvider) {
    return NextResponse.json({ error: "provider_connection_mismatch" }, { status: 409 });
  }

  const response = NextResponse.json({ connection: result });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
