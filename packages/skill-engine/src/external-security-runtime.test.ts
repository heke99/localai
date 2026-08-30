import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExternalSecuritySkillRuntime,
  externalIndexToSecurityNodes,
  inferSecurityDomains,
  validateExternalSecuritySkillIndex
} from "./external-security-runtime";

const index = {
  version: "1.1.0",
  generated_at: "2026-08-24T10:40:36Z",
  repository: "https://github.com/mukul975/Anthropic-Cybersecurity-Skills",
  domain: "cybersecurity",
  total_skills: 3,
  skills: [
    { name: "testing-idor-in-rest-apis", description: "Test REST API BOLA and IDOR authorization issues on object endpoints.", domain: "cybersecurity", path: "skills/testing-idor-in-rest-apis" },
    { name: "testing-oauth-authorization", description: "Assess OAuth and OIDC authorization code flows, redirect URI and session handling.", domain: "cybersecurity", path: "skills/testing-oauth-authorization" },
    { name: "analyzing-kubernetes-audit-logs", description: "Analyze Kubernetes API server audit logs and RBAC changes.", domain: "cybersecurity", path: "skills/analyzing-kubernetes-audit-logs" }
  ]
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "localai-security-skills-"));
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  for (const skill of index.skills) {
    const directory = join(root, skill.path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `# ${skill.name}\nSpecialist playbook for ${skill.description}`);
  }
  return root;
}

describe("external security skill runtime", () => {
  it("validates exact pinned repository metadata and skill count", () => {
    const validated = validateExternalSecuritySkillIndex(index);
    expect(validated.total_skills).toBe(3);
    expect(() => validateExternalSecuritySkillIndex({ ...index, total_skills: 4 })).toThrow("external_security_skill_count_mismatch");
    expect(() => validateExternalSecuritySkillIndex({ ...index, repository: "https://github.com/evil/repo" })).toThrow("external_security_skill_repository_mismatch");
  });

  it("rejects path mismatches instead of reading arbitrary files", () => {
    const poisoned = { ...index, skills: [{ ...index.skills[0], path: "skills/../secrets" }], total_skills: 1 };
    expect(() => validateExternalSecuritySkillIndex(poisoned)).toThrow("external_security_skill_path_mismatch");
  });

  it("infers specialist routing domains deterministically", () => {
    expect(inferSecurityDomains("testing-idor", "REST API authorization BOLA")).toContain("api");
    expect(inferSecurityDomains("adcs-shadow-credentials", "Active Directory Kerberos privilege path")).toContain("identity");
    expect(inferSecurityDomains("kubernetes-rbac", "Kubernetes cluster pod RBAC")).toContain("container");
  });

  it("converts every index entry to knowledge-only graph nodes", () => {
    const nodes = externalIndexToSecurityNodes(validateExternalSecuritySkillIndex(index));
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.executionClass === "knowledge_only" && node.requiresAuthorization === true)).toBe(true);
  });

  it("loads only top relevant lab skills and wraps them in an authorization boundary", async () => {
    const runtime = new ExternalSecuritySkillRuntime(await fixture(), undefined, 2, 20_000);
    const prepared = await runtime.prepare("lab", "Check this REST API for IDOR/BOLA and OAuth authorization weaknesses");
    expect(prepared.names).toHaveLength(2);
    expect(prepared.names).toContain("external-security:testing-idor-in-rest-apis");
    expect(prepared.names).toContain("external-security:testing-oauth-authorization");
    expect(prepared.skills).toHaveLength(2);
    expect(prepared.skills.map((skill) => skill.name)).toEqual(prepared.names);
    expect(prepared.instructions).toContain("execution=knowledge_only");
    expect(prepared.instructions).toContain("never grants shell, network, mutation, destructive, credential or scope authority");
    expect(prepared.instructions).not.toContain("analyzing-kubernetes-audit-logs");
  });

  it("never injects external security skills outside lab mode", async () => {
    const runtime = new ExternalSecuritySkillRuntime(await fixture());
    await expect(runtime.prepare("code", "test IDOR in this API")).resolves.toEqual({ names: [], instructions: "", skills: [] });
    await expect(runtime.prepare("chat", "OAuth attack paths")).resolves.toEqual({ names: [], instructions: "", skills: [] });
  });
});
