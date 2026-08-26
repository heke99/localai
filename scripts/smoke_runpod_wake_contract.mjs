import { readFile } from "node:fs/promises";

const files = {
  runpodRuntime: "apps/web/lib/runpod/runtime.ts",
  runtimeManager: "apps/web/lib/runtime/manager.ts",
  productionRuntime: "apps/web/lib/runtime/production.ts",
  runpodAdapter: "apps/web/lib/runtime/providers/runpod.ts",
  hyperstackAdapter: "apps/web/lib/runtime/providers/hyperstack.ts",
  genericAdapter: "apps/web/lib/runtime/providers/openai-compatible.ts",
  bootstrapIssuer: "apps/web/lib/runtime/bootstrap-issuer.ts",
  prewarm: "apps/web/app/api/runtime/prewarm/route.ts",
  shell: "apps/web/app/dashboard/workspace-shell-v5.tsx",
  runRoute: "apps/web/app/api/runs/route.ts",
  worker: "services/agent-worker/src/main.ts",
  workerRegistration: "services/agent-worker/src/runtime-registration.ts",
  hostBootstrap: "infra/runtime/bootstrap-host.sh",
  runtimeStart: "infra/runtime/start-production.sh",
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
  [loaded.runtimeManager.includes("acquireProvisioningLease"), "distributed provisioning lease missing"],
  [loaded.runtimeManager.includes('runtimeContract === "div3rsa-runtime-v1"'), "self-registered rented GPU runtime support missing"],
  [loaded.productionRuntime.includes("RunpodRuntimeProvider"), "RunPod production adapter registration missing"],
  [loaded.productionRuntime.includes("HyperstackRuntimeProvider"), "Hyperstack production adapter registration missing"],
  [loaded.productionRuntime.includes("OpenAiCompatibleRuntimeProvider"), "generic runtime adapter registration missing"],
  [loaded.runpodAdapter.includes("ensureRunpodRuntimeAwake"), "RunPod-specific wake escaped its provider adapter"],
  [loaded.hyperstackAdapter.includes("stock_available"), "Hyperstack stock-aware provisioning missing"],
  [loaded.hyperstackAdapter.includes("user_data"), "Hyperstack cloud-init bootstrap missing"],
  [!loaded.hyperstackAdapter.includes("SUPABASE_SECRET_KEY"), "Hyperstack provisioning code embeds Supabase secret material"],
  [loaded.genericAdapter.includes("GENERIC_RUNTIME_BASE_URL"), "generic OpenAI-compatible provider configuration missing"],
  [loaded.genericAdapter.includes("generic_runtime_https_required"), "generic provider HTTPS boundary missing"],
  [loaded.bootstrapIssuer.includes("randomBytes(32)"), "one-time runtime bootstrap entropy missing"],
  [loaded.bootstrapIssuer.includes('createHash("sha256")'), "runtime bootstrap token hashing missing"],
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
  [loaded.workerRegistration.includes('runtimeContract: "div3rsa-runtime-v1"'), "worker runtime contract registration missing"],
  [loaded.hostBootstrap.includes("nvidia-smi"), "rented GPU host NVIDIA readiness check missing"],
  [loaded.hostBootstrap.includes("sha256sum -c"), "pinned host dependency checksum verification missing"],
  [loaded.hostBootstrap.includes("fetch_qwen_v3_q8.sh"), "verified model bootstrap missing"],
  [loaded.hostBootstrap.includes("systemctl restart div3rsa-runtime"), "rented GPU supervisor setup missing"],
  [loaded.runtimeStart.includes("DIV3RSA_START_PROVIDER_BASE_SERVICES"), "provider-neutral runtime supervisor missing"],
  [loaded.autoStart.includes("git fetch"), "runtime boot Git fetch missing"],
  [loaded.autoStart.includes("git reset --hard"), "runtime boot exact commit sync missing"],
  [loaded.autoStart.includes("start-production.sh"), "runtime supervisor handoff missing"]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("[runtime-provider-contract] provider-neutral manager, managed failover, rented-GPU self-registration and boot contracts present");
