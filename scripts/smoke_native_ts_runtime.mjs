const modules = [
  "../services/model-gateway/src/index.ts",
  "../packages/agent-runtime/src/index.ts",
  "../packages/integrations/src/index.ts",
  "../packages/repository-intelligence/src/index.ts",
  "../packages/repository-intelligence/src/consequence.ts",
  "../packages/platform-core/src/index.ts",
  "../packages/sandbox-runtime/src/index.ts",
  "../packages/skill-engine/src/index.ts",
  "../services/agent-worker/src/processor.ts",
  "../services/agent-worker/src/integration-tool-runtime.ts",
  "../services/agent-worker/src/remote-provider-executor.ts",
  "../services/agent-worker/src/repository-runtime.ts",
  "../services/agent-worker/src/repository-tools.ts",
  "../services/agent-worker/src/sandbox-verification.ts",
  "../services/agent-worker/src/supabase-queue.ts",
  "../services/agent-worker/src/observability.ts",
  "../services/agent-worker/src/worker-verification.ts"
];

for (const specifier of modules) {
  await import(new URL(specifier, import.meta.url));
}

console.info(`[native-ts-runtime] loaded ${modules.length} production modules`);
