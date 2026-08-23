import "server-only";
import crypto from "node:crypto";
import { configuredCapabilities, fetchJson, providerCallbackUrl, requiredProviderEnv, type StoredCredential } from "./oauth";

interface GitHubUser { id: number; login: string; }
interface GitHubInstallation { id: number; account?: { id?: number; login?: string }; permissions?: Record<string,string>; repository_selection?: string; }
interface GitHubRepository { id: number; node_id?: string; name: string; full_name: string; private: boolean; html_url: string; default_branch: string; owner: { login: string; id: number }; }

export interface DiscoveredResource {
  resourceType: "repository" | "project";
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown>;
  identifiers: Array<{ kind: string; value: string; confidence: number; linkable: boolean }>;
}

export function githubAuthorizationUrl(state: string) {
  const slug = requiredProviderEnv("github", "APP_SLUG");
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function exchangeGithubCode(code: string) {
  const body = new URLSearchParams({
    client_id: requiredProviderEnv("github", "CLIENT_ID"),
    client_secret: requiredProviderEnv("github", "CLIENT_SECRET"),
    code,
    redirect_uri: providerCallbackUrl("github")
  });
  return fetchJson<{ access_token: string; token_type?: string; scope?: string }>("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

function githubHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

function permissionAtLeast(value: string | undefined, wanted: "read" | "write") {
  if (wanted === "read") return value === "read" || value === "write";
  return value === "write";
}

function capabilitiesFromInstallations(installations: GitHubInstallation[]) {
  const permissions: Record<string,string> = {};
  for (const installation of installations) {
    for (const [key, value] of Object.entries(installation.permissions ?? {})) {
      if (value === "write" || permissions[key] !== "write") permissions[key] = value;
    }
  }
  const allowed = new Set<string>();
  if (permissionAtLeast(permissions.metadata, "read")) allowed.add("github.repository.read");
  if (permissionAtLeast(permissions.contents, "read")) allowed.add("github.contents.read");
  if (permissionAtLeast(permissions.contents, "write")) { allowed.add("github.contents.write"); allowed.add("github.branch.create"); }
  if (permissionAtLeast(permissions.pull_requests, "read")) allowed.add("github.pull_request.read");
  if (permissionAtLeast(permissions.pull_requests, "write")) { allowed.add("github.pull_request.create"); allowed.add("github.pull_request.merge"); }
  if (permissionAtLeast(permissions.actions, "read")) allowed.add("github.actions.read");
  if (permissionAtLeast(permissions.actions, "write")) allowed.add("github.actions.run");
  if (permissionAtLeast(permissions.workflows, "write")) allowed.add("github.workflow.write");
  const catalog = configuredCapabilities("github");
  return catalog.filter((capability) => allowed.size === 0 || allowed.has(capability));
}

export async function discoverGithub(accessToken: string): Promise<{ externalAccountId: string; externalAccountName: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }> {
  const user = await fetchJson<GitHubUser>("https://api.github.com/user", { headers: githubHeaders(accessToken) });
  const installationPage = await fetchJson<{ installations: GitHubInstallation[] }>("https://api.github.com/user/installations?per_page=100", { headers: githubHeaders(accessToken) });
  const installations = installationPage.installations ?? [];
  const resources: DiscoveredResource[] = [];
  for (const installation of installations) {
    const repoPage = await fetchJson<{ repositories: GitHubRepository[] }>(`https://api.github.com/user/installations/${installation.id}/repositories?per_page=100`, { headers: githubHeaders(accessToken) });
    for (const repo of repoPage.repositories ?? []) {
      resources.push({
        resourceType: "repository",
        externalId: String(repo.id),
        displayName: repo.full_name,
        metadata: {
          repositoryId: repo.id,
          nodeId: repo.node_id ?? null,
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          private: repo.private,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch,
          installationId: installation.id,
          installationAccount: installation.account?.login ?? null
        },
        identifiers: [
          { kind: "github.repository_id", value: String(repo.id), confidence: 1, linkable: true },
          { kind: "git.repository_url", value: `https://github.com/${repo.full_name.toLowerCase()}`, confidence: 1, linkable: true }
        ]
      });
    }
  }
  return {
    externalAccountId: String(user.id),
    externalAccountName: user.login,
    metadata: { login: user.login, installationIds: installations.map((item) => item.id) },
    capabilities: capabilitiesFromInstallations(installations),
    resources
  };
}

function githubAppJwt() {
  const appId = requiredProviderEnv("github", "APP_ID");
  const privateKey = requiredProviderEnv("github", "PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function installationToken(installationId: number) {
  const result = await fetchJson<{ token: string; expires_at: string }>(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(githubAppJwt())
  });
  return result.token;
}

function repositoryCoordinates(metadata: Record<string,unknown>) {
  const fullName = typeof metadata.fullName === "string" ? metadata.fullName : "";
  const installationId = Number(metadata.installationId);
  if (!fullName || !Number.isInteger(installationId) || installationId <= 0) throw new Error("github_resource_metadata_invalid");
  return { fullName, installationId };
}

function encodeRepoPath(path: string) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function githubApi<T>(token: string, path: string, init: RequestInit = {}) {
  return fetchJson<T>(`https://api.github.com${path}`, { ...init, headers: { ...githubHeaders(token), ...(init.headers ?? {}) } });
}

export async function executeGithubTool(toolName: string, args: Record<string,unknown>, metadata: Record<string,unknown>) {
  const { fullName, installationId } = repositoryCoordinates(metadata);
  const token = await installationToken(installationId);
  const repoPath = `/repos/${fullName}`;

  if (toolName === "github_read_file") {
    const path = String(args.path ?? "");
    const ref = typeof args.ref === "string" && args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
    return githubApi(token, `${repoPath}/contents/${encodeRepoPath(path)}${ref}`);
  }
  if (toolName === "github_write_file") {
    const path = String(args.path ?? "");
    const branch = String(args.branch ?? "");
    const currentResponse = await fetch(`https://api.github.com${repoPath}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders(token), cache: "no-store" });
    let sha: string | undefined;
    if (currentResponse.ok) {
      const current = await currentResponse.json() as { sha?: string };
      sha = current.sha;
    } else if (currentResponse.status !== 404) throw new Error(`provider_http_${currentResponse.status}:github_read_before_write_failed`);
    return githubApi(token, `${repoPath}/contents/${encodeRepoPath(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: String(args.message ?? "Update via DIV3RSA"), content: Buffer.from(String(args.content ?? ""), "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) })
    });
  }
  if (toolName === "github_create_branch") {
    const baseRef = String(args.baseRef ?? "main").replace(/^refs\/heads\//, "");
    const branch = String(args.branch ?? "").replace(/^refs\/heads\//, "");
    const base = await githubApi<{ object: { sha: string } }>(token, `${repoPath}/git/ref/heads/${encodeURIComponent(baseRef)}`);
    return githubApi(token, `${repoPath}/git/refs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
  }
  if (toolName === "github_read_pull_requests") {
    const state = String(args.state ?? "open");
    return githubApi(token, `${repoPath}/pulls?state=${encodeURIComponent(state)}&per_page=50`);
  }
  if (toolName === "github_create_pull_request") {
    return githubApi(token, `${repoPath}/pulls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: String(args.title ?? ""), body: String(args.body ?? ""), head: String(args.head ?? ""), base: String(args.base ?? "main") }) });
  }
  if (toolName === "github_merge_pull_request") {
    return githubApi(token, `${repoPath}/pulls/${Number(args.pullNumber)}/merge`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merge_method: String(args.mergeMethod ?? "squash") }) });
  }
  if (toolName === "github_read_actions") {
    const branch = typeof args.branch === "string" && args.branch ? `&branch=${encodeURIComponent(args.branch)}` : "";
    return githubApi(token, `${repoPath}/actions/runs?per_page=50${branch}`);
  }
  if (toolName === "github_run_action") {
    return githubApi(token, `${repoPath}/actions/workflows/${encodeURIComponent(String(args.workflow ?? ""))}/dispatches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: String(args.ref ?? "main"), inputs: args.inputs && typeof args.inputs === "object" ? args.inputs : {} }) });
  }
  throw new Error("github_tool_not_supported");
}

export function verifyGithubWebhook(rawBody: string, signature: string | null) {
  const secret = requiredProviderEnv("github", "WEBHOOK_SECRET");
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}

export type GitHubTransientCredential = StoredCredential;
