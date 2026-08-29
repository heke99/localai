import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

describe("GPUHub shadow probe evidence contract", () => {
  it("ships enough labeled quality coverage for the promotion gate", async () => {
    const suite = JSON.parse(await readFile(resolve(root, "evals/agent-kernel-shadow-probe-quality.json"), "utf8")) as {
      schemaVersion: number;
      cases: Array<{ expectedWeakBaseline: boolean; id: string; baselineAnswer: string }>;
    };
    expect(suite.schemaVersion).toBe(1);
    expect(suite.cases).toHaveLength(20);
    expect(suite.cases.filter((item) => item.expectedWeakBaseline)).toHaveLength(8);
    expect(new Set(suite.cases.map((item) => item.id)).size).toBe(suite.cases.length);

    const byId = new Map(suite.cases.map((item) => [item.id, item]));
    expect(byId.get("healthy-current-source")?.baselineAnswer).toMatch(/official tax authority.+Citation:/i);
    expect(byId.get("healthy-current-source")?.baselineAnswer).toMatch(/2026-08-29T10:00:00Z/);
    expect(byId.get("healthy-live-data")?.baselineAnswer).toMatch(/official live Current channel.+v\d+\.\d+\.\d+.+Citation:/i);
    expect(byId.get("healthy-research-uncertainty")?.baselineAnswer).toMatch(/Confirmed.+2026-08-01.+Still uncertain.+Regulator FAQ/i);
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

  it("delays only loaded evidence probes until their foreground baseline stream completes", async () => {
    const preload = await readFile(resolve(root, "scripts/agent_kernel_probe_no_thinking_preload.mjs"), "utf8");
    expect(preload).toContain("loadedForegroundIndex");
    expect(preload).toContain("loadedProbeIndex");
    expect(preload).toContain("response.clone().arrayBuffer()");
    expect(preload).toContain("await deferred.promise");
    expect(preload).toContain('reasoning_effort: "none"');
    expect(preload).toContain("enable_thinking: false");
    expect(preload).not.toContain("DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED");
  });
});
