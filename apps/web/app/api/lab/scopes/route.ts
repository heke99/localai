import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";

type ScopeBody = {
  projectId?: string;
  displayName?: string;
  hosts?: string[];
  ipv4Cidrs?: string[];
  allowActive?: boolean;
};

type RpcClient = {
  rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeHost(value: string) {
  const input = value.trim();
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error("invalid_security_scope_host");
    return url.hostname.toLowerCase().replace(/\.$/, "");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new Error("invalid_security_scope_host");
  return input.toLowerCase().replace(/\.$/, "");
}

function failureStatus(message: string) {
  if (/authentication_required/.test(message)) return 401;
  if (/permission_denied|project_access_denied|lab_project_required/.test(message)) return 403;
  if (/invalid_|blocked_|required|too_large/.test(message)) return 400;
  if (/Could not find the function|PGRST202/.test(message)) return 503;
  return 500;
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as ScopeBody | null;
  const projectId = body?.projectId?.trim() ?? "";
  const displayName = body?.displayName?.trim() ?? "";
  if (!uuidPattern.test(projectId) || !displayName || displayName.length > 160) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let hosts: string[];
  try {
    hosts = [...new Set((body?.hosts ?? []).filter((value): value is string => typeof value === "string").map(normalizeHost).filter(Boolean))];
  } catch {
    return NextResponse.json({ error: "invalid_security_scope_host" }, { status: 400 });
  }
  const ipv4Cidrs = [...new Set((body?.ipv4Cidrs ?? []).filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  if (!hosts.length && !ipv4Cidrs.length) return NextResponse.json({ error: "security_scope_target_required" }, { status: 400 });
  if (hosts.length > 32 || ipv4Cidrs.length > 32) return NextResponse.json({ error: "security_scope_too_large" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const result = await rpc.rpc<Record<string, unknown>>("upsert_project_security_scope", {
    target_project_id: projectId,
    target_display_name: displayName,
    target_allow_hosts: hosts,
    target_allow_ipv4_cidrs: ipv4Cidrs,
    target_allow_active: body?.allowActive === true
  });

  if (result.error) {
    const message = result.error.message || "security_scope_failed";
    console.error("[lab-scope] failed", { projectId, code: result.error.code, message });
    return NextResponse.json({ error: message.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 140) }, { status: failureStatus(message) });
  }

  return NextResponse.json({ scope: result.data });
}
