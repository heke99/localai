import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/agent-kernel-learning-optimizer.yml"), "utf8");

describe("Agent Kernel learning optimizer workflow contract", () => {
  it("is manual and pinned to an exact current main revision", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("revision must be an exact 40-char SHA");
    expect(workflow).toContain("optimizer revision must equal current main");
  });

  it("exports verified learning before evaluating a candidate", () => {
    const exportIndex = workflow.indexOf("npm run learning:export");
    const optimizeIndex = workflow.indexOf("npm run learning:optimize");
    expect(exportIndex).toBeGreaterThan(0);
    expect(optimizeIndex).toBeGreaterThan(exportIndex);
    expect(workflow).toContain("DIV3RSA_LEARNING_MINIMUM_SAMPLES: \"25\"");
  });

  it("cannot train, deploy, or mutate the production canary", () => {
    expect(workflow).not.toContain("training:run");
    expect(workflow).not.toContain("workflow_call:");
    expect(workflow).not.toContain("GPUHUB_SSH_PRIVATE_KEY");
    expect(workflow).not.toContain("DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS=");
    expect(workflow).toContain("recommendation-only");
  });
});
