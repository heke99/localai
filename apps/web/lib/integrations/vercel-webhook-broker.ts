import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";

type RpcResponse = { data: unknown | null; error: { message: string } | null };
type RpcAdmin = { rpc: (name: string, args?: Record<string,unknown>) => Promise<RpcResponse> };

function adminRpc() { return createSupabaseAdminClient() as unknown as RpcAdmin; }
function asObject(value: unknown): Record<string,unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("vercel_webhook_broker_response_invalid");
  return value as Record<string,unknown>;
}

export async function storeVercelWebhookSubscription(input: {
  connectionId: string;
  webhookId: string;
  ownerId: string | null;
  teamId: string | null;
  projectIds: string[];
  events: string[];
  secret: string;
}) {
  const { error } = await adminRpc().rpc("service_upsert_vercel_webhook_subscription", {
    target_connection_id: input.connectionId,
    target_webhook_id: input.webhookId,
    target_owner_id: input.ownerId,
    target_team_id: input.teamId,
    target_project_ids: input.projectIds,
    target_events: input.events,
    target_secret: input.secret
  });
  if (error) throw new Error(error.message);
}

export async function getVercelWebhookSecret(connectionId: string) {
  const { data, error } = await adminRpc().rpc("service_get_vercel_webhook_secret", { target_connection_id: connectionId });
  if (error || !data) throw new Error(error?.message ?? "vercel_webhook_not_found");
  const record = asObject(data);
  return {
    connectionId: String(record.connectionId ?? ""),
    webhookId: String(record.webhookId ?? ""),
    teamId: typeof record.teamId === "string" ? record.teamId : null,
    projectIds: Array.isArray(record.projectIds) ? record.projectIds.filter((item): item is string => typeof item === "string") : [],
    events: Array.isArray(record.events) ? record.events.filter((item): item is string => typeof item === "string") : [],
    secret: String(record.secret ?? "")
  };
}

export async function recordVercelDeploymentEvent(input: {
  connectionId: string;
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  projectId: string;
  deploymentId: string | null;
  deploymentUrl: string | null;
  deploymentState: string | null;
  deploymentTarget: string | null;
  gitCommitSha: string | null;
  gitBranch: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}) {
  const { data, error } = await adminRpc().rpc("service_record_vercel_deployment_event", {
    target_connection_id: input.connectionId,
    target_event_id: input.eventId,
    target_event_type: input.eventType,
    target_event_created_at: input.eventCreatedAt,
    target_project_id: input.projectId,
    target_deployment_id: input.deploymentId,
    target_deployment_url: input.deploymentUrl,
    target_deployment_state: input.deploymentState,
    target_deployment_target: input.deploymentTarget,
    target_git_commit_sha: input.gitCommitSha,
    target_git_branch: input.gitBranch,
    target_error_code: input.errorCode,
    target_error_message: input.errorMessage
  });
  if (error) throw new Error(error.message);
  return data === true;
}
