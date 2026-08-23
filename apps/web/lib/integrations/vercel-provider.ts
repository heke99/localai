import "server-only";
import { configuredCapabilities, fetchJson, providerCallbackUrl, requiredProviderEnv, type StoredCredential } from "./oauth";
import type { DiscoveredResource } from "./github";

interface VercelTokenResponse { access_token: string; token_type?: string; team_id?: string | null; user_id?: string | null; }
interface VercelUserResponse { user?: { id?: string; uid?: string; username?: string; email?: string }; }
interface VercelTeam { id: string; slug?: string; name?: string; }
interface VercelProject { id: string; name: string; framework?: string | null; accountId?: string; updatedAt?: number; link?: { type?: string; repoId?: number | string; repo?: string; org?: string; repoOwnerId?: number | string; gitCredentialId?: string }; latestDeployments?: unknown[]; }
interface VercelProjectsResponse { projects?: VercelProject[]; }

export interface VercelCallbackContext {
  teamId?: string | null;
  configurationId?: string | null;
  source?: string | null;
}

export function vercelAuthorizationUrl(state: string) {
  const configured = process.env.VERCEL_INTEGRATION_INSTALL_URL?.trim();
  const slug = process.env.VERCEL_INTEGRATION_SLUG?.trim();
  if (!configured && !slug) throw new Error("provider_configuration_missing:VERCEL_INTEGRATION_SLUG");
  const url = new URL(configured || `https://vercel.com/integrations/${encodeURIComponent(slug!)}/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(params: URLSearchParams) {
  const endpoint = process.env.VERCEL_INTEGRATION_TOKEN_URL?.trim() || "https://api.vercel.com/v2/oauth/access_token";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    cache: "no-store"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`provider_http_${response.status}:vercel_integration_token_exchange_failed`);
  try {
    const result = JSON.parse(text) as VercelTokenResponse;
    if (!result.access_token) throw new Error("vercel_installation_access_token_missing");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "vercel_installation_access_token_missing") throw error;
    throw new Error("vercel_token_response_invalid");
  }
}

function stored(result: VercelTokenResponse): StoredCredential {
  // External Integration access tokens are long-lived installation credentials.
  // They are revoked by uninstalling/changing the Vercel integration rather than
  // refreshed with the Sign in with Vercel refresh-token flow.
  return { accessToken: result.access_token, refreshToken: null, tokenType: result.token_type ?? "bearer", scope: null, expiresAt: null };
}

export async function exchangeVercelCode(code: string) {
  const result = await tokenRequest(new URLSearchParams({
    client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
    client_secret: requiredProviderEnv("vercel", "CLIENT_SECRET"),
    code,
    redirect_uri: providerCallbackUrl("vercel")
  }));
  return { credential: stored(result), tokenContext: { teamId: result.team_id ?? null, userId: result.user_id ?? null } };
}

export async function refreshVercelCredential(_credential: StoredCredential): Promise<StoredCredential> {
  throw new Error("vercel_installation_token_not_refreshable");
}

function headers(token: string): HeadersInit { return { Authorization: `Bearer ${token}`, Accept: "application/json" }; }

async function listProjects(token: string, teamId: string | null) {
  const params = new URLSearchParams({ limit: "100" });
  if (teamId) params.set("teamId", teamId);
  const result = await fetchJson<VercelProjectsResponse>(`https://api.vercel.com/v9/projects?${params.toString()}`, { headers: headers(token) });
  return result.projects ?? [];
}

async function readTeam(token: string, teamId: string | null) {
  if (!teamId) return null;
  return fetchJson<VercelTeam>(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, { headers: headers(token) }).catch(() => null);
}

async function readUser(token: string) {
  return fetchJson<VercelUserResponse>("https://api.vercel.com/v2/user", { headers: headers(token) }).catch(() => null);
}

export async function discoverVercel(
  credential: StoredCredential,
  callback: VercelCallbackContext = {},
  tokenContext: { teamId?: string | null; userId?: string | null } = {}
): Promise<{ externalAccountId: string; externalAccountName: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }> {
  const teamId = callback.teamId || tokenContext.teamId || null;
  const configurationId = callback.configurationId || null;
  const [userResponse, team, projects] = await Promise.all([
    readUser(credential.accessToken),
    readTeam(credential.accessToken, teamId),
    listProjects(credential.accessToken, teamId)
  ]);
  const user = userResponse?.user ?? {};
  const userId = user.id || user.uid || tokenContext.userId || null;
  const accountId = teamId || userId || configurationId;
  if (!accountId) throw new Error("vercel_installation_identity_missing");
  const accountName = team?.name || team?.slug || user.username || user.email || String(accountId);

  const resources: DiscoveredResource[] = projects.map((project) => {
    const identifiers: DiscoveredResource["identifiers"] = [{ kind: "vercel.project_id", value: project.id, confidence: 1, linkable: false }];
    if (project.link?.type === "github") {
      if (project.link.repoId) identifiers.push({ kind: "github.repository_id", value: String(project.link.repoId), confidence: 1, linkable: true });
      if (project.link.org && project.link.repo) identifiers.push({ kind: "git.repository_url", value: `https://github.com/${String(project.link.org).toLowerCase()}/${String(project.link.repo).toLowerCase()}`, confidence: 1, linkable: true });
    }
    return {
      resourceType: "project",
      externalId: project.id,
      displayName: project.name,
      metadata: {
        projectId: project.id,
        name: project.name,
        framework: project.framework ?? null,
        accountId: project.accountId ?? null,
        teamId,
        teamSlug: team?.slug ?? null,
        teamName: team?.name ?? null,
        configurationId,
        link: project.link ?? null,
        updatedAt: project.updatedAt ?? null
      },
      identifiers
    };
  });

  return {
    externalAccountId: String(accountId),
    externalAccountName: accountName,
    metadata: {
      accessModel: "vercel_external_integration",
      configurationId,
      source: callback.source ?? null,
      teamId,
      teamSlug: team?.slug ?? null,
      teamName: team?.name ?? null,
      userId,
      username: user.username ?? null,
      email: user.email ?? null,
      accessibleProjectCount: resources.length
    },
    capabilities: configuredCapabilities("vercel"),
    resources
  };
}

function coordinates(metadata: Record<string,unknown>, externalId: string) {
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId : externalId;
  const projectName = typeof metadata.name === "string" ? metadata.name : projectId;
  const teamId = typeof metadata.teamId === "string" ? metadata.teamId : null;
  return { projectId, projectName, teamId, link: metadata.link && typeof metadata.link === "object" && !Array.isArray(metadata.link) ? metadata.link as Record<string,unknown> : null };
}

async function vercelApi<T>(credential: StoredCredential, path: string, init: RequestInit = {}) {
  return fetchJson<T>(`https://api.vercel.com${path}`, { ...init, headers: { ...headers(credential.accessToken), ...(init.headers ?? {}) } });
}

function withTeam(path: string, teamId: string | null) {
  if (!teamId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}

export async function executeVercelTool(toolName: string, args: Record<string,unknown>, metadata: Record<string,unknown>, externalId: string, credential: StoredCredential) {
  const { projectId, projectName, teamId, link } = coordinates(metadata, externalId);
  if (toolName === "vercel_read_deployments") return vercelApi(credential, withTeam(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=50`, teamId));
  if (toolName === "vercel_read_logs") {
    const deploymentId = typeof args.deploymentId === "string" ? args.deploymentId : "";
    if (!deploymentId) return vercelApi(credential, withTeam(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=10`, teamId));
    return vercelApi(credential, withTeam(`/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`, teamId));
  }
  if (toolName === "vercel_create_deployment") {
    const body: Record<string,unknown> = { name: projectName, project: projectId, target: "production" };
    const ref = typeof args.ref === "string" && args.ref ? args.ref : "main";
    if (link?.type === "github" && typeof link.repo === "string" && typeof link.org === "string") body.gitSource = { type: "github", repo: link.repo, org: link.org, ref };
    else body.project = projectId;
    return vercelApi(credential, withTeam("/v13/deployments", teamId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  if (toolName === "vercel_rollback_deployment") {
    return vercelApi(credential, withTeam(`/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(String(args.deploymentId ?? ""))}`, teamId), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }
  throw new Error("vercel_tool_not_supported");
}
