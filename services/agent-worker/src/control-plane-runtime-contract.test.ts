import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const env = readFileSync(resolve(root, "infra/control-plane/control-plane.env.example"), "utf8");
const bootstrap = readFileSync(resolve(root, "infra/control-plane/bootstrap-worker.sh"), "utf8");
const service = readFileSync(resolve(root, "infra/control-plane/div3rsa-agent-worker.service"), "utf8");

describe("CPU control-plane runtime contract", () => {
  it("routes inference only through the runtime registry", () => {
    expect(env).toContain("DIV3RSA_INFERENCE_ROUTING_MODE=registry");
    expect(env).toContain("DIV3RSA_RUNTIME_ROLE=control-plane");
    expect(bootstrap).toContain("DIV3RSA_INFERENCE_ROUTING_MODE=registry is required");
    expect(bootstrap).toContain("control plane cannot use inference/combined runtime role");
  });

  it("boots an exact immutable main revision", () => {
    expect(bootstrap).toContain("40-character commit SHA");
    expect(bootstrap).toContain("merge-base --is-ancestor");
    expect(bootstrap).toContain("reset --hard \"$DIV3RSA_RUNTIME_GIT_REF\"");
    expect(bootstrap).toContain("npm ci --omit=dev --ignore-scripts");
  });

  it("runs only the queue worker and no llama server", () => {
    expect(service).toContain("services/agent-worker/src/main.ts");
    expect(service).not.toContain("llama-server");
    expect(service).not.toContain("inference-node-registrar");
    expect(service).toContain("Restart=always");
  });

  it("keeps learning training eligibility disabled in the deployable profile", () => {
    expect(env).toContain("DIV3RSA_TRAINING_ELIGIBILITY_ENABLED=0");
    expect(env).toContain("DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS=25");
  });
});
