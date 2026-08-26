import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("SupabaseRuntimeBootstrapIssuer", () => {
  it("is server-only and stores only a hash through the runtime bootstrap RPC", async () => {
    process.env.APP_URL = "https://system.div3rsa.com";
    const rpc = vi.fn().mockResolvedValue({ data: "id", error: null });
    vi.doMock("../supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));
    vi.doMock("server-only", () => ({}));
    const { SupabaseRuntimeBootstrapIssuer } = await import("./bootstrap-issuer");

    const grant = await new SupabaseRuntimeBootstrapIssuer().issue({
      providerKey: "hyperstack",
      alias: "general-prod",
      externalId: "runtime-1",
      profile: "large_96gb",
      ttlSeconds: 600
    });

    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(grant.bootstrapUrl).toBe("https://system.div3rsa.com/api/internal/runtime/bootstrap");
    expect(rpc).toHaveBeenCalledTimes(1);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.target_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.target_token_hash).not.toBe(grant.token);
  });
});
