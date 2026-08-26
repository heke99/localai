import { readFile } from "node:fs/promises";

const files = {
  runtime: "apps/web/lib/runpod/runtime.ts",
  prewarm: "apps/web/app/api/runtime/prewarm/route.ts",
  shell: "apps/web/app/dashboard/workspace-shell-v5.tsx",
  runRoute: "apps/web/app/api/runs/route.ts",
  autoStart: "infra/runpod/auto-start.sh"
};

const loaded = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])));

const checks = [
  [loaded.runtime.includes("https://rest.runpod.io/v1"), "RunPod REST base URL missing"],
  [loaded.runtime.includes("/start"), "RunPod start path missing"],
  [loaded.runtime.includes("podResume"), "RunPod GraphQL resume fallback missing"],
  [loaded.runtime.includes("RUNPOD_START_ATTEMPTS"), "RunPod start retry policy missing"],
  [loaded.runtime.includes("RUNPOD_AUTO_REPLACE_UNAVAILABLE"), "RunPod replacement policy missing"],
  [loaded.runtime.includes("RUNPOD_NETWORK_VOLUME_ID"), "RunPod persistent volume failover identity missing"],
  [loaded.runtime.includes("/pods?includeMachine=true&includeNetworkVolume=true"), "RunPod replacement discovery missing"],
  [loaded.runtime.includes("networkVolumeId"), "RunPod replacement volume attachment missing"],
  [loaded.runtime.includes("gpuTypePriority"), "RunPod availability-based GPU failover missing"],
  [loaded.runtime.includes('state: "replacing"'), "RunPod replacement state missing"],
  [loaded.runtime.includes("git fetch --prune --no-tags"), "replacement latest-main fetch bootstrap missing"],
  [loaded.runtime.includes("git reset --hard FETCH_HEAD"), "replacement exact main reset bootstrap missing"],
  [loaded.runtime.includes("DIV3RSA_GIT_SYNC_ON_BOOT"), "replacement persistent sync handoff missing"],
  [loaded.runtime.includes("/restart"), "RunPod restart path missing"],
  [loaded.prewarm.includes("my_agent_access_snapshot"), "prewarm access gate missing"],
  [loaded.shell.includes("/api/runtime/prewarm"), "composer prewarm hook missing"],
  [loaded.shell.includes("focusin"), "composer focus prewarm trigger missing"],
  [loaded.shell.includes("lastSuccessfulPrewarmAt"), "failed prewarm cooldown protection missing"],
  [loaded.runRoute.includes("ensureRunpodRuntimeAwake"), "run-submit wake fallback missing"],
  [loaded.autoStart.includes("git fetch"), "Pod boot Git fetch missing"],
  [loaded.autoStart.includes("git reset --hard"), "Pod boot exact commit sync missing"],
  [loaded.autoStart.includes("start-production.sh"), "Pod resume supervisor handoff missing"]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("[runpod-wake-contract] wake-on-demand, managed failover, bootstrap and boot sync wiring present");
