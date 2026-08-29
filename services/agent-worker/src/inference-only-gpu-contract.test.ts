import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const start = readFileSync("infra/gpu/start-inference-node.sh", "utf8");
const bootstrap = readFileSync("infra/gpu/bootstrap-node.sh", "utf8");
const baseBootstrap = readFileSync("infra/runtime/bootstrap-host.sh", "utf8");
const registrar = readFileSync("services/agent-worker/src/inference-node-registrar.ts", "utf8");

describe("inference-only GPU role", () => {
  it("starts llama.cpp and a lightweight registrar but never the agent queue worker", () => {
    expect(start).toContain("llama-server");
    expect(start).toContain("inference-node-registrar.ts");
    expect(start).not.toContain("services/agent-worker/src/main.ts");
    expect(start).not.toContain("AgentWorkerProcessor");
  });

  it("boots the permanent systemd service into inference-only mode from the first start", () => {
    const roleExport = bootstrap.indexOf("export DIV3RSA_RUNTIME_ROLE=inference");
    const bootstrapCall = bootstrap.indexOf("infra/runtime/bootstrap-host.sh");
    expect(roleExport).toBeGreaterThan(-1);
    expect(bootstrapCall).toBeGreaterThan(roleExport);
    expect(bootstrap).not.toContain("20-inference-only.conf");
    expect(baseBootstrap).toContain('start_script="${REPO_DIR}/infra/gpu/start-inference-node.sh"');
    expect(baseBootstrap).toContain('Environment=DIV3RSA_RUNTIME_ROLE=${runtime_role}');
    expect(bootstrap).toContain("runtime_service_not_inference_only");
    expect(bootstrap).toContain("combined_runtime_start_path_present");
  });

  it("requires local inference health before READY registration and drains on shutdown", () => {
    expect(registrar).toContain("local_inference_unhealthy");
    expect(registrar).toContain("registration.sync()");
    expect(registrar).toContain("registration.drain");
  });
});
