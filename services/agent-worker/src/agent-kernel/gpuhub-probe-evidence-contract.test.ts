import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

describe("GPUHub shadow probe evidence contract", () => {
  it("ships enough labeled quality coverage for the promotion gate", async () => {
    const suite = JSON.parse(await readFile(resolve(root, "evals/agent-kernel-shadow-probe-quality.json"), "utf8")) as {
      schemaVersion: number;
      cases: Array<{ expectedWeakBaseline: boolean; id: string }>;
    };
    expect(suite.schemaVersion).toBe(1);
    expect(suite.cases).toHaveLength(20);
    expect(suite.cases.filter((item) => item.expectedWeakBaseline)).toHaveLength(8);
    expect(new Set(suite.cases.map((item) => item.id)).size).toBe(suite.cases.length);
  });

  it("keeps the GPUHub evidence runner observational and non-mutating", async () => {
    const source = await readFile(resolve(root, "scripts/eval_agent_kernel_probes_gpuhub.mjs"), "utf8");
    expect(source).toContain("eval_agent_kernel_shadow_probes.ts");
    expect(source).toContain("probeActive");
    expect(source).toContain("capacitySkippedRuns");
    expect(source).not.toContain("DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED=");
    expect(source).not.toContain("systemctl restart");
    expect(source).not.toContain("llama-server --model");
    expect(source).not.toContain("tools:");
  });
});
