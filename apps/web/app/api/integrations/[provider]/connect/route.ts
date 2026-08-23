import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { generateOAuthSecurity, isProviderKey, safeReturnPath } from "../../../../../lib/integrations/oauth";
import { providerAuthorizationUrl } from "../../../../../lib/integrations/providers";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  if (!isProviderKey(rawProvider)) return NextResponse.json({ error: "provider_not_supported" }, { status: 404 });
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  const returnPath = safeReturnPath(url.searchParams.get("returnPath") ?? "/dashboard?section=integrations");
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return NextResponse.json({ error: "workspace_required" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, url.origin), 303);

  try {
    const security = generateOAuthSecurity(rawProvider);
    const { data, error } = await supabase.rpc("begin_integration_oauth", {
      target_workspace_id: workspaceId,
      target_provider: rawProvider,
      target_state: security.state,
      target_code_verifier: security.codeVerifier,
      target_return_path: returnPath
    } as never);
    if (error || !data) throw new Error(error?.message ?? "oauth_begin_failed");
    const authorizationUrl = providerAuthorizationUrl(rawProvider, security);
    const response = NextResponse.redirect(authorizationUrl, 303);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("provider_configuration_missing:") ? "provider_configuration_missing" : "connection_start_failed";
    return NextResponse.redirect(new URL(`${returnPath}${returnPath.includes("?") ? "&" : "?"}integrationError=${encodeURIComponent(code)}&provider=${rawProvider}`, url.origin), 303);
  }
}
