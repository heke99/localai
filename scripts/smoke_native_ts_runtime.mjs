const projectModules = [
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
  "../services/agent-worker/src/core-tool-runtime.ts",
  "../services/agent-worker/src/composite-tool-runtime.ts",
  "../services/agent-worker/src/remote-provider-executor.ts",
  "../services/agent-worker/src/repository-runtime.ts",
  "../services/agent-worker/src/repository-tools.ts",
  "../services/agent-worker/src/sandbox-verification.ts",
  "../services/agent-worker/src/supabase-queue.ts",
  "../services/agent-worker/src/observability.ts",
  "../services/agent-worker/src/worker-verification.ts"
];

const dependencyModules = ["@supabase/supabase-js"];

for (const specifier of projectModules) {
  await import(new URL(specifier, import.meta.url));
}

for (const specifier of dependencyModules) {
  await import(specifier);
}

console.info(`[native-ts-runtime] loaded ${projectModules.length} production modules and ${dependencyModules.length} runtime dependencies`);
