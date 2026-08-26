import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../../../../../lib/supabase/admin";

type RpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: { code?: string; message?: string } | null }>;
};

type BootstrapRow = {
  provider_key: string;
  model_alias: string;
  external_worker_id: string;
  profile: string;
};

const noStoreHeaders = {
  "cache-control": "no-store, private, max-age=0",
  pragma: "no-cache"
};

function serverConfiguration() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const inferenceApiKey = process.env.DIV3RSA_INFERENCE_API_KEY?.trim() || process.env.QWEN_INFERENCE_API_KEY?.trim();
  if (!supabaseUrl || !supabaseSecretKey || !inferenceApiKey) return null;
  return { supabaseUrl, supabaseSecretKey, inferenceApiKey };
}

export async function POST(request: Request) {
  const configuration = serverConfiguration();
  if (!configuration) {
    return NextResponse.json({ error: "runtime_bootstrap_unavailable" }, { status: 503, headers: noStoreHeaders });
  }

  const body = await request.json().catch(() => null) as { token?: string } | null;
  const token = body?.token?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return NextResponse.json({ error: "invalid_runtime_bootstrap" }, { status: 401, headers: noStoreHeaders });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rpc = createSupabaseAdminClient() as unknown as RpcClient;
  const { data, error } = await rpc.rpc<BootstrapRow[]>("runtime_consume_bootstrap_token", { target_token_hash: tokenHash });
  const grant = data?.[0];
  if (error || !grant) {
    return NextResponse.json({ error: "invalid_runtime_bootstrap" }, { status: 401, headers: noStoreHeaders });
  }

  return NextResponse.json({
    contract: "div3rsa-runtime-v1",
    providerKey: grant.provider_key,
    modelAlias: grant.model_alias,
    externalId: grant.external_worker_id,
    profile: grant.profile,
    aliases: (process.env.DIV3RSA_RUNTIME_ALIASES?.trim() || "general-prod,code-prod,lab-prod,research-prod")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    repositoryUrl: process.env.DIV3RSA_RUNTIME_GIT_URL?.trim() || "https://github.com/heke99/localai.git",
    repositoryRef: process.env.DIV3RSA_RUNTIME_GIT_REF?.trim() || "main",
    llamaCppRevision: process.env.DIV3RSA_LLAMA_CPP_REVISION?.trim() || "b10605",
    integrationGatewayUrl: process.env.DIV3RSA_INTEGRATION_GATEWAY_URL?.trim() || "https://system.div3rsa.com/api/internal/integrations/execute",
    supabaseUrl: configuration.supabaseUrl,
    supabaseSecretKey: configuration.supabaseSecretKey,
    inferenceApiKey: configuration.inferenceApiKey
  }, { status: 200, headers: noStoreHeaders });
}
