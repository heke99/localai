import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/control-plane-cutover.yml"), "utf8");
const preflight = readFileSync(resolve(root, "infra/control-plane/preflight-worker.sh"), "utf8");

describe("control-plane cutover contract", () => {
  it("is manual, exact-SHA and pinned-host only", () => {
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("revision must be an exact 40-char SHA");
    expect(workflow).toContain("cutover revision must equal current main");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("CONTROL_PLANE_SSH_KNOWN_HOSTS");
  });

  it("proves the CPU worker before the legacy GPU worker can be stopped", () => {
    const prove = workflow.indexOf("Bootstrap exact CPU control plane and prove readiness");
    const stop = workflow.indexOf("Stop legacy GPU-host worker only after CPU is proven");
    expect(prove).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(prove);
    expect(workflow).toContain("bash \"$repo/infra/control-plane/preflight-worker.sh\"");
    expect(workflow).toContain("Cutover verification failed; restoring legacy GPU-host worker");
    expect(workflow).toContain("CONTROL_PLANE_CUTOVER_COMPLETE");
  });

  it("requires registry routing, a fresh READY route, gateway reachability and no local inference", () => {
    expect(preflight).toContain('DIV3RSA_INFERENCE_ROUTING_MODE:-}\" == \"registry');
    expect(preflight).toContain("runtime_resolve_model_routes");
    expect(preflight).toContain("worker_state");
    expect(preflight).toContain("ready");
    expect(preflight).toContain("DIV3RSA_INTEGRATION_GATEWAY_URL");
    expect(preflight).toContain("llama-server|start-inference-node|inference-node-registrar");
    expect(preflight).toContain("inferenceRouting=registry");
  });

  it("keeps GPU inference alive during and after queue-worker cutover", () => {
    expect(workflow).toContain("llama-server.*Qwen3\\.8-27B-OBLITERATED-Q8_0\\.gguf");
    expect(workflow).toContain("http://127.0.0.1:6006/health");
    expect(workflow).toContain("legacyGpuWorker=stopped inferenceNode=healthy");
  });
});
