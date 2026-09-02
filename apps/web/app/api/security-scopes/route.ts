import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type RpcClient = {
  rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringList(value: unknown, limit = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function errorResponse(message: string) {
  const denied = /authentication_required|project_access_denied|permission_denied|security_scope_authorization_required/.test(message);
  const invalid = /security_scope_requires_lab_project|security_scope_target_required|security_scope_too_large|invalid_security_scope_|forbidden_security_scope_|authorization_note_too_long/.test(message);
  return NextResponse.json(
    { error: denied ? "security_scope_access_denied" : invalid ? "invalid_security_scope" : "security_scope_failed" },
    { status: denied ? 403 : invalid ? 400 : 500 }
  );
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const projectId = new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  if (!uuidPattern.test(projectId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("get_project_security_scope", { target_project_id: projectId });
  if (error) return errorResponse(error.message);
  return NextResponse.json({ scope: data });
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    projectId?: string;
    allowHosts?: unknown;
    allowIpv4Cidrs?: unknown;
    active?: boolean;
    authorized?: boolean;
    authorizationNote?: string;
  } | null;

  const projectId = body?.projectId?.trim() ?? "";
  const authorizationNote = body?.authorizationNote?.trim() ?? "";
  if (!uuidPattern.test(projectId) || authorizationNote.length > 500) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("configure_project_security_scope", {
    target_project_id: projectId,
    target_allow_hosts: stringList(body?.allowHosts),
    target_allow_ipv4_cidrs: stringList(body?.allowIpv4Cidrs),
    target_active: body?.active === true,
    target_authorized: body?.authorized === true,
    target_authorization_note: authorizationNote || null
  });
  if (error) return errorResponse(error.message);

  return NextResponse.json({ scope: data });
}
