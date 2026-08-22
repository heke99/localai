import { describe, expect, it, vi } from "vitest";
import { GitHubAdapter, SupabaseAdapter, VaultCredentialIssuer, VercelAdapter } from "./index";

describe("provider adapters", () => {
  it("uses pinned API versions, scoped auth and redacts failures", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    await new GitHubAdapter({ token: "gh-secret", fetcher }).getRepository("heke99", "localai");
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/heke99/localai", expect.objectContaining({ headers: expect.objectContaining({ "X-GitHub-Api-Version": "2022-11-28" }) }));
  });

  it("rejects resource identifiers that could escape the configured host", async () => {
    const fetcher = vi.fn();
    await expect(new SupabaseAdapter({ projectRef: "bad/ref", accessToken: "x", fetcher }).listFunctions()).rejects.toThrow("invalid_supabase_project_ref");
    await expect(new VercelAdapter({ projectId: "../x", teamId: "team", token: "x", fetcher }).listDeployments()).rejects.toThrow("invalid_provider_identifier");
  });

  it("leases scoped dynamic credentials from Vault without returning the vault token", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ lease_id: "github/creds/run/abc", lease_duration: 120, data: { token: "short-lived" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const issuer = new VaultCredentialIssuer({ baseUrl: "https://vault.example.com", token: "vault-root", fetcher });
    const lease = await issuer.issue({ actorId: "user", connectionId: "github", resource: "github:heke99/localai", capabilities: ["repository.write"], ttlSeconds: 120 });
    expect(lease.token).toBe("short-lived");
    expect(lease.resource).toBe("github:heke99/localai");
    expect(fetcher).toHaveBeenCalledWith("https://vault.example.com/v1/github/creds/run", expect.objectContaining({ method: "POST" }));
  });
});
