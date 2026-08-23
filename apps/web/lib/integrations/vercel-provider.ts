import "server-only";
import { configuredCapabilities, credentialExpiry, fetchJson, providerCallbackUrl, requiredProviderEnv, type StoredCredential } from "./oauth";
import type { DiscoveredResource } from "./github";

interface VercelTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}
interface VercelUserInfoResponse { sub: string; email?: string; name?: string; preferred_username?: string; picture?: string; }
interface VercelTeam { id: string; slug?: string; name?: string; }
interface VercelTeamsResponse { teams?: VercelTeam[]; }
interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  accountId?: string;
  updatedAt?: number;
  link?: { type?: string; repoId?: number | string; repo?: string; org?: string; repoOwnerId?: number | string; gitCredentialId?: string };
  latestDeployments?: unknown[];
}
interface VercelProjectsResponse { projects?: VercelProject[]; }

export interface VercelCallbackContext {
  teamId?: string | null;
  configurationId?: string | null;
  source?: string | null;
}

export function vercelAuthorizationUrl(state: string, codeChallenge: string) {
  const authorizeUrl = process.env.VERCEL_INTEGRATION_AUTHORIZE_URL?.trim() || "https://vercel.com/oauth/authorize";
  const scope = process.env.VERCEL_INTEGRATION_OAUTH_SCOPES?.trim() || "openid email profile offline_access";
  const query = new URLSearchParams({
    client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
    redirect_uri: providerCallbackUrl("vercel"),
    response_type: "code",
    prompt: "login",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope
  });
  return `${authorizeUrl}?${query.toString()}`;
}

async function tokenRequest(params: URLSearchParams) {
  const endpoint = process.env.VERCEL_INTEGRATION_TOKEN_URL?.trim() || "https://api.vercel.com/login/oauth/token";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    cache: "no-store"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`provider_http_${response.status}:vercel_oauth_token_exchange_failed`);
  try {
    const result = JSON.parse(text) as VercelTokenResponse;
    if (!result.access_token) throw new Error("vercel_access_token_missing");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "vercel_access_token_missing") throw error;
    throw new Error("vercel_token_response_invalid");
  }
}

function stored(result: VercelTokenResponse): StoredCredential {
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    tokenType: result.token_type ?? "bearer",
    scope: result.scope ?? null,
    expiresAt: credentialExpiry(result.expires_in)
  };
}

export async function exchangeVercelCode(code: string, codeVerifier: string) {
  const result = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
    client_secret: requiredProviderEnv("vercel", "CLIENT_SECRET"),
    code,
    code_verifier: codeVerifier,
    redirect_uri: providerCallbackUrl("vercel")
  }));
  return stored(result);
}

export async function refreshVercelCredential(credential: StoredCredential): Promise<StoredCredential> {
  if (!credential.refreshToken) throw new Error("vercel_refresh_token_missing");
  const result = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requiredProviderEnv("vercel", "CLIENT_ID"),
    client_secret: requiredProviderEnv("vercel", "CLIENT_SECRET"),
    refresh_token: credential.refreshToken
  }));
  const next = stored(result);
  if (!next.refreshToken) next.refreshToken = credential.refreshToken;
  return next;
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function isProviderResourceDenied(error: unknown) {
  return error instanceof Error && /^provider_http_(401|403|404):/.test(error.message);
}

async function listProjects(token: string, team?: VercelTeam) {
  const params = new URLSearchParams({ limit: "100" });
  if (team?.id) params.set("teamId", team.id);
  const result = await fetchJson<VercelProjectsResponse>(`https://api.vercel.com/v9/projects?${params.toString()}`, { headers: headers(token) });
  return (result.projects ?? []).map((project) => ({ project, team }));
}

export async function discoverVercel(
  credential: StoredCredential,
  callback: VercelCallbackContext = {}
): Promise<{ externalAccountId: string; externalAccountName: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }> {
  const user = await fetchJson<VercelUserInfoResponse>("https://api.vercel.com/login/oauth/userinfo", {
    method: "POST",
    headers: headers(credential.accessToken)
  });
  const accountId = user.sub || user.email || user.preferred_username;
  if (!accountId) throw new Error("vercel_profile_identity_missing");

  let teams: VercelTeam[] = [];
  let teamsPermissionDenied = false;
  try {
    const teamResponse = await fetchJson<VercelTeamsResponse>("https://api.vercel.com/v2/teams?limit=100", { headers: headers(credential.accessToken) });
    teams = teamResponse.teams ?? [];
  } catch (error) {
    if (!isProviderResourceDenied(error)) throw error;
    teamsPermissionDenied = true;
  }

  if (callback.teamId && !teams.some((team) => team.id === callback.teamId)) teams = [...teams, { id: callback.teamId }];

  const projectGroups: Array<Array<{ project: VercelProject; team?: VercelTeam }>> = [];
  let projectPermissionSuccesses = 0;
  let projectPermissionDenials = 0;

  try {
    projectGroups.push(await listProjects(credential.accessToken));
    projectPermissionSuccesses += 1;
  } catch (error) {
    if (!isProviderResourceDenied(error)) throw error;
    projectPermissionDenials += 1;
  }

  for (const team of teams) {
    try {
      projectGroups.push(await listProjects(credential.accessToken, team));
      projectPermissionSuccesses += 1;
    } catch (error) {
      if (!isProviderResourceDenied(error)) throw error;
      projectPermissionDenials += 1;
    }
  }

  if ((teamsPermissionDenied || projectPermissionDenials > 0) && projectPermissionSuccesses === 0) {
    throw new Error("vercel_project_discovery_unavailable");
  }

  for (const group of projectGroups) {
    for (const item of group) {
      if (!item.team && item.project.accountId) item.team = teams.find((team) => team.id === item.project.accountId);
    }
  }

  const deduped = new Map<string, { project: VercelProject; team?: VercelTeam }>();
  for (const item of projectGroups.flat()) deduped.set(item.project.id, item);

  const resources: DiscoveredResource[] = [...deduped.values()].map(({ project, team }) => {
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
        teamId: team?.id ?? null,
        teamSlug: team?.slug ?? null,
        teamName: team?.name ?? null,
        link: project.link ?? null,
        updatedAt: project.updatedAt ?? null
      },
      identifiers
    };
  });

  if (!teams.length && !resources.length) throw new Error("vercel_project_discovery_unavailable");

  const accountName = user.preferred_username || user.email || user.name || String(accountId);
  const teamMetadata = teams.map((team) => ({ id: team.id, slug: team.slug ?? null, name: team.name ?? null }));
  return {
    externalAccountId: String(accountId),
    externalAccountName: accountName,
    metadata: {
      accessModel: "vercel_app_oauth_team_installation",
      username: user.preferred_username ?? null,
      email: user.email ?? null,
      teamIds: teams.map((team) => team.id),
      teams: teamMetadata,
      identity: {
        account: { id: String(accountId), name: accountName, email: user.email ?? null },
        scopes: teamMetadata.map((team) => ({ type: "team", ...team }))
      },
      accessibleProjectCount: resources.length,
      permissionDenialsObserved: projectPermissionDenials
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