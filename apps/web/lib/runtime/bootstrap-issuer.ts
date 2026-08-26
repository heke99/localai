import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createSupabaseAdminClient } from "../supabase/admin";
import type { RuntimeBootstrapGrant, RuntimeBootstrapIssuer } from "./contracts";

type RpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: { code?: string; message?: string } | null }>;
};

function appUrl() {
  const raw = process.env.APP_URL?.trim() || "https://system.div3rsa.com";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("runtime_bootstrap_https_required");
  return parsed.origin;
}

export class SupabaseRuntimeBootstrapIssuer implements RuntimeBootstrapIssuer {
  async issue(input: Parameters<RuntimeBootstrapIssuer["issue"]>[0]): Promise<RuntimeBootstrapGrant> {
    const ttlSeconds = Math.min(3600, Math.max(60, input.ttlSeconds ?? 900));
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const rpc = createSupabaseAdminClient() as unknown as RpcClient;
    const { error } = await rpc.rpc<string>("runtime_create_bootstrap_token_hash", {
      target_token_hash: tokenHash,
      target_provider_key: input.providerKey,
      target_model_alias: input.alias,
      target_external_worker_id: input.externalId,
      target_profile: input.profile,
      target_ttl_seconds: ttlSeconds
    });
    if (error) throw new Error(`runtime_bootstrap_issue_failed:${error.code ?? "unknown"}`);

    return {
      token,
      bootstrapUrl: `${appUrl()}/api/internal/runtime/bootstrap`,
      expiresInSeconds: ttlSeconds
    };
  }
}
