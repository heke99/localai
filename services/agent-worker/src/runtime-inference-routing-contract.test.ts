import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("services/agent-worker/src/main.ts", "utf8");
const router = readFileSync("services/agent-worker/src/runtime-inference-router.ts", "utf8");

describe("control-plane inference routing contract", () => {
  it("keeps direct local inference as the fail-safe default", () => {
    expect(main).toContain('const normalized = value?.trim().toLowerCase() || "direct"');
    expect(main).toContain('normalized === "direct" || normalized === "registry"');
    expect(main).toContain('routingMode === "registry"');
  });

  it("does not self-register the control-plane worker as a GPU node in registry mode", () => {
    expect(main).toContain('const runtimeConfig = routingMode === "direct" ? runtimeRegistrationConfigFromEnvironment(modelPort) : null;');
  });

  it("resolves only READY registered nodes and marks failed nodes out of rotation", () => {
    expect(router).toContain('row.worker_state !== "ready"');
    expect(router).toContain('"runtime_resolve_model_routes"');
    expect(router).toContain('"runtime_mark_worker_health"');
    expect(router).toContain('target_state: "failed"');
  });

  it("never retries a streamed request after visible output has begun", () => {
    expect(router).toContain('if (emitted) throw error;');
  });
});
