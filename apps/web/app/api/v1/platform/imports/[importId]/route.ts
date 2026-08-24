import { superadminV1, v1Error, v1Success } from "../../../../../../lib/api/v1";

type RpcClient = { rpc: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ importId: string }> }) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  const { importId } = await context.params;
  if (!uuid.test(importId)) return v1Error("invalid_request", auth.requestId, 400);
  const { data, error } = await (auth.supabase as unknown as RpcClient).rpc("superadmin_platform_import_status", { target_import_id: importId });
  if (error) return v1Error("portability_operation_failed", auth.requestId, 500);
  if (!data) return v1Error("not_found", auth.requestId, 404);
  return v1Success(data, auth.requestId, 200, { "Cache-Control": "no-store" });
}
