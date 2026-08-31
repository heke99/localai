import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";

type RpcResponse = { data: unknown | null; error: { message: string } | null };
type RpcAdmin = { rpc: (name: string, args?: Record<string,unknown>) => Promise<RpcResponse> };

function adminRpc() { return createSupabaseAdminClient() as unknown as RpcAdmin; }

function asObject(value: unknown): Record<string,unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("integration_execution_response_invalid");
  return value as Record<string,unknown>;
}

export async function consumeIdempotentExecution(grantId: string, toolName: string, operationId: string) {
  const { data, error } = await adminRpc().rpc("service_consume_idempotent_integration_tool_execution", {
    target_grant_id: grantId,
    target_tool_name: toolName,
    target_operation_id: operationId
  });
  if (error || !data) throw new Error(error?.message ?? "execution_grant_invalid");
  return asObject(data);
}

export async function finishIdempotentExecution(input: {
  grantId: string;
  operationId: string;
  outcome: "completed" | "failed" | "cancelled";
  result?: unknown;
  metadata?: Record<string,unknown>;
  retryable?: boolean;
}) {
  const { data, error } = await adminRpc().rpc("service_finish_idempotent_integration_tool_execution", {
    target_grant_id: input.grantId,
    target_operation_id: input.operationId,
    target_outcome: input.outcome,
    target_result_payload: input.result ?? null,
    target_result_metadata: input.metadata ?? {},
    target_retryable: input.retryable === true
  });
  if (error) throw new Error(error.message);
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string,unknown> : null;
}
