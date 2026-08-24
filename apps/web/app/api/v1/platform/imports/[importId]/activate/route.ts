import { superadminV1, v1Error, v1Success } from "../../../../../../../lib/api/v1";

type RpcClient = { rpc: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ importId: string }> }) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  const { importId } = await context.params;
  if (!uuid.test(importId)) return v1Error("invalid_request", auth.requestId, 400);
  const { data, error } = await (auth.supabase as unknown as RpcClient).rpc("superadmin_activate_platform_import", { target_import_id: importId });
  if (error) {
    const blocked = /platform_import_not_ready/.test(error.message);
    const missing = /platform_import_not_found/.test(error.message);
    return v1Error(missing ? "not_found" : blocked ? "portability_import_blocked" : "portability_operation_failed", auth.requestId, missing ? 404 : blocked ? 409 : 500, blocked ? "all_required_self_tests_must_pass" : undefined);
  }
  return v1Success(data, auth.requestId, 200, { "Cache-Control": "no-store" });
}
