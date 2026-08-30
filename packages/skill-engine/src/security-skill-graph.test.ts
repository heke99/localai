import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE,
  selectSecuritySkills,
  validateExternalSkillSource,
  validateSecuritySkillNode,
  type SecuritySkillNode
} from "./security-skill-graph";

const source = ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE;
const nodes: SecuritySkillNode[] = [
  {
    id: "api-authorization-review",
    name: "API authorization review",
    description: "Reason about BOLA, IDOR and tenant authorization boundaries in APIs.",
    domains: ["api", "auth", "business_logic"],
    tags: ["api", "idor", "bola", "tenant", "authorization"],
    sourceId: source.id,
    sourcePath: "skills/api-authorization-review/SKILL.md",
    executionClass: "knowledge_only",
    requiresAuthorization: true
  },
  {
    id: "cloud-iam-review",
    name: "Cloud IAM review",
    description: "Analyze cloud IAM relationships and privilege boundaries.",
    domains: ["cloud", "identity"],
    tags: ["aws", "azure", "gcp", "iam", "privilege"],
    sourceId: source.id,
    sourcePath: "skills/cloud-iam-review/SKILL.md",
    executionClass: "knowledge_only",
    requiresAuthorization: true
  },
  {
    id: "bug-bounty-reporting",
    name: "Bug bounty reporting",
    description: "Turn verified findings and evidence into a reproducible disclosure report.",
    domains: ["reporting"],
    tags: ["bug bounty", "report", "evidence", "disclosure"],
    sourceId: source.id,
    sourcePath: "skills/bug-bounty-reporting/SKILL.md",
    executionClass: "knowledge_only"
  }
];

describe("security skill graph", () => {
  it("uses a commit-pinned Apache-2.0 upstream source", () => {
    expect(validateExternalSkillSource(source)).toEqual(source);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.license).toBe("Apache-2.0");
    expect(source.executionClass).toBe("knowledge_only");
  });

  it("rejects floating upstream refs", () => {
    expect(() => validateExternalSkillSource({ ...source, commit: "main" })).toThrow("skill_source_commit_must_be_pinned");
  });

  it("rejects path traversal", () => {
    expect(() => validateSecuritySkillNode({ ...nodes[0], sourcePath: "../escape/SKILL.md" }, [source])).toThrow("invalid_security_skill_source_path");
  });

  it("prevents imported knowledge from escalating itself into execution", () => {
    expect(() => validateSecuritySkillNode({ ...nodes[0], executionClass: "active_test" }, [source])).toThrow("security_skill_execution_escalation:api-authorization-review");
  });

  it("routes only a compact deterministic set in lab mode", () => {
    const selected = selectSecuritySkills(nodes, [source], {
      mode: "lab",
      prompt: "Review this API for tenant IDOR/BOLA authorization issues and prepare a bug bounty report",
      maxSkills: 2
    });
    expect(selected).toHaveLength(2);
    expect(selected[0].skill.id).toBe("api-authorization-review");
    expect(selected.map((match) => match.skill.id)).toContain("bug-bounty-reporting");
  });

  it("does not activate offensive security knowledge outside lab mode", () => {
    expect(selectSecuritySkills(nodes, [source], { mode: "chat", prompt: "find IDOR" })).toEqual([]);
  });

  it("hard caps selection at eight skills", () => {
    const expanded = Array.from({ length: 20 }, (_, index): SecuritySkillNode => ({
      ...nodes[0],
      id: `api-review-${String(index).padStart(2, "0")}`,
      name: `API review ${index}`,
      sourcePath: `skills/api-review-${index}/SKILL.md`
    }));
    expect(selectSecuritySkills(expanded, [source], { mode: "lab", prompt: "api authorization idor", maxSkills: 50 })).toHaveLength(8);
  });
});
