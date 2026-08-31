import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillEngine, type SkillManifest } from "./index";

const previousRepositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT;
const previousSecurityRoot = process.env.DIV3RSA_SECURITY_SKILL_ROOT;
const sourceRepository = "mukul975/Anthropic-Cybersecurity-Skills";
const sourceCommit = "1b3f6b2286981381a5cc0566551ef3bb6bc38383";

afterEach(() => {
  if (previousRepositoryRoot === undefined) delete process.env.DIV3RSA_REPOSITORY_ROOT;
  else process.env.DIV3RSA_REPOSITORY_ROOT = previousRepositoryRoot;
  if (previousSecurityRoot === undefined) delete process.env.DIV3RSA_SECURITY_SKILL_ROOT;
  else process.env.DIV3RSA_SECURITY_SKILL_ROOT = previousSecurityRoot;
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localBody(path: string): string {
  return `local:${path}`;
}

const localNames = [
  "using-skills",
  "reasoning-router",
  "authorized-pentest",
  "policy-access-control",
  "sandbox-execution",
  "network-egress-control",
  "audit-context-building",
  "differential-security-review",
  "verification-before-completion"
];

const manifest: SkillManifest = {
  schemaVersion: 1,
  skills: localNames.map((name) => {
    const path = `${name}.md`;
    return {
      name,
      path,
      category: "test",
      description: name,
      version: "1.0.0",
      sha256: sha256(localBody(path))
    };
  })
};

async function snapshot() {
  const root = await mkdtemp(join(tmpdir(), "localai-security-engine-"));
  const skills = [
    { name: "testing-idor-in-rest-apis", description: "Test REST API BOLA and IDOR authorization issues.", domain: "cybersecurity", path: "skills/testing-idor-in-rest-apis" },
    { name: "analyzing-kubernetes-audit-logs", description: "Analyze Kubernetes API server audit logs and RBAC changes.", domain: "cybersecurity", path: "skills/analyzing-kubernetes-audit-logs" }
  ];
  await writeFile(join(root, "index.json"), JSON.stringify({
    version: "1.1.0",
    generated_at: "2026-08-24T10:40:36Z",
    repository: "https://github.com/mukul975/Anthropic-Cybersecurity-Skills",
    domain: "cybersecurity",
    total_skills: skills.length,
    skills
  }));
  const integrityFiles = [];
  for (const skill of skills) {
    const directory = join(root, skill.path);
    const body = `# ${skill.name}\nPinned specialist knowledge`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), body);
    integrityFiles.push({ path: `${skill.path}/SKILL.md`, sha256: sha256(body) });
  }
  integrityFiles.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(root, "integrity.json"), JSON.stringify({
    schemaVersion: 1,
    algorithm: "sha256",
    repository: sourceRepository,
    commit: sourceCommit,
    files: integrityFiles,
    snapshotSha256: sha256(integrityFiles.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n"))
  }));
  return root;
}

describe("SkillEngine external security integration", () => {
  it("injects top-k pinned security knowledge before final verification in lab mode", async () => {
    process.env.DIV3RSA_SECURITY_SKILL_ROOT = await snapshot();
    const engine = new SkillEngine(manifest, { read: async (path) => localBody(path) });
    const loaded = await engine.load(engine.select("lab", "Check this REST API for IDOR and BOLA authorization issues"));
    const names = loaded.map((item) => item.metadata.name);
    expect(names).toContain("external-security:testing-idor-in-rest-apis");
    expect(names.at(-1)).toBe("verification-before-completion");
    const external = loaded.find((item) => item.metadata.name === "external-security:testing-idor-in-rest-apis");
    expect(external?.reason).toBe("external_security_top_k");
    expect(external?.instructions).toContain("execution=knowledge_only");
  });

  it("does not touch the external snapshot outside lab mode", async () => {
    process.env.DIV3RSA_SECURITY_SKILL_ROOT = join(tmpdir(), "definitely-missing-security-snapshot");
    const engine = new SkillEngine(manifest, { read: async (path) => localBody(path) });
    const loaded = await engine.load(engine.select("chat", "Explain OAuth"));
    expect(loaded.map((item) => item.metadata.name)).not.toEqual(expect.arrayContaining([expect.stringContaining("external-security:")]));
  });
});
