import "server-only";
import crypto from "node:crypto";
import { createSupabaseAdminClient } from "../supabase/admin";
import { readCredential, updateCredential } from "./broker";
import type { StoredCredential } from "./oauth";
import { refreshVercelCredential } from "./vercel-provider";

type RpcResponse = { data: unknown | null; error: { message: string } | null };
type RpcAdmin = { rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcResponse> };
type Identifier = { kind?: string; value?: string; source?: string; confidence?: number; linkable?: boolean };
type InferenceResource = {
  resourceId: string;
  connectionId: string;
  provider: string;
  resourceType: string;
  externalResourceId: string;
  displayName: string;
  metadata: Record<string, unknown>;
  selected: boolean;
  identifiers: Identifier[];
};

type InferenceContext = { projectId: string | null; organizationId: string | null; resources: InferenceResource[] };

const supabaseEnvKeys = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_PROJECT_URL",
  "SUPABASE_PROJECT_REF",
  "NEXT_PUBLIC_SUPABASE_PROJECT_REF"
]);
const githubConfigPaths = [
  ".env.example",
  ".env.local.example",
  ".env.production.example",
  "supabase/.temp/project-ref"
];

function adminRpc() { return createSupabaseAdminClient() as unknown as RpcAdmin; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asCredential(value: Record<string, unknown> | null): StoredCredential | null {
  if (!value || typeof value.accessToken !== "string" || !value.accessToken) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
    tokenType: typeof value.tokenType === "string" ? value.tokenType : "bearer",
    scope: typeof value.scope === "string" ? value.scope : null,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null
  };
}
function hasMarker(resource: InferenceResource, marker: string) { return resource.identifiers.some((identifier) => identifier.kind === marker); }
function normalizeRef(value: string) { const match = value.trim().toLowerCase().match(/^[a-z0-9]{10,40}$/); return match?.[0] ?? null; }
function refsFromText(text: string) {
  const refs = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/([a-z0-9]{10,40})\.supabase\.co\b/gi)) if (match[1]) refs.add(match[1].toLowerCase());
  for (const match of text.matchAll(/(?:NEXT_PUBLIC_)?SUPABASE_PROJECT_REF\s*=\s*["']?([a-z0-9]{10,40})["']?/gi)) if (match[1]) refs.add(match[1].toLowerCase());
  return [...refs];
}
function refFromAllowlistedEnv(key: string, value: string) {
  const trimmed = value.trim();
  if (key.endsWith("PROJECT_REF")) return normalizeRef(trimmed.replace(/^['"]|['"]$/g, ""));
  try {
    const hostname = new URL(trimmed.replace(/^['"]|['"]$/g, "")).hostname.toLowerCase();
    const match = hostname.match(/^([a-z0-9]{10,40})\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch { return null; }
}
async function syncIdentifier(resourceId: string, kind: string, value: string, source: "provider" | "discovered", confidence: number, linkable: boolean) {
  const { error } = await adminRpc().rpc("sync_integration_resource_identifier", {
    target_resource_id: resourceId,
    target_kind: kind,
    target_value: value,
    target_source_kind: source,
    target_confidence: confidence,
    target_linkable: linkable
  });
  if (error) throw new Error(error.message);
}
async function syncSupabaseRef(resourceId: string, ref: string, source: "provider" | "discovered", confidence: number) {
  await syncIdentifier(resourceId, "service.hostname", `${ref}.supabase.co`, source, confidence, true);
  await syncIdentifier(resourceId, "supabase.project_ref", ref, source, confidence, false);
}

async function inferenceContext(conversationId: string): Promise<InferenceContext> {
  const { data, error } = await adminRpc().rpc("service_conversation_relationship_inference_context", { target_conversation_id: conversationId });
  if (error) throw new Error(error.message);
  const root = asObject(data);
  const rawResources = Array.isArray(root.resources) ? root.resources : [];
  const resources = rawResources.flatMap((value): InferenceResource[] => {
    const row = asObject(value);
    const resourceId = typeof row.resourceId === "string" ? row.resourceId : "";
    const connectionId = typeof row.connectionId === "string" ? row.connectionId : "";
    if (!resourceId || !connectionId) return [];
    return [{
      resourceId,
      connectionId,
      provider: typeof row.provider === "string" ? row.provider : "",
      resourceType: typeof row.resourceType === "string" ? row.resourceType : "",
      externalResourceId: typeof row.externalResourceId === "string" ? row.externalResourceId : "",
      displayName: typeof row.displayName === "string" ? row.displayName : "",
      metadata: asObject(row.metadata),
      selected: row.selected === true,
      identifiers: Array.isArray(row.identifiers) ? row.identifiers.map((item) => asObject(item) as Identifier) : []
    }];
  });
  return {
    projectId: typeof root.projectId === "string" ? root.projectId : null,
    organizationId: typeof root.organizationId === "string" ? root.organizationId : null,
    resources
  };
}

async function activeVercelCredential(connectionId: string) {
  const stored = await readCredential(connectionId);
  if (stored.provider !== "vercel") throw new Error("vercel_connection_expected");
  let credential = asCredential(stored.credential);
  if (!credential) throw new Error("vercel_credential_missing");
  const expiresAt = credential.expiresAt ? new Date(credential.expiresAt).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000 && credential.refreshToken) {
    credential = await refreshVercelCredential(credential);
    await updateCredential(connectionId, credential);
  }
  return credential;
}
function withTeam(path: string, teamId: string | null) { return teamId ? `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : path; }
async function vercelJson<T>(credential: StoredCredential, path: string): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}`, { headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`vercel_inference_http_${response.status}`);
  return response.json() as Promise<T>;
}
async function inferFromVercel(resource: InferenceResource) {
  if (hasMarker(resource, "inference.vercel_env_scan")) return;
  const credential = await activeVercelCredential(resource.connectionId);
  const projectId = typeof resource.metadata.projectId === "string" ? resource.metadata.projectId : resource.externalResourceId;
  const teamId = typeof resource.metadata.teamId === "string" ? resource.metadata.teamId : null;
  type Env = { id?: string; key?: string; value?: string; type?: string };
  const list = await vercelJson<{ envs?: Env[] }>(credential, withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`, teamId));
  const candidates = (list.envs ?? []).filter((env) => typeof env.key === "string" && supabaseEnvKeys.has(env.key)).slice(0, 12);
  const refs = new Set<string>();

  for (const env of candidates) {
    const key = env.key as string;
    let ref = typeof env.value === "string" ? refFromAllowlistedEnv(key, env.value) : null;
    if (!ref && env.id) {
      const detail = await vercelJson<Env>(credential, withTeam(`/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(env.id)}`, teamId));
      if (typeof detail.value === "string") ref = refFromAllowlistedEnv(key, detail.value);
    }
    if (ref) refs.add(ref);
  }

  for (const ref of refs) await syncSupabaseRef(resource.resourceId, ref, "provider", 1);
  await syncIdentifier(resource.resourceId, "inference.vercel_env_scan", "v1", "provider", 1, false);
}

function githubAppJwt() {
  const appId = process.env.GITHUB_INTEGRATION_APP_ID?.trim();
  const privateKey = process.env.GITHUB_INTEGRATION_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!appId || !privateKey) throw new Error("github_app_configuration_missing");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}
async function githubInstallationToken(installationId: number) {
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${githubAppJwt()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`github_inference_token_http_${response.status}`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error("github_inference_token_missing");
  return body.token;
}
function encodeRepoPath(path: string) { return path.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }
async function inferFromGithub(resource: InferenceResource) {
  if (!resource.selected || hasMarker(resource, "inference.github_config_scan")) return;
  const fullName = typeof resource.metadata.fullName === "string" ? resource.metadata.fullName : "";
  const installationId = Number(resource.metadata.installationId);
  if (!fullName || !Number.isInteger(installationId) || installationId <= 0) return;
  const token = await githubInstallationToken(installationId);
  const refs = new Set<string>();

  for (const path of githubConfigPaths) {
    const response = await fetch(`https://api.github.com/repos/${fullName}/contents/${encodeRepoPath(path)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store"
    });
    if (response.status === 404) continue;
    if (!response.ok) continue;
    const file = await response.json() as { content?: string; encoding?: string; size?: number };
    if (typeof file.size === "number" && file.size > 131_072) continue;
    if (file.encoding !== "base64" || typeof file.content !== "string") continue;
    const text = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    if (path.endsWith("project-ref")) {
      const ref = normalizeRef(text); if (ref) refs.add(ref);
    } else for (const ref of refsFromText(text)) refs.add(ref);
  }

  for (const ref of refs) await syncSupabaseRef(resource.resourceId, ref, "discovered", 0.95);
  await syncIdentifier(resource.resourceId, "inference.github_config_scan", "v1", "discovered", 1, false);
}

export async function inferConversationRelationships(conversationId: string) {
  const context = await inferenceContext(conversationId);
  if (!context.projectId) return;

  for (const resource of context.resources.filter((item) => item.provider === "github" && item.resourceType === "repository")) {
    try { await inferFromGithub(resource); } catch { /* Discovery is best-effort and must never block chat. */ }
  }
  for (const resource of context.resources.filter((item) => item.provider === "vercel" && item.resourceType === "project")) {
    try { await inferFromVercel(resource); } catch { /* Missing scopes/credentials leave the graph unchanged. */ }
  }
}
