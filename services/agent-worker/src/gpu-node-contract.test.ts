import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("infra/gpu/model-manifest.json", "utf8"));
const hardware = JSON.parse(readFileSync("infra/gpu/hardware-profiles.json", "utf8"));
const portableProfile = readFileSync("infra/gpu/runtime-profile.env", "utf8");
const productionProfile = readFileSync("infra/runtime/gpuhub-production-profile.env", "utf8");
const modelFetcher = readFileSync("scripts/fetch_qwen_v3_q8.sh", "utf8");
const bootstrap = readFileSync("infra/gpu/bootstrap-node.sh", "utf8");
const baseBootstrap = readFileSync("infra/runtime/bootstrap-host.sh", "utf8");
const verify = readFileSync("infra/gpu/verify-node.sh", "utf8");

function envValue(text: string, key: string) {
  const match = text.match(new RegExp(`^${key}=([^\\n]+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

describe("portable GPU node contract", () => {
  it("pins the same immutable model artifact used by the production fetcher", () => {
    expect(manifest.contract).toBe("div3rsa-gpu-node-v2");
    expect(manifest.model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(modelFetcher).toContain(manifest.model.sha256);
    expect(modelFetcher).toContain(manifest.model.source.revision);
    expect(modelFetcher).toContain(manifest.model.filename);
    expect(portableProfile).toContain(`DIV3RSA_GPU_MODEL_SHA256=${manifest.model.sha256}`);
  });

  it("locks the verified 96 GB profile to the tracked p8 production profile", () => {
    const profile = manifest.productionProfile;
    const hardwareProfile = hardware.profiles[profile.hardwareProfile];
    expect(hardwareProfile.status).toBe("production-verified");
    expect(hardwareProfile.minVramGb).toBeGreaterThanOrEqual(90);
    expect(hardwareProfile.parallel).toBe(profile.parallel);
    expect(hardwareProfile.totalContext).toBe(profile.totalContext);
    expect(hardwareProfile.contextPerSlot).toBe(profile.contextPerSlot);
    expect(hardwareProfile.specType).toBe(profile.specType);
    expect(Number(envValue(productionProfile, "DIV3RSA_GPUHUB_PRODUCTION_PARALLEL"))).toBe(profile.parallel);
    expect(Number(envValue(productionProfile, "DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT"))).toBe(profile.totalContext);
    expect(Number(envValue(productionProfile, "DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT"))).toBe(profile.contextPerSlot);
    expect(envValue(productionProfile, "DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE")).toBe(profile.specType);
  });

  it("fails closed for unverified or smaller GPU classes", () => {
    expect(hardware.policy.unknownHardware).toBe("deny");
    expect(hardware.policy.unverifiedProfile).toBe("deny-production");
    expect(hardware.profiles["a100-80g"].status).toBe("benchmark-required");
    expect(hardware.profiles["a100-80g"].parallel).toBeNull();
    expect(hardware.profiles["l40s-48g"].status).toBe("alternate-quant-required");
    expect(hardware.profiles["l40s-48g"].modelQuantization).toBeNull();
  });

  it("starts a blank GPU as inference-only from its first systemd process", () => {
    const roleExport = bootstrap.indexOf("export DIV3RSA_RUNTIME_ROLE=inference");
    const baseBootstrapCall = bootstrap.indexOf('infra/runtime/bootstrap-host.sh');
    expect(roleExport).toBeGreaterThan(-1);
    expect(baseBootstrapCall).toBeGreaterThan(roleExport);
    expect(baseBootstrap).toContain('case "$runtime_role" in');
    expect(baseBootstrap).toContain('start_script="${REPO_DIR}/infra/gpu/start-inference-node.sh"');
    expect(baseBootstrap).toContain('Environment=DIV3RSA_RUNTIME_ROLE=${runtime_role}');
    expect(bootstrap).not.toContain("20-inference-only.conf");
    expect(bootstrap).toContain("combined_runtime_start_path_present");
  });

  it("requires exact source revision, artifact verification and authoritative 8/8 eval before equivalence", () => {
    expect(bootstrap).toContain("DIV3RSA_RUNTIME_GIT_REF_must_be_exact_40_hex_sha");
    expect(bootstrap).toContain("verify-node.sh");
    expect(bootstrap).toContain("scripts/eval_agent_runtime.ts");
    expect(bootstrap).not.toContain("eval_agent_production.mjs");
    expect(bootstrap).toContain("data.get('cases') != 8");
    expect(bootstrap).toContain("data.get('passed') != 8");
    expect(bootstrap).toContain("production_eval_gate_blocked");
    expect(verify).toContain("model_sha256_mismatch");
    expect(verify).toContain("llama_revision_mismatch");
    expect(verify).toContain("gpu_model_not_allowed");
    expect(verify).toContain("hardware_profile_not_production_verified");
    expect(verify).toContain("runtime_profile_mismatch");
  });
});
