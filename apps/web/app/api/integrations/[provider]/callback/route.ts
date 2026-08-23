import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { completeOAuthConnection, failOAuthSession, getOAuthSession } from "../../../../../lib/integrations/broker";
import { isProviderKey, safeReturnPath } from "../../../../../lib/integrations/oauth";
import { exchangeAndDiscover } from "../../../../../lib/integrations/providers";

function stringField(record: Record<string,unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] as string : "";
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
    const discovered = await exchangeAndDiscover(rawProvider, code, codeVerifier, user.id);
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
