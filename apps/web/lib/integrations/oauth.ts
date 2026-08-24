import "server-only";
import crypto from "node:crypto";
import { getAppUrl } from "../app-url";

export type ProviderKey = "github" | "supabase" | "vercel";

export interface OAuthSecurity {
  state: string;
  codeVerifier: string | null;
  codeChallenge: string | null;
}

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
}

export function isProviderKey(value: string): value is ProviderKey {
  return value === "github" || value === "supabase" || value === "vercel";
}

export function providerCallbackUrl(provider: ProviderKey) {
  return `${getAppUrl()}/api/integrations/${provider}/callback`;
}

export function generateOAuthSecurity(provider: ProviderKey): OAuthSecurity {
  const state = crypto.randomBytes(32).toString("base64url");
  // GitHub App and Vercel External Integration installations return to our
  // callback with an opaque state. Supabase's OAuth authorization server uses
  // PKCE (S256), so only Supabase needs a verifier/challenge pair here.
  if (provider === "github" || provider === "vercel") {
    return { state, codeVerifier: null, codeChallenge: null };
  }
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { state, codeVerifier, codeChallenge };
}

export function safeReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard?section=integrations";
  try {
    const parsed = new URL(value, "https://system.div3rsa.com");
    if (parsed.origin !== "https://system.div3rsa.com") return "/dashboard?section=integrations";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/dashboard?section=integrations";
  }
}

export function configuredCapabilities(provider: ProviderKey): string[] {
  const defaults: Record<ProviderKey, string[]> = {
    github: [
      "github.repository.read",
      "github.contents.read",
      "github.contents.write",
      "github.branch.create",
      "github.pull_request.read",
      "github.pull_request.create",
      "github.pull_request.merge",
      "github.actions.read",
      "github.actions.run",
      "github.workflow.write"
    ],
    supabase: [
      "supabase.project.read",
      "supabase.database.read",
      "supabase.database.write",
      "supabase.migrations.read",
      "supabase.migrations.apply",
      "supabase.functions.read",
      "supabase.functions.write",
      "supabase.logs.read",
      "supabase.auth.read",
      "supabase.auth.write"
    ],
    // Keep the connection capability set aligned with tools that are actually
    // implemented by the integration gateway. Project read is needed for
    // discovery; deployment read/write powers the four Vercel tools below.
    vercel: [
      "vercel.project.read",
      "vercel.deployments.read",
      "vercel.deployments.create",
      "vercel.deployments.rollback",
      "vercel.logs.read"
    ]
  };
  const envName = `${provider.toUpperCase()}_INTEGRATION_CAPABILITIES`;
  const configured = process.env[envName]?.split(",").map((item) => item.trim()).filter(Boolean);
  return configured?.length ? configured : defaults[provider];
}

export function requiredProviderEnv(provider: ProviderKey, suffix: string) {
  const name = `${provider.toUpperCase()}_INTEGRATION_${suffix}`;
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`provider_configuration_missing:${name}`);
  return value;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const code = body && typeof body === "object" && !Array.isArray(body) && "message" in body ? String((body as { message?: unknown }).message ?? response.status) : String(response.status);
    throw new Error(`provider_http_${response.status}:${code.slice(0,240)}`);
  }
  return body as T;
}

export function credentialExpiry(expiresIn: unknown) {
  const seconds = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + Math.max(30, seconds - 30) * 1000).toISOString();
}
