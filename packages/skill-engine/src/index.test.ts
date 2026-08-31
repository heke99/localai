import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SkillEngine, type SkillManifest } from "./index";

const names = [
  "using-skills",
  "reasoning-router",
  "current-information-research",
  "capacity-benchmarking",
  "performance-profiling",
  "evals-benchmarking",
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function body(path: string): string {
  return `body:${path}`;
}

describe("SkillEngine", () => {
  it("resolves dependencies and keeps verification last", () => {
    const selected = new SkillEngine(manifest).select("code", "Fix this Supabase bug");
    expect(selected.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "writing-plans", "test-driven-development", "systematic-debugging", "supabase-postgres", "verification-before-completion"]);
  });

  it("loads full bodies only after selection and verifies their manifest hashes", async () => {
    const integrityManifest: SkillManifest = {
      ...manifest,
      skills: manifest.skills.map((skill) => ({ ...skill, sha256: sha256(body(skill.path)) }))
    };
    const engine = new SkillEngine(integrityManifest, { read: async (path) => body(path) });
    const loaded = await engine.load(engine.select("chat", "hello"));
    expect(loaded).toHaveLength(3);
    expect(loaded.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "verification-before-completion"]);
    expect(loaded[0].instructions).toBe("body:using-skills.md");
    expect(loaded[2].instructions).toBe("body:verification-before-completion.md");
  });

  it("fails closed when a selected skill body no longer matches the source-controlled manifest", async () => {
    const integrityManifest: SkillManifest = {
      ...manifest,
      skills: manifest.skills.map((skill) => ({ ...skill, sha256: sha256(body(skill.path)) }))
    };
    const engine = new SkillEngine(integrityManifest, {
      read: async (path) => path === "reasoning-router.md" ? "tampered body" : body(path)
    });
    await expect(engine.load(engine.select("chat", "hello"))).rejects.toThrow("skill_integrity_mismatch:reasoning-router");
  });

  it("rejects malformed skill hashes before routing", () => {
    const invalid: SkillManifest = {
      ...manifest,
      skills: manifest.skills.map((skill, index) => index === 0 ? { ...skill, sha256: "not-a-sha" } : skill)
    };
    expect(() => new SkillEngine(invalid)).toThrow("invalid_skill_sha256:using-skills");
  });

  it("exposes compact descriptors without loading skill bodies", () => {
    const engine = new SkillEngine({
      schemaVersion: 1,
      skills: [{ name: "impact-analysis", path: "impact.md", category: "code", description: "Analyze dependency impact", version: "1.0.0", sha256: "b".repeat(64), modes: ["code"], cost: { context: "medium", latency: "low" } }]
    });
    expect(engine.descriptors("code")).toEqual([{ name: "impact-analysis", description: "Analyze dependency impact", category: "code", modes: ["code"], cost: { context: "medium", latency: "low" } }]);
    expect(engine.descriptors("research")).toEqual([]);
  });

  it("uses manifest dependencies before legacy routing rules", () => {
    const custom: SkillManifest = {
      schemaVersion: 1,
      skills: [
        ...manifest.skills,
        { name: "impact-analysis", path: "impact.md", category: "code", description: "impact", version: "1.0.0", sha256: "c".repeat(64), modes: ["code"], triggers: ["impact"], dependencies: ["reasoning-router"] }
      ]
    };
    const selected = new SkillEngine(custom).select("code", "impact this change");
    const names = selected.map((item) => item.metadata.name);
    expect(names).toContain("impact-analysis");
    expect(names.indexOf("reasoning-router")).toBeLessThan(names.indexOf("impact-analysis"));
  });

  it("rejects conflicting skill combinations deterministically", () => {
    const conflictManifest: SkillManifest = {
      schemaVersion: 1,
      skills: manifest.skills.map((skill) => skill.name === "reasoning-router" ? { ...skill, conflicts: ["writing-plans"] } : skill)
    };
    expect(() => new SkillEngine(conflictManifest).select("code", "hello")).toThrow("skill_conflict:reasoning-router:writing-plans");
  });

  it("activates current-information research outside research mode when freshness matters", () => {
    const selected = new SkillEngine(manifest).select("chat", "Vilka visumregler gäller i Japan just nu?");
    expect(selected.map((item) => item.metadata.name)).toEqual(["using-skills", "reasoning-router", "current-information-research", "verification-before-completion"]);
  });

  it("activates capacity benchmarking for concurrency tuning", () => {
    const selected = new SkillEngine(manifest).select("code", "Benchmark parallel 1 2 4 8 and compare TTFT p95 throughput");
    expect(selected.map((item) => item.metadata.name)).toEqual(expect.arrayContaining(["performance-profiling", "evals-benchmarking", "capacity-benchmarking"]));
  });
});
