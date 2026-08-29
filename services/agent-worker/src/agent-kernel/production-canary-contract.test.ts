import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/agent-kernel-production-canary.yml"), "utf8");
const profile = readFileSync(resolve(root, "infra/agent-kernel/production-canary.env"), "utf8");

describe("Agent Kernel production canary contract", () => {
  it("keeps production traffic tiny and training eligibility disabled", () => {
    expect(profile).toContain("DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS=25");
    expect(profile).toContain("DIV3RSA_DYNAMIC_TOOL_DISCOVERY_ENABLED=1");
    expect(profile).toContain("DIV3RSA_CHECKPOINT_REWIND_ENABLED=1");
    expect(profile).toContain("DIV3RSA_VERIFIED_MEMORY_ENABLED=1");
    expect(profile).toContain("DIV3RSA_VERIFIED_LEARNING_ENABLED=1");
    expect(profile).toContain("DIV3RSA_TRAINING_ELIGIBILITY_ENABLED=0");
  });

  it("exercises 100 percent active path before applying the tiny canary", () => {
    expect(workflow).toContain("DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS=10000");
    expect(workflow).toContain("scripts/eval_agent_runtime.ts");
    expect(workflow).toContain("scripts/eval_agent_production.mjs --json");
  });

  it("preserves the p8 profile and rolls back the exact previous worker environment", () => {
    expect(workflow).toContain("cp -a \"$env_file\" \"$backup\"");
    expect(workflow).toContain("cp -a \"$backup\" \"$env_file\"");
    expect(workflow).toContain("--parallel[=\\ ]+8");
    expect(workflow).toContain("--ctx-size[=\\ ]+262144");
    expect(workflow).toContain("--spec-type ngram-mod");
    expect(workflow).toContain("liveOracleFailures");
  });
});
