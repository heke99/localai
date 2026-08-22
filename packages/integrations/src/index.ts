type Fetcher = typeof fetch;
import type { CredentialIssuer, ScopedCredential } from "@div3rsa/platform-core";
const idPattern = /^[A-Za-z0-9_.-]+$/;

async function jsonRequest(fetcher: Fetcher, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`provider_request_failed:${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("provider_response_not_json");
  return response.json();
}

export class GitHubAdapter {
  constructor(private readonly config: { token: string; fetcher?: Fetcher }) {}
  getRepository(owner: string, repo: string) {
    if (!idPattern.test(owner) || !idPattern.test(repo)) throw new Error("invalid_github_repository");
    return jsonRequest(this.config.fetcher ?? fetch, `https://api.github.com/repos/${owner}/${repo}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.config.token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  }
  getTree(owner: string, repo: string, revision: string) {
    if (!idPattern.test(owner) || !idPattern.test(repo) || !/^[A-Fa-f0-9]{40}$/.test(revision)) throw new Error("github_revision_must_be_pinned");
    return jsonRequest(this.config.fetcher ?? fetch, `https://api.github.com/repos/${owner}/${repo}/git/trees/${revision}?recursive=1`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.config.token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  }
}

export class SupabaseAdapter {
  constructor(private readonly config: { projectRef: string; accessToken: string; fetcher?: Fetcher }) {}
  listFunctions() {
    if (!/^[a-z]{20}$/.test(this.config.projectRef)) return Promise.reject(new Error("invalid_supabase_project_ref"));
    return jsonRequest(this.config.fetcher ?? fetch, `https://api.supabase.com/v1/projects/${this.config.projectRef}/functions`, { headers: { Authorization: `Bearer ${this.config.accessToken}` } });
  }
}

export class VercelAdapter {
  constructor(private readonly config: { projectId: string; teamId: string; token: string; fetcher?: Fetcher }) {}
  listDeployments() {
    if (!idPattern.test(this.config.projectId) || !idPattern.test(this.config.teamId)) return Promise.reject(new Error("invalid_provider_identifier"));
    const params = new URLSearchParams({ projectId: this.config.projectId, teamId: this.config.teamId, limit: "20" });
    return jsonRequest(this.config.fetcher ?? fetch, `https://api.vercel.com/v6/deployments?${params}`, { headers: { Authorization: `Bearer ${this.config.token}` } });
  }
}

export class VaultCredentialIssuer implements CredentialIssuer {
  private readonly baseUrl: string;
  constructor(private readonly config: { baseUrl: string; token: string; namespace?: string; role?: string; fetcher?: Fetcher }) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") throw new Error("invalid_vault_url");
    this.baseUrl = url.origin;
  }
  async issue(input: { actorId: string; connectionId: string; resource: string; capabilities: string[]; ttlSeconds: number }): Promise<ScopedCredential> {
    const role = this.config.role ?? "run";
    if (!idPattern.test(input.connectionId) || !idPattern.test(role)) throw new Error("invalid_vault_credential_path");
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Vault-Token": this.config.token };
    if (this.config.namespace) headers["X-Vault-Namespace"] = this.config.namespace;
    const response = await jsonRequest(this.config.fetcher ?? fetch, `${this.baseUrl}/v1/${input.connectionId}/creds/${role}`, { method: "POST", headers, body: JSON.stringify({ ttl: `${input.ttlSeconds}s`, meta: { actor_id: input.actorId, resource: input.resource, capabilities: input.capabilities } }) }) as { lease_id?: string; lease_duration?: number; data?: { token?: string } };
    if (!response.lease_id || !response.data?.token || !response.lease_duration) throw new Error("vault_lease_invalid");
    return { token: response.data.token, expiresAt: new Date(Date.now() + Math.min(response.lease_duration, input.ttlSeconds) * 1000), capabilities: new Set(input.capabilities), resource: input.resource };
  }
  async revoke(leaseId: string): Promise<void> {
    if (!leaseId || leaseId.length > 512) throw new Error("invalid_vault_lease_id");
    await jsonRequest(this.config.fetcher ?? fetch, `${this.baseUrl}/v1/sys/leases/revoke`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Vault-Token": this.config.token }, body: JSON.stringify({ lease_id: leaseId }) });
  }
}
