import { createClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import { OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import { AgentWorkerProcessor } from "./processor";
import { SupabaseAgentQueue } from "./supabase-queue";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import { RemoteProviderToolExecutor } from "./remote-provider-executor";
import { RemoteRepositoryWorkspaceRuntime } from "./repository-runtime";
import { SandboxVerificationRuntime } from "./sandbox-verification";
import { SkillEngine, type SkillManifest } from "@div3rsa/skill-engine";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

const supabase = createClient<Database>(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const adapter = new OpenAiCompatibleAdapter(required("QWEN_INFERENCE_BASE_URL"), required("QWEN_INFERENCE_API_KEY"));
const queue = new SupabaseAgentQueue(supabase);
const workerId = process.env.DIV3RSA_WORKER_ID ?? `agent-worker-${process.pid}`;
const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT ?? process.cwd();
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "skills/runtime-manifest.json"), "utf8")) as SkillManifest;
const skillEngine = new SkillEngine(manifest, { read: (path) => readFile(resolve(repositoryRoot, path), "utf8") });

// The worker never receives provider OAuth tokens. It gets a short-lived one-time execution grant
// and sends only that grant plus tool arguments to the server-side integration gateway.
const gatewayUrl = process.env.DIV3RSA_INTEGRATION_GATEWAY_URL?.trim() || "https://system.div3rsa.com/api/internal/integrations/execute";
const remoteExecutor = new RemoteProviderToolExecutor(gatewayUrl);
const executors = new Map([
  ["github", remoteExecutor],
  ["supabase", remoteExecutor],
  ["vercel", remoteExecutor]
]);
const toolRuntime = new PermissionedIntegrationToolRuntime(supabase as unknown as ConstructorParameters<typeof PermissionedIntegrationToolRuntime>[0], executors);
const repositoryRuntime = new RemoteRepositoryWorkspaceRuntime(supabase as unknown as ConstructorParameters<typeof RemoteRepositoryWorkspaceRuntime>[0], gatewayUrl);
const sandboxRuntime = new SandboxVerificationRuntime(process.env.DIV3RSA_SANDBOX_IMAGE_DIGEST?.trim() || null);
const processor = new AgentWorkerProcessor(queue, { resolve: () => adapter }, workerId, {
  prepare: async (mode, prompt) => {
    const loaded = await skillEngine.load(skillEngine.select(mode, prompt));
    return { names: loaded.map((skill) => skill.metadata.name), instructions: loaded.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n") };
  }
}, toolRuntime, repositoryRuntime, sandboxRuntime);
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const health = await adapter.healthCheck();
if (!health.ok) throw new Error(`model_unhealthy:${health.detail ?? "unknown"}`);

while (!stopping) {
  const processed = await processor.processOnce();
  if (!processed) await new Promise((resolve) => setTimeout(resolve, 1000));
}
