import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";

type RpcResponse = { data: unknown | null; error: { message: string } | null };
type RpcAdmin = { rpc: (name: string, args?: Record<string,unknown>) => Promise<RpcResponse> };

function adminRpc() { return createSupabaseAdminClient() as unknown as RpcAdmin; }
function objectOrEmpty(value: unknown): Record<string,unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

export interface VercelWebhookConnection {
  connectionId: string;
  organizationId: string;
  metadata: Record<string,unknown>;
}

export async function findVercelWebhookConnections(input: {
  configurationId: string | null;
  projectId: string | null;
  teamId: string | null;
}): Promise<VercelWebhookConnection[]> {
  const { data, error } = await adminRpc().rpc("service_find_vercel_connections_for_webhook", {
    target_configuration_id: input.configurationId,
    target_project_id: input.projectId,
    target_team_id: input.teamId
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string,unknown>;
    const connectionId = typeof row.connectionId === "string" ? row.connectionId : "";
    if (!connectionId) return [];
    return [{
      connectionId,
      organizationId: typeof row.organizationId === "string" ? row.organizationId : "",
      metadata: objectOrEmpty(row.metadata)
    }];
  });
}

export async function recordVercelWebhookEvent(input: {
  connectionId: string;
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  projectId: string | null;
  deploymentId: string | null;
  deploymentUrl: string | null;
  deploymentState: string | null;
  deploymentTarget: string | null;
  metadata: Record<string,unknown>;
}) {
  const { data, error } = await adminRpc().rpc("service_record_vercel_webhook_event", {
    target_connection_id: input.connectionId,
    target_event_id: input.eventId,
    target_event_type: input.eventType,
    target_event_created_at: input.eventCreatedAt,
    target_project_id: input.projectId,
    target_deployment_id: input.deploymentId,
    target_deployment_url: input.deploymentUrl,
    target_deployment_state: input.deploymentState,
    target_deployment_target: input.deploymentTarget,
    target_metadata: input.metadata
  });
  if (error) throw new Error(error.message);
  return data === true;
}
