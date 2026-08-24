import "server-only";
import { configuredCapabilities, fetchJson, providerCallbackUrl, requiredProviderEnv, type StoredCredential } from "./oauth";
import type { DiscoveredResource } from "./github";

interface VercelIntegrationTokenResponse {
  access_token: string;
  token_type?: string;
  team_id?: string | null;
  user_id?: string | null;
  installation_id?: string | null;
}
interface VercelLegacyTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}
interface VercelUser { id: string; email?: string; name?: string; username?: string; }
interface VercelUserResponse { user?: VercelUser; }
interface VercelTeam { id: string; slug?: string; name?: string; }
interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  accountId?: string;
  updatedAt?: number;
  link?: { type?: string; repoId?: number | string; repo?: string; org?: string; repoOwnerId?: number | string; gitCredentialId?: string };
  latestDeployments?: unknown[];
}
interface VercelProjectsResponse {
  projects?: VercelProject[];
  pagination?: { count?: number; next?: number | null; prev?: number | null };
}
interface VercelIntegrationConfiguration {
  id?: string;
  status?: string;
  projectSelection?: string;
  ownerId?: string;
  userId?: string;
}

export interface VercelCallbackContext {
  teamId?: string | null;
  configurationId?: string | null;
  source?: string | null;
}

export function vercelAuthorizationUrl(state: string) {
  const slug = requiredProviderEnv("vercel", "SLUG");
  const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeVercelCode(code: string): Promise<StoredCredential> {
  const endpoint = process.env.VERCEL_INTEGRATION_TOKEN_URL?.trim() || "https://api.vercel.com/v2/oauth/access_token";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
      client_secret: requiredProviderEnv("vercel", "CLIENT_SECRET"),
      code,
      redirect_uri: providerCallbackUrl("vercel")
    }),
    cache: "no-store"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`provider_http_${response.status}:vercel_integration_token_exchange_failed`);
  let result: VercelIntegrationTokenResponse;
  try { result = JSON.parse(text) as VercelIntegrationTokenResponse; }
  catch { throw new Error("vercel_token_response_invalid"); }
  if (!result.access_token) throw new Error("vercel_access_token_missing");
  return {
    accessToken: result.access_token,
    refreshToken: null,
    tokenType: result.token_type ?? "bearer",
    scope: null,
    expiresAt: null
  };
}

// Kept only so an already stored legacy Sign in with Vercel token can fail
// gracefully during the transition. New installation tokens are long-lived and
// are stored without refreshToken/expiresAt, so this is not called for them.
export async function refreshVercelCredential(credential: StoredCredential): Promise<StoredCredential> {
  if (!credential.refreshToken) throw new Error("vercel_refresh_token_missing");
  const response = await fetch("https://api.vercel.com/login/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
      client_secret: requiredProviderEnv("vercel", "CLIENT_SECRET"),
      refresh_token: credential.refreshToken
    }),
    cache: "no-store"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`provider_http_${response.status}:vercel_oauth_refresh_failed`);
  let result: VercelLegacyTokenResponse;
  try { result = JSON.parse(text) as VercelLegacyTokenResponse; }
  catch { throw new Error("vercel_token_response_invalid"); }
  if (!result.access_token) throw new Error("vercel_access_token_missing");
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? credential.refreshToken,
    tokenType: result.token_type ?? credential.tokenType ?? "bearer",
    scope: result.scope ?? credential.scope ?? null,
    expiresAt: typeof result.expires_in === "number" && result.expires_in > 0
      ? new Date(Date.now() + Math.max(30, result.expires_in - 30) * 1000).toISOString()
      : credential.expiresAt ?? null
  };
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function isProviderResourceDenied(error: unknown) {
  return error instanceof Error && /^provider_http_(401|403|404):/.test(error.message);
}

async function optionalUser(token: string) {
  try {
    const result = await fetchJson<VercelUserResponse>("https://api.vercel.com/v2/user", { headers: headers(token) });
    return result.user ?? null;
  } catch (error) {
    if (isProviderResourceDenied(error)) return null;
    throw error;
  }
}

async function optionalTeam(token: string, teamId: string | null) {
  if (!teamId) return null;
  try {
    const team = await fetchJson<VercelTeam>(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, { headers: headers(token) });
    return { ...team, id: team.id || teamId };
  } catch (error) {
    if (isProviderResourceDenied(error)) return { id: teamId } as VercelTeam;
    throw error;
  }
}

async function optionalConfiguration(token: string, configurationId: string, teamId: string | null) {
  try {
    const params = new URLSearchParams();
    if (teamId) params.set("teamId", teamId);
    const suffix = params.size ? `?${params.toString()}` : "";
    return await fetchJson<VercelIntegrationConfiguration>(
      `https://api.vercel.com/v1/integrations/configuration/${encodeURIComponent(configurationId)}${suffix}`,
      { headers: headers(token) }
    );
  } catch (error) {
    if (isProviderResourceDenied(error)) return null;
    throw error;
  }
}

async function listAllProjects(token: string, teamId: string | null) {
  const projects: VercelProject[] = [];
  let until: number | null = null;
  const seenCursors = new Set<number>();
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (teamId) params.set("teamId", teamId);
    if (until !== null) params.set("until", String(until));
    const result = await fetchJson<VercelProjectsResponse>(`https://api.vercel.com/v9/projects?${params.toString()}`, { headers: headers(token) });
    projects.push(...(result.projects ?? []));
    const next = typeof result.pagination?.next === "number" ? result.pagination.next : null;
    if (next === null || seenCursors.has(next) || !(result.projects?.length)) break;
    seenCursors.add(next);
    until = next;
  }
  return projects;
}

export async function discoverVercel(
  credential: StoredCredential,
  callback: VercelCallbackContext = {}
): Promise<{ externalAccountId: string; externalAccountName: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }> {
  // A real Vercel External Integration installation returns configurationId.
  // Reject identity-only Sign in with Vercel callbacks instead of recording a
  // misleading connected state with zero project scope.
  const configurationId = callback.configurationId?.trim() || "";
  if (!configurationId) throw new Error("vercel_integration_installation_required");

  const teamId = callback.teamId?.trim() || null;
  const [user, team, configuration] = await Promise.all([
    optionalUser(credential.accessToken),
    optionalTeam(credential.accessToken, teamId),
    optionalConfiguration(credential.accessToken, configurationId, teamId)
  ]);

  let projects: VercelProject[];
  try {
    projects = await listAllProjects(credential.accessToken, teamId);
  } catch (error) {
    if (isProviderResourceDenied(error)) throw new Error("vercel_project_access_denied");
    throw error;
  }

  const deduped = new Map(projects.map((project) => [project.id, project]));
  const resources: DiscoveredResource[] = [...deduped.values()].map((project) => {
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
        accountId: project.accountId ?? teamId,
        teamId,
        teamSlug: team?.slug ?? null,
        teamName: team?.name ?? null,
        link: project.link ?? null,
        updatedAt: project.updatedAt ?? null,
        integrationConfigurationId: configurationId
      },
      identifiers
    };
  });

  const projectAccess = resources.length > 0 ? "granted" : "no_projects_selected";
  const accountId = teamId || user?.id || configuration?.ownerId || configuration?.userId || configurationId;
  const accountName = team?.name || team?.slug || user?.username || user?.email || user?.name || String(accountId);
  const scope = teamId ? [{ type: "team", id: teamId, slug: team?.slug ?? null, name: team?.name ?? null }] : [];

  return {
    externalAccountId: String(accountId),
    externalAccountName: accountName,
    metadata: {
      accessModel: "vercel_integration_installation",
      projectAccess,
      username: user?.username ?? null,
      email: user?.email ?? null,
      teamIds: teamId ? [teamId] : [],
      teams: teamId ? [{ id: teamId, slug: team?.slug ?? null, name: team?.name ?? null }] : [],
      identity: {
        account: { id: String(accountId), name: accountName, email: user?.email ?? null },
        scopes: scope
      },
      accessibleProjectCount: resources.length,
      callbackTeamId: teamId,
      callbackConfigurationId: configurationId,
      callbackSource: callback.source ?? null,
      projectSelection: configuration?.projectSelection ?? null,
      configurationStatus: configuration?.status ?? null
    },
    capabilities: resources.length > 0 ? configuredCapabilities("vercel") : [],
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
