import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { completeOAuthConnection, failOAuthSession, getOAuthSession } from "../../../../../lib/integrations/broker";
import { isProviderKey, safeReturnPath } from "../../../../../lib/integrations/oauth";
import { exchangeAndDiscover } from "../../../../../lib/integrations/providers";
import { storeVercelWebhookSubscription } from "../../../../../lib/integrations/vercel-webhook-broker";
import { createVercelDeploymentWebhook, deleteVercelDeploymentWebhook } from "../../../../../lib/integrations/vercel-webhooks";

function stringField(record: Record<string,unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] as string : "";
}

function metadataString(record: Record<string,unknown>, key: string) {
  return typeof record[key] === "string" && String(record[key]).trim() ? String(record[key]).trim() : null;
}

function safeOAuthErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "oauth_callback_failed";
  const normalized = message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return normalized || "oauth_callback_failed";
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  const requestUrl = new URL(request.url);
  if (!isProviderKey(rawProvider)) return NextResponse.json({ error: "provider_not_supported" }, { status: 404 });
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const providerError = requestUrl.searchParams.get("error");
  if (!state) return NextResponse.redirect(new URL(`/dashboard?section=integrations&integrationError=state_missing&provider=${rawProvider}`, requestUrl.origin), 303);

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in?error=integration_session_required", requestUrl.origin), 303);

  let oauthSessionId: string | null = null;
  let returnPath = "/dashboard?section=integrations";
  try {
    const session = await getOAuthSession(rawProvider, state, user.id);
    oauthSessionId = stringField(session, "oauthSessionId");
    returnPath = safeReturnPath(stringField(session, "returnPath"));
    if (providerError) {
      const providerErrorCode = `provider_${providerError}`;
      await failOAuthSession(oauthSessionId, providerErrorCode);
      console.warn("integration_oauth_provider_denied", { provider: rawProvider, errorCode: providerErrorCode });
      return NextResponse.redirect(new URL(`${returnPath}${returnPath.includes("?") ? "&" : "?"}integrationError=access_denied&provider=${rawProvider}`, requestUrl.origin), 303);
    }
    if (!code) throw new Error("authorization_code_missing");
    const codeVerifier = stringField(session, "codeVerifier") || null;
    const discovered = await exchangeAndDiscover(rawProvider, code, codeVerifier, user.id, rawProvider === "vercel" ? {
      teamId: requestUrl.searchParams.get("teamId"),
      configurationId: requestUrl.searchParams.get("configurationId"),
      source: requestUrl.searchParams.get("source")
    } : {});

    if (rawProvider === "vercel" && discovered.resources.length === 0) {
      throw new Error("vercel_no_projects_authorized");
    }

    const completed = await completeOAuthConnection({
      oauthSessionId,
      provider: rawProvider,
      externalAccountId: discovered.externalAccountId,
      externalAccountName: discovered.externalAccountName,
      credential: discovered.credential,
      metadata: discovered.metadata,
      capabilities: discovered.capabilities,
      resources: discovered.resources
    });

    if (rawProvider === "vercel") {
      if (!discovered.credential) throw new Error("vercel_credential_missing");
      const workspaceId = stringField(session, "workspaceId");
      const teamId = metadataString(discovered.metadata, "callbackTeamId");
      let createdWebhook: Awaited<ReturnType<typeof createVercelDeploymentWebhook>> | null = null;
      try {
        createdWebhook = await createVercelDeploymentWebhook({
          credential: discovered.credential,
          connectionId: completed.connectionId,
          teamId,
          projectIds: discovered.resources.map((resource) => resource.externalId),
          origin: requestUrl.origin
        });
        await storeVercelWebhookSubscription({
          connectionId: completed.connectionId,
          webhookId: createdWebhook.webhookId,
          ownerId: createdWebhook.ownerId,
          teamId: createdWebhook.teamId,
          projectIds: createdWebhook.projectIds,
          events: createdWebhook.events,
          secret: createdWebhook.secret
        });
      } catch (webhookError) {
        if (createdWebhook) {
          try {
            await deleteVercelDeploymentWebhook(discovered.credential, createdWebhook.webhookId, teamId);
          } catch (cleanupError) {
            console.error("vercel_webhook_cleanup_failed", { errorCode: safeOAuthErrorCode(cleanupError) });
          }
        }
        if (workspaceId) {
          const { error: rollbackError } = await supabase.rpc("disconnect_integration_connection", {
            target_workspace_id: workspaceId,
            target_connection_id: completed.connectionId
          } as never);
          if (rollbackError) console.error("vercel_connection_rollback_failed", { errorCode: safeOAuthErrorCode(rollbackError) });
        }
        throw new Error(`vercel_webhook_setup_failed:${safeOAuthErrorCode(webhookError)}`);
      }
    }

    const target = safeReturnPath(completed.returnPath || returnPath);
    const response = NextResponse.redirect(new URL(`${target}${target.includes("?") ? "&" : "?"}connected=${rawProvider}`, requestUrl.origin), 303);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    const errorCode = safeOAuthErrorCode(error);
    console.error("integration_oauth_callback_failed", { provider: rawProvider, errorCode });
    await failOAuthSession(oauthSessionId, errorCode);
    const response = NextResponse.redirect(new URL(`${returnPath}${returnPath.includes("?") ? "&" : "?"}integrationError=oauth_callback_failed&provider=${rawProvider}`, requestUrl.origin), 303);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
