import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const start = readFileSync("infra/gpu/start-inference-node.sh", "utf8");
const bootstrap = readFileSync("infra/gpu/bootstrap-node.sh", "utf8");
const registrar = readFileSync("services/agent-worker/src/inference-node-registrar.ts", "utf8");

describe("inference-only GPU role", () => {
  it("starts llama.cpp and a lightweight registrar but never the agent queue worker", () => {
    expect(start).toContain("llama-server");
    expect(start).toContain("inference-node-registrar.ts");
    expect(start).not.toContain("services/agent-worker/src/main.ts");
    expect(start).not.toContain("AgentWorkerProcessor");
  });

  it("boots the permanent systemd service into inference-only mode", () => {
    expect(bootstrap).toContain("20-inference-only.conf");
    expect(bootstrap).toContain("Environment=DIV3RSA_RUNTIME_ROLE=inference");
    expect(bootstrap).toContain("start-inference-node.sh");
    expect(bootstrap).toContain("systemctl restart div3rsa-runtime");
  });

  it("requires local inference health before READY registration and drains on shutdown", () => {
    expect(registrar).toContain("local_inference_unhealthy");
    expect(registrar).toContain("registration.sync()");
    expect(registrar).toContain("registration.drain");
  });
});
