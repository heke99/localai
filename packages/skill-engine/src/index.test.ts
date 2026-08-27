import { describe, expect, it } from "vitest";
import { SkillEngine, type SkillManifest } from "./index";

const names = [
  "using-skills",
  "reasoning-router",
  "current-information-research",
  "capacity-benchmarking",
  "writing-plans",
  "test-driven-development",
  "verification-before-completion",
  "supabase-postgres",
  "systematic-debugging",
  "authorized-pentest",
  "policy-access-control",
  "sandbox-execution",
  "network-egress-control"
];
const manifest: SkillManifest = { schemaVersion: 1, skills: names.map((name) => ({ name, path: `${name}.md`, category: "test", description: name, version: "1.0.0", sha256: "a".repeat(64) })) };

describe("SkillEngine", () => {
  it("resolves dependencies and keeps verification last", () => {
    const selected = new SkillEngine(manifest).select("code", "Fix this Supabase bug");
    expect(selected.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "writing-plans", "test-driven-development", "systematic-debugging", "supabase-postgres", "verification-before-completion"]);
  });

  it("loads full bodies only after selection", async () => {
    const engine = new SkillEngine(manifest, { read: async (path) => `body:${path}` });
    const loaded = await engine.load(engine.select("chat", "hello"));
    expect(loaded).toHaveLength(3);
    expect(loaded.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "verification-before-completion"]);
    expect(loaded[0].instructions).toBe("body:using-skills.md");
    expect(loaded[2].instructions).toBe("body:verification-before-completion.md");
  });

  it("activates current-information research outside research mode when freshness matters", () => {
    const selected = new SkillEngine(manifest).select("chat", "Vilka visumregler gäller i Japan just nu?");
    expect(selected.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "current-information-research", "verification-before-completion"]);
  });

  it("activates capacity benchmarking for concurrency tuning", () => {
    const selected = new SkillEngine(manifest).select("code", "Benchmark parallel 1 2 4 8 and compare TTFT p95 throughput");
    expect(selected.map((item) => item.metadata.name)).toContain("capacity-benchmarking");
  });
});
