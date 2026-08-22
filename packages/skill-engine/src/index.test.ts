import { describe, expect, it } from "vitest";
import { SkillEngine, type SkillManifest } from "./index";

const names = ["writing-plans", "test-driven-development", "verification-before-completion", "supabase-postgres", "systematic-debugging", "authorized-pentest", "policy-access-control", "sandbox-execution", "network-egress-control"];
const manifest: SkillManifest = { schemaVersion: 1, skills: names.map((name) => ({ name, path: `${name}.md`, category: "test", description: name, version: "1.0.0", sha256: "a".repeat(64) })) };

describe("SkillEngine", () => {
  it("resolves dependencies and keeps verification last", () => {
    const selected = new SkillEngine(manifest).select("code", "Fix this Supabase bug");
    expect(selected.map((item) => item.metadata.name)).toEqual(["writing-plans", "test-driven-development", "systematic-debugging", "supabase-postgres", "verification-before-completion"]);
  });

  it("loads full bodies only after selection", async () => {
    const engine = new SkillEngine(manifest, { read: async (path) => `body:${path}` });
    const loaded = await engine.load(engine.select("chat", "hello"));
    expect(loaded).toHaveLength(1);
    expect(loaded[0].instructions).toBe("body:verification-before-completion.md");
  });
});
