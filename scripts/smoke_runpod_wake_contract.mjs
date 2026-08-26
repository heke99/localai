import { readFile } from "node:fs/promises";

const files = {
  runpodRuntime: "apps/web/lib/runpod/runtime.ts",
  runtimeManager: "apps/web/lib/runtime/manager.ts",
  productionRuntime: "apps/web/lib/runtime/production.ts",
  runpodAdapter: "apps/web/lib/runtime/providers/runpod.ts",
  genericAdapter: "apps/web/lib/runtime/providers/openai-compatible.ts",
  prewarm: "apps/web/app/api/runtime/prewarm/route.ts",
  shell: "apps/web/app/dashboard/workspace-shell-v5.tsx",
  runRoute: "apps/web/app/api/runs/route.ts",
  worker: "services/agent-worker/src/main.ts",
  autoStart: "infra/runpod/auto-start.sh"
};

const loaded = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])));

const checks = [
  [loaded.runpodRuntime.includes("https://rest.runpod.io/v1"), "RunPod REST base URL missing"],
  [loaded.runpodRuntime.includes("podResume"), "RunPod GraphQL resume fallback missing"],
  [loaded.runpodRuntime.includes("RUNPOD_AUTO_REPLACE_UNAVAILABLE"), "RunPod replacement policy missing"],
  [loaded.runpodRuntime.includes("RUNPOD_NETWORK_VOLUME_ID"), "RunPod persistent volume failover identity missing"],
  [loaded.runpodRuntime.includes("gpuTypePriority"), "RunPod availability-based GPU failover missing"],
  [loaded.runpodRuntime.includes("git fetch --prune --no-tags"), "replacement latest-main bootstrap missing"],
  [loaded.runtimeManager.includes("registry.resolve"), "runtime registry resolution missing"],
  [loaded.runtimeManager.includes("adapter.ensure"), "provider adapter failover missing"],
  [loaded.productionRuntime.includes("RunpodRuntimeProvider"), "RunPod production adapter registration missing"],
  [loaded.productionRuntime.includes("OpenAiCompatibleRuntimeProvider"), "generic runtime adapter registration missing"],
  [loaded.runpodAdapter.includes("ensureRunpodRuntimeAwake"), "RunPod-specific wake escaped its provider adapter"],
  [loaded.genericAdapter.includes("GENERIC_RUNTIME_BASE_URL"), "generic OpenAI-compatible provider configuration missing"],
  [loaded.genericAdapter.includes("generic_runtime_https_required"), "generic provider HTTPS boundary missing"],
  [loaded.prewarm.includes("my_agent_access_snapshot"), "prewarm access gate missing"],
  [loaded.prewarm.includes("ensureModelRuntime"), "prewarm does not use the Runtime Manager"],
  [!loaded.prewarm.includes("ensureRunpodRuntimeAwake"), "prewarm is still coupled directly to RunPod"],
  [loaded.shell.includes("/api/runtime/prewarm"), "composer prewarm hook missing"],
  [loaded.shell.includes("focusin"), "composer focus prewarm trigger missing"],
  [loaded.shell.includes("lastSuccessfulPrewarmAt"), "failed prewarm cooldown protection missing"],
  [loaded.runRoute.includes("ensureModelRuntime"), "run-submit Runtime Manager fallback missing"],
  [!loaded.runRoute.includes("ensureRunpodRuntimeAwake"), "run-submit is still coupled directly to RunPod"],
  [loaded.worker.includes("DIV3RSA_INFERENCE_BASE_URL"), "provider-neutral worker inference endpoint missing"],
  [loaded.worker.includes("127.0.0.1"), "co-located provider-neutral inference default missing"],
  [loaded.autoStart.includes("git fetch"), "runtime boot Git fetch missing"],
  [loaded.autoStart.includes("git reset --hard"), "runtime boot exact commit sync missing"],
  [loaded.autoStart.includes("start-production.sh"), "runtime supervisor handoff missing"]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("[runtime-provider-contract] provider-neutral Runtime Manager, RunPod failover and boot sync wiring present");
