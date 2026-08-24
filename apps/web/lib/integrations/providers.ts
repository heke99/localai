import "server-only";
import { discoverGithub, exchangeGithubCode, githubAuthorizationUrl } from "./github";
import { discoverSupabase, exchangeSupabaseCode } from "./supabase-provider";
import { discoverVercel, exchangeVercelCode, vercelAuthorizationUrl, type VercelCallbackContext } from "./vercel-provider";
import { supabaseAuthorizationUrl } from "./supabase-provider";
import type { OAuthSecurity, ProviderKey, StoredCredential } from "./oauth";

export function providerAuthorizationUrl(provider: ProviderKey, security: OAuthSecurity) {
  if (provider === "github") return githubAuthorizationUrl(security.state);
  if (provider === "vercel") return vercelAuthorizationUrl(security.state);
  if (!security.codeChallenge) throw new Error("pkce_challenge_required");
  return supabaseAuthorizationUrl(security.state, security.codeChallenge);
}

export async function exchangeAndDiscover(
  provider: ProviderKey,
  code: string,
  codeVerifier: string | null,
  actorUserId: string,
  callbackContext: VercelCallbackContext = {}
) {
  if (provider === "github") {
    const token = await exchangeGithubCode(code);
    const discovered = await discoverGithub(token.access_token);
    return { ...discovered, credential: null as StoredCredential | null };
  }
  if (provider === "supabase") {
    if (!codeVerifier) throw new Error("pkce_verifier_missing");
    const credential = await exchangeSupabaseCode(code, codeVerifier);
    const discovered = await discoverSupabase(credential, actorUserId);
    return { ...discovered, credential };
  }
  const credential = await exchangeVercelCode(code);
  const discovered = await discoverVercel(credential, callbackContext);
  return { ...discovered, credential };
}
