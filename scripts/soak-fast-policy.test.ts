import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("p8 soak FAST policy contract", () => {
  const soakSource = readFileSync(new URL("./soak_model_concurrency.mjs", import.meta.url), "utf8");
  const workflowSource = readFileSync(new URL("../.github/workflows/p8-soak-gpuhub.yml", import.meta.url), "utf8");

  it("runs the stable synthetic load without hidden reasoning", () => {
    expect(soakSource).toContain('const reasoningEffort = "none"');
    expect(soakSource).toContain("reasoning_effort: reasoningEffort");
    expect(soakSource).toContain("reasoningEffort }");
  });

  it("does not weaken the production-like p8 latency and error gates", () => {
    expect(workflowSource).toContain("DIV3RSA_P8_GATE_MAX_ERRORS=0");
    expect(workflowSource).toContain("DIV3RSA_P8_GATE_MAX_TTFT_P95_MS=10000");
    expect(workflowSource).toContain("DIV3RSA_P8_GATE_MAX_TOTAL_P95_MS=20000");
    expect(workflowSource).toContain("DIV3RSA_P8_GATE_MAX_VRAM_RATIO=0.94");
  });
});
