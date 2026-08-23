import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";
import type { ProviderKey, StoredCredential } from "./oauth";
import type { DiscoveredResource } from "./github";

type RpcResponse = { data: unknown | null; error: { message: string } | null };
type RpcAdmin = { rpc: (name: string, args?: Record<string,unknown>) => Promise<RpcResponse> };

function adminRpc() { return createSupabaseAdminClient() as unknown as RpcAdmin; }

function asObject(value: unknown): Record<string,unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("integration_broker_response_invalid");
  return value as Record<string,unknown>;
}

function objectOrEmpty(value: unknown): Record<string,unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

async function syncResources(connectionId: string, resources: DiscoveredResource[]) {
  const { error: prepareError } = await adminRpc().rpc("service_prepare_integration_resource_sync", { target_connection_id: connectionId });
  if (prepareError) throw new Error(prepareError.message);
  try {
    for (const resource of resources.slice(0,10000)) {
      const { data: resourceId, error: resourceError } = await adminRpc().rpc("sync_integration_resource", {
        target_connection_id: connectionId,
        target_resource_type: resource.resourceType,
        target_external_resource_id: resource.externalId,
        target_display_name: resource.displayName,
        target_metadata: resource.metadata
      });
      if (resourceError || typeof resourceId !== "string") throw new Error(resourceError?.message ?? "integration_resource_sync_failed");
      for (const identifier of resource.identifiers.slice(0,20)) {
        const { error: identifierError } = await adminRpc().rpc("sync_integration_resource_identifier", {
          target_resource_id: resourceId,
          target_kind: identifier.kind,
          target_value: identifier.value,
          target_source_kind: "provider",
          target_confidence: identifier.confidence,
          target_linkable: identifier.linkable
        });
        if (identifierError) throw new Error(identifierError.message);
      }
    }
    const { error: finalizeError } = await adminRpc().rpc("service_finalize_integration_resource_sync", { target_connection_id: connectionId, target_error_code: null });
    if (finalizeError) throw new Error(finalizeError.message);
  } catch (error) {
    await adminRpc().rpc("service_finalize_integration_resource_sync", { target_connection_id: connectionId, target_error_code: "resource_sync_failed" });
    throw error;
  }
}

export async function getOAuthSession(provider: ProviderKey, state: string, actorUserId: string) {
  const { data, error } = await adminRpc().rpc("service_get_integration_oauth_session", { target_provider: provider, target_state: state, target_actor_user_id: actorUserId });
  if (error || !data) throw new Error(error?.message ?? "oauth_session_not_found");
  return asObject(data);
}

export async function failOAuthSession(oauthSessionId: string | null, code: string) {
  if (!oauthSessionId) return;
  await adminRpc().rpc("service_fail_integration_oauth_session", { target_oauth_session_id: oauthSessionId, target_error_code: code.slice(0,120) });
}

export async function completeOAuthConnection(input: {
  oauthSessionId: string;
  provider: ProviderKey;
  externalAccountId: string;
  externalAccountName: string;
  credential: StoredCredential | null;
  metadata: Record<string,unknown>;
  capabilities: string[];
  resources: DiscoveredResource[];
}) {
  const credentialBundle = input.credential ? {
    accessToken: input.credential.accessToken,
    refreshToken: input.credential.refreshToken ?? null,
    tokenType: input.credential.tokenType ?? "bearer",
    scope: input.credential.scope ?? null,
    expiresAt: input.credential.expiresAt ?? null
  } : null;
  const { data: completed, error: completeError } = await adminRpc().rpc("service_complete_integration_oauth_session", {
    target_oauth_session_id: input.oauthSessionId,
    target_external_account_id: input.externalAccountId,
    target_external_account_name: input.externalAccountName,
    target_credential_bundle: credentialBundle,
    target_credential_expires_at: input.credential?.expiresAt ?? null,
    target_metadata: input.metadata,
    target_capabilities: input.capabilities
  });
  if (completeError || !completed) throw new Error(completeError?.message ?? "integration_connection_complete_failed");
  const result = asObject(completed);
  const connectionId = String(result.id ?? "");
  if (!connectionId) throw new Error("integration_connection_id_missing");
  await syncResources(connectionId, input.resources);
  return { connectionId, returnPath: typeof result.returnPath === "string" ? result.returnPath : "/dashboard?section=integrations" };
}

export interface GithubWebhookConnection {
  connectionId: string;
  organizationId: string;
  externalAccountId: string;
  externalAccountName: string;
  metadata: Record<string,unknown>;
}

export async function findGithubWebhookConnections(installationId: number, senderId: string | null): Promise<GithubWebhookConnection[]> {
  const { data, error } = await adminRpc().rpc("service_find_github_connections_for_webhook", {
    target_installation_id: installationId,
    target_sender_id: senderId
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
      externalAccountId: typeof row.externalAccountId === "string" ? row.externalAccountId : "",
      externalAccountName: typeof row.externalAccountName === "string" ? row.externalAccountName : "",
      metadata: objectOrEmpty(row.metadata)
    }];
  });
}

export async function resyncGithubConnection(input: { connectionId: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }) {
  const { error } = await adminRpc().rpc("service_update_integration_connection_discovery", {
    target_connection_id: input.connectionId,
    target_metadata: input.metadata,
    target_capabilities: input.capabilities
  });
  if (error) throw new Error(error.message);
  await syncResources(input.connectionId, input.resources);
}

export async function readCredential(connectionId: string) {
  const { data, error } = await adminRpc().rpc("service_get_integration_credential", { target_connection_id: connectionId });
  if (error || !data) throw new Error(error?.message ?? "integration_credential_missing");
  const record = asObject(data);
  const credential = record.credential;
  return {
    provider: String(record.provider ?? ""),
    metadata: objectOrEmpty(record.metadata),
    credential: credential && typeof credential === "object" && !Array.isArray(credential) ? credential as Record<string,unknown> : null
  };
}

export async function updateCredential(connectionId: string, credential: StoredCredential) {
  const { error } = await adminRpc().rpc("service_update_integration_credential", {
    target_connection_id: connectionId,
    target_credential_bundle: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken ?? null,
      tokenType: credential.tokenType ?? "bearer",
      scope: credential.scope ?? null,
      expiresAt: credential.expiresAt ?? null
    },
    target_credential_expires_at: credential.expiresAt ?? null
  });
  if (error) throw new Error(error.message);
}

export async function consumeExecutionGrant(grantId: string, toolName: string) {
  const { data, error } = await adminRpc().rpc("service_consume_integration_tool_execution_grant", { target_grant_id: grantId, target_tool_name: toolName });
  if (error || !data) throw new Error(error?.message ?? "execution_grant_invalid");
  return asObject(data);
}

export async function finishExecutionGrant(grantId: string, outcome: string, metadata: Record<string,unknown> = {}) {
  await adminRpc().rpc("service_finish_integration_tool_execution_grant", { target_grant_id: grantId, target_outcome: outcome, target_result_metadata: metadata });
}
