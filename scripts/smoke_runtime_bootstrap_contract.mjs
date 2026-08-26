import { readFile } from "node:fs/promises";

const bootstrap = await readFile("infra/runtime/bootstrap-host.sh", "utf8");
const production = await readFile("apps/web/lib/runtime/production.ts", "utf8");
const hyperstack = await readFile("apps/web/lib/runtime/providers/hyperstack.ts", "utf8");
const manager = await readFile("apps/web/lib/runtime/manager.ts", "utf8");
const workerRegistration = await readFile("services/agent-worker/src/runtime-registration.ts", "utf8");

const checks = [
  [bootstrap.includes("nvidia-smi"), "raw GPU NVIDIA readiness check missing"],
  [bootstrap.includes("sha256sum -c"), "pinned Node checksum verification missing"],
  [bootstrap.includes("fetch_qwen_v3_q8.sh"), "checksum-pinned model fetch missing"],
  [bootstrap.includes("GGML_CUDA=ON"), "CUDA llama.cpp build missing"],
  [bootstrap.includes("div3rsa-runtime.service"), "systemd runtime supervision missing"],
  [production.includes("HyperstackRuntimeProvider"), "Hyperstack managed adapter missing from production"],
  [hyperstack.includes("runtime_bootstrap" ) || hyperstack.includes("bootstrapIssuer"), "Hyperstack one-time bootstrap wiring missing"],
  [manager.includes("acquireProvisioningLease"), "distributed provisioning lock missing"],
  [manager.includes('runtimeContract === "div3rsa-runtime-v1"'), "vendor-neutral self-registration route missing"],
  [workerRegistration.includes('runtimeContract: "div3rsa-runtime-v1"'), "worker runtime contract metadata missing"]
];

for (const [ok, message] of checks) if (!ok) throw new Error(message);
console.log("[runtime-bootstrap-contract] managed and raw-rented GPU bootstrap contracts present");
