import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { SkillEngine, type SkillManifest } from "./index";
import { automaticSkillAllowed, assertSkillCount, assertSkillInstructionBudget, formatSkillInstructions, skillRuntimeOptionsFromEnvironment, validateSkillRuntimeOptions } from "./runtime-profile";

const skillNames = [
  "using-skills", "reasoning-router", "verification-before-completion", "writing-plans", "test-driven-development",
  "web-research", "current-information-research", "authorized-pentest", "policy-access-control", "sandbox-execution",
  "network-egress-control", "gpu-model-operations", "supply-chain-security", "evals-benchmarking", "systematic-debugging",
  "supabase-postgres", "brainstorming-design", "code-review", "system-design", "knowledge-ingestion",
  "data-poisoning-defense", "secrets-handling", "memory-learning", "performance-profiling", "capacity-benchmarking"
];
const body = (name: string) => `Instructions for ${name}.`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = (): SkillManifest => ({ schemaVersion: 1, skills: skillNames.map((name) => ({ name, path: name, category: "test", description: name, version: "1.0.0", sha256: sha256(body(name)) })) });
const minimal = () => skillRuntimeOptionsFromEnvironment({});
const engine = (manifest = fixture(), options = minimal()) => new SkillEngine(manifest, { read: async (path) => body(path) }, options);
const selected = (value: SkillEngine, mode: string, prompt: string) => value.select(mode, prompt).map((entry) => entry.metadata.name);
const base = ["using-skills", "reasoning-router", "verification-before-completion"];

it("worker configuration defaults to bounded minimal without external skills", () => {
  assert.deepEqual(minimal(), { profile: "minimal", additionalSkills: [], loadExternalSecuritySkills: false, maxSkills: 12, maxInstructionChars: 32_000 });
});
it("legacy profile is an explicit rollback, not inferred from model identity", () => {
  const options = skillRuntimeOptionsFromEnvironment({ DIV3RSA_SKILL_PROFILE: " LEGACY " });
  assert.equal(options.profile, "legacy");
  assert.equal(options.loadExternalSecuritySkills, true);
  assert.equal(options.maxSkills, 64);
});
it("configuration does not depend on a model, provider or endpoint", () => {
  assert.deepEqual(
    skillRuntimeOptionsFromEnvironment({ DIV3RSA_MODEL_PROTOCOL: "protocol-a", DIV3RSA_MODEL_ID: "model-a", QWEN_INFERENCE_BASE_URL: "http://a.invalid" }),
    skillRuntimeOptionsFromEnvironment({ DIV3RSA_MODEL_PROTOCOL: "protocol-b", DIV3RSA_MODEL_ID: "model-b", DIV3RSA_INFERENCE_BASE_URL: "http://b.invalid" })
  );
});
it("deduplicates and freezes trusted opt-ins without retaining mutable arrays", () => {
  const list = ["systematic-debugging", "systematic-debugging"];
  const options = validateSkillRuntimeOptions({ ...minimal(), additionalSkills: list });
  list.push("gpu-model-operations");
  assert.deepEqual(options.additionalSkills, ["systematic-debugging"]);
  assert.ok(Object.isFrozen(options) && Object.isFrozen(options.additionalSkills));
});
for (const [key, value] of [
  ["DIV3RSA_SKILL_PROFILE", "typo"], ["DIV3RSA_SKILL_MAX_COUNT", "0"], ["DIV3RSA_SKILL_MAX_COUNT", "1.5"],
  ["DIV3RSA_SKILL_MAX_COUNT", "12oops"], ["DIV3RSA_SKILL_MAX_COUNT", "257"],
  ["DIV3RSA_SKILL_MAX_INSTRUCTION_CHARS", "Infinity"], ["DIV3RSA_SKILL_EXTERNAL_ENABLED", "maybe"],
  ["DIV3RSA_SKILL_ADDITIONAL", "../outside"]
]) {
  it(`rejects invalid configuration ${key}=${value}`, () => {
    assert.throws(() => skillRuntimeOptionsFromEnvironment({ [key!]: value }), /invalid_skill_configuration/);
  });
}
it("preserves explicit settings and allows external skills to be independently disabled", () => {
  const options = skillRuntimeOptionsFromEnvironment({ DIV3RSA_SKILL_PROFILE: "legacy", DIV3RSA_SKILL_EXTERNAL_ENABLED: "off", DIV3RSA_SKILL_MAX_COUNT: "15", DIV3RSA_SKILL_MAX_INSTRUCTION_CHARS: "40000", DIV3RSA_SKILL_ADDITIONAL: " systematic-debugging,systematic-debugging " });
  assert.deepEqual(options.additionalSkills, ["systematic-debugging"]);
  assert.equal(options.maxSkills, 15);
  assert.equal(options.maxInstructionChars, 40000);
  assert.equal(options.loadExternalSecuritySkills, false);
});
it("keeps only freshness among automatic specialist triggers in minimal mode", () => {
  assert.equal(automaticSkillAllowed("current-information-research", minimal()), true);
  assert.equal(automaticSkillAllowed("gpu-model-operations", minimal()), false);
  assert.equal(automaticSkillAllowed("gpu-model-operations"), true);
});
it("preserves exact existing instruction formatting including Unicode", () => {
  const blocks = [{ metadata: { name: "a", version: "1" }, instructions: "Hej 🌍" }, { metadata: { name: "b", version: "2" }, instructions: "Next" }];
  assert.equal(formatSkillInstructions(blocks), "## a@1\nHej 🌍\n\n## b@2\nNext");
  assert.equal(formatSkillInstructions([]), "");
});
it("counts headings and separators in the instruction budget without truncating", () => {
  const blocks = [{ metadata: { name: "a", version: "1" }, instructions: "body" }];
  const count = formatSkillInstructions(blocks).length;
  assertSkillInstructionBudget(blocks, { ...minimal(), maxInstructionChars: count });
  assert.throws(() => assertSkillInstructionBudget(blocks, { ...minimal(), maxInstructionChars: count - 1 }), /skill_instruction_budget_exceeded/);
  assert.equal(blocks[0]!.instructions, "body");
  assertSkillCount(12, minimal());
  assert.throws(() => assertSkillCount(13, minimal()), /skill_count_budget_exceeded/);
});
it("a normal model question does not activate model operations or evaluation", () => {
  assert.deepEqual(selected(engine(), "chat", "Explain a GPU model, Q8 inference and a candidate model benchmark"), base);
});
it("a normal programming question does not auto-activate unrelated specialists", () => {
  assert.deepEqual(selected(engine(), "chat", "Explain a database query, an error, and a provider adapter"), base);
});
it("keeps live-information instructions outside Research mode", () => {
  assert.deepEqual(selected(engine(), "chat", "Vad är vädret just nu?"), ["using-skills", "reasoning-router", "current-information-research", "verification-before-completion"]);
});
it("Research retains web research, freshness and completion verification", () => {
  assert.deepEqual(selected(engine(), "research", "Investigate this topic"), ["using-skills", "reasoning-router", "web-research", "current-information-research", "verification-before-completion"]);
});
it("Lab retains authorization, sandbox and egress dependencies", () => {
  assert.deepEqual(selected(engine(), "lab", "Perform an authorized security review of our API"), ["using-skills", "reasoning-router", "policy-access-control", "sandbox-execution", "network-egress-control", "authorized-pentest", "verification-before-completion"]);
});
it("Code retains the existing plan, test and verification baseline", () => {
  assert.deepEqual(selected(engine(), "code", "Implement this feature"), ["using-skills", "reasoning-router", "writing-plans", "test-driven-development", "verification-before-completion"]);
});
it("manifest triggers cannot re-enable a specialist in minimal mode", () => {
  const manifest = fixture();
  manifest.skills.find((entry) => entry.name === "gpu-model-operations")!.triggers = ["hello"];
  assert.deepEqual(selected(engine(manifest), "chat", "hello"), base);
});
it("trusted opt-ins resolve dependencies without changing the core or verifier order", () => {
  const value = engine(fixture(), { ...minimal(), additionalSkills: ["gpu-model-operations"] });
  assert.deepEqual(selected(value, "chat", "hello"), ["using-skills", "reasoning-router", "supply-chain-security", "evals-benchmarking", "gpu-model-operations", "verification-before-completion"]);
});
it("an opt-in respects its declared modes", () => {
  const manifest = fixture();
  manifest.skills.find((entry) => entry.name === "systematic-debugging")!.modes = ["code"];
  const value = engine(manifest, { ...minimal(), additionalSkills: ["systematic-debugging"] });
  assert.deepEqual(selected(value, "chat", "hello"), base);
  assert.ok(selected(value, "code", "hello").includes("systematic-debugging"));
});
it("unknown explicit skills fail early instead of silently expanding or skipping", () => {
  assert.throws(() => engine(fixture(), { ...minimal(), additionalSkills: ["missing-skill"] }), /unknown_skill:missing-skill/);
});
it("dependency count is bounded before any instruction body is read", async () => {
  let reads = 0;
  const value = new SkillEngine(fixture(), { read: async (path) => { reads += 1; return body(path); } }, { ...minimal(), maxSkills: 6 });
  assert.throws(() => value.select("lab", "test"), /skill_count_budget_exceeded:7:6/);
  assert.equal(reads, 0);
});
it("does not drop mandatory dependencies to fit a budget", () => {
  const manifest = fixture();
  manifest.skills.find((entry) => entry.name === "reasoning-router")!.dependencies = ["using-skills", "secrets-handling"];
  assert.throws(() => engine(manifest, { ...minimal(), maxSkills: 3 }).select("chat", "hello"), /skill_count_budget_exceeded/);
});
it("preserves manifest dependency-cycle and conflict checks", () => {
  const cyclic = fixture();
  cyclic.skills.find((entry) => entry.name === "using-skills")!.dependencies = ["reasoning-router"];
  assert.throws(() => engine(cyclic).select("chat", "hello"), /skill_dependency_cycle/);
  const conflict = fixture();
  conflict.skills.find((entry) => entry.name === "reasoning-router")!.conflicts = ["using-skills"];
  assert.throws(() => engine(conflict).select("chat", "hello"), /skill_conflict/);
});
it("loads selected bodies only and preserves integrity validation", async () => {
  const paths: string[] = [];
  const value = new SkillEngine(fixture(), { read: async (path) => { paths.push(path); return body(path); } }, minimal());
  const loaded = await value.load(value.select("chat", "Explain a GPU model"));
  assert.deepEqual(paths, base);
  assert.equal(loaded.length, 3);
  const tampered = new SkillEngine(fixture(), { read: async () => "changed" }, minimal());
  await assert.rejects(tampered.load(tampered.select("chat", "hello")), /skill_integrity_mismatch/);
});
it("does not swallow a missing core body", async () => {
  const value = new SkillEngine(fixture(), { read: async () => { throw new Error("ENOENT"); } }, minimal());
  await assert.rejects(value.load(value.select("chat", "hello")), /ENOENT/);
});
it("enforces the final instruction budget after validated reads", async () => {
  const value = engine(fixture(), { ...minimal(), maxInstructionChars: 1 });
  await assert.rejects(value.load(value.select("chat", "hello")), /skill_instruction_budget_exceeded/);
});
it("minimal Lab ignores an installed external index without weakening local prerequisites", async () => {
  const root = await mkdtemp(join(tmpdir(), "localai-skill-profile-"));
  const previous = process.env.DIV3RSA_SECURITY_SKILL_ROOT;
  try {
    await writeFile(join(root, "index.json"), "deliberately-invalid-json");
    process.env.DIV3RSA_SECURITY_SKILL_ROOT = root;
    const value = engine();
    const loaded = await value.load(value.select("lab", "authorized API audit"));
    assert.equal(loaded.length, 7);
    assert.ok(loaded.some((entry) => entry.metadata.name === "policy-access-control"));
    assert.ok(loaded.every((entry) => entry.metadata.category !== "security-external"));
  } finally {
    if (previous === undefined) delete process.env.DIV3RSA_SECURITY_SKILL_ROOT;
    else process.env.DIV3RSA_SECURITY_SKILL_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
it("existing library callers keep legacy routing unless given runtime options", () => {
  const names = selected(new SkillEngine(fixture()), "chat", "Explain a GPU model");
  assert.ok(names.includes("gpu-model-operations") && names.includes("supply-chain-security") && names.includes("evals-benchmarking"));
});
it("caller changes cannot alter an engine's captured profile", () => {
  const options = { ...minimal(), additionalSkills: ["systematic-debugging"] };
  const value = engine(fixture(), options);
  options.additionalSkills.push("gpu-model-operations");
  assert.ok(!selected(value, "chat", "hello").includes("gpu-model-operations"));
});
it("the worker opts into the profile without replacing the processor or model adapter", async () => {
  const source = await readFile(new URL("../../../services/agent-worker/src/main.ts", import.meta.url), "utf8");
  assert.match(source, /const skillRuntimeOptions = skillRuntimeOptionsFromEnvironment\(\)/);
  assert.match(source, /new SkillEngine\(manifest,.*skillRuntimeOptions\)/);
  assert.match(source, /new AgentWorkerProcessor\(/);
  assert.match(source, /createInferenceAdapter\(/);
  assert.match(source, /new SecurityToolRuntime\(/);
  assert.match(source, /new CoreToolRuntime\(/);
});
