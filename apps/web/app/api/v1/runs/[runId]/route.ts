import { authenticatedV1, v1Error, v1Success } from "../../../../../lib/api/v1";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

type AgentRunRow = {
  id: string;
  status: string;
  mode: string;
  model_alias: string;
  failure_code: string | null;
  output_content?: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const auth = await authenticatedV1(request);
  if (!auth.ok) return auth.response;
  const { runId } = await context.params;
  if (!uuid.test(runId)) return v1Error("invalid_request", auth.requestId, 400);
  const { data, error } = await (auth.supabase as unknown as RpcClient).rpc<AgentRunRow[]>("get_agent_run", { target_run_id: runId });
  if (error || !data?.[0]) return v1Error("run_not_found", auth.requestId, 404);
  const run = data[0];
  return v1Success({
    runId: run.id,
    status: run.status,
    mode: run.mode,
    modelAlias: run.model_alias,
    failureCode: run.failure_code,
    output: run.output_content ?? null,
    cancelRequestedAt: run.cancel_requested_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  }, auth.requestId, 200, { "Cache-Control": "no-store" });
}

export async function DELETE(request: Request, context: { params: Promise<{ runId: string }> }) {
  const auth = await authenticatedV1(request);
  if (!auth.ok) return auth.response;
  const { runId } = await context.params;
  if (!uuid.test(runId)) return v1Error("invalid_request", auth.requestId, 400);
  const { data, error } = await (auth.supabase as unknown as RpcClient).rpc<boolean>("cancel_agent_run", { target_run_id: runId });
  if (error || !data) return v1Error("run_not_cancellable", auth.requestId, 409);
  return v1Success({ runId, cancelRequested: true }, auth.requestId, 202, { "Cache-Control": "no-store" });
}
