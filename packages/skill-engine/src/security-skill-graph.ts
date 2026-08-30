export type SecuritySkillDomain =
  | "recon"
  | "web"
  | "api"
  | "auth"
  | "business_logic"
  | "code"
  | "cloud"
  | "identity"
  | "container"
  | "mobile"
  | "dfir"
  | "ai_security"
  | "reporting";

export type SkillExecutionClass =
  | "knowledge_only"
  | "read_only"
  | "network_probe"
  | "active_test"
  | "mutation"
  | "destructive";

export interface ExternalSkillSource {
  id: string;
  repository: string;
  commit: string;
  rootPath: string;
  format: "agentskills";
  license: string;
  trust: "pinned_upstream" | "local";
  executionClass: SkillExecutionClass;
}

export interface SecuritySkillNode {
  id: string;
  name: string;
  description: string;
  domains: SecuritySkillDomain[];
  tags: string[];
  sourceId: string;
  sourcePath: string;
  executionClass: SkillExecutionClass;
  requiresAuthorization?: boolean;
}

export interface SecuritySkillQuery {
  prompt: string;
  mode: string;
  maxSkills?: number;
  contextBudgetChars?: number;
}

export interface SecuritySkillMatch {
  skill: SecuritySkillNode;
  score: number;
  matchedTerms: string[];
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._/-]*$/i;
const DEFAULT_MAX_SKILLS = 6;
const MAX_SELECTABLE_SKILLS = 8;
const DEFAULT_CONTEXT_BUDGET_CHARS = 28_000;

export const ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE: ExternalSkillSource = Object.freeze({
  id: "anthropic-cybersecurity-skills",
  repository: "mukul975/Anthropic-Cybersecurity-Skills",
  commit: "1b3f6b2286981381a5cc0566551ef3bb6bc38383",
  rootPath: "skills",
  format: "agentskills",
  license: "Apache-2.0",
  trust: "pinned_upstream",
  executionClass: "knowledge_only"
});

export function validateExternalSkillSource(source: ExternalSkillSource): ExternalSkillSource {
  if (!source.id || !SAFE_SEGMENT.test(source.id) || source.id.includes("/") || source.id.includes("..")) {
    throw new Error("invalid_skill_source_id");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) throw new Error("invalid_skill_source_repository");
  if (!COMMIT_SHA.test(source.commit)) throw new Error("skill_source_commit_must_be_pinned");
  if (!source.rootPath || source.rootPath.startsWith("/") || source.rootPath.includes("..") || !SAFE_SEGMENT.test(source.rootPath)) {
    throw new Error("invalid_skill_source_root_path");
  }
  if (source.trust === "pinned_upstream" && source.executionClass !== "knowledge_only") {
    throw new Error("upstream_skill_source_must_be_knowledge_only");
  }
  return source;
}

export function validateSecuritySkillNode(node: SecuritySkillNode, sources: readonly ExternalSkillSource[]): SecuritySkillNode {
  if (!node.id || !SAFE_SEGMENT.test(node.id) || node.id.includes("/") || node.id.includes("..")) throw new Error("invalid_security_skill_id");
  if (!node.name.trim() || !node.description.trim()) throw new Error("invalid_security_skill_metadata");
  if (!node.domains.length || !node.tags.length) throw new Error("security_skill_routing_metadata_required");
  if (node.sourcePath.startsWith("/") || node.sourcePath.includes("..") || !SAFE_SEGMENT.test(node.sourcePath)) throw new Error("invalid_security_skill_source_path");
  const source = sources.find((candidate) => candidate.id === node.sourceId);
  if (!source) throw new Error(`unknown_security_skill_source:${node.sourceId}`);
  validateExternalSkillSource(source);
  if (source.executionClass === "knowledge_only" && node.executionClass !== "knowledge_only") {
    throw new Error(`security_skill_execution_escalation:${node.id}`);
  }
  return node;
}

const DOMAIN_TERMS: Record<SecuritySkillDomain, string[]> = {
  recon: ["recon", "reconnaissance", "subdomain", "dns", "osint", "attack surface", "enumeration"],
  web: ["web", "http", "xss", "ssrf", "csrf", "upload", "request smuggling", "cache poisoning"],
  api: ["api", "rest", "graphql", "grpc", "bola", "idor", "endpoint"],
  auth: ["auth", "authentication", "authorization", "oauth", "oidc", "jwt", "session", "login", "mfa"],
  business_logic: ["business logic", "workflow", "race condition", "price", "coupon", "tenant", "multi-tenant"],
  code: ["source code", "code review", "sast", "dependency", "secret", "repository"],
  cloud: ["aws", "azure", "gcp", "cloud", "iam", "bucket", "serverless"],
  identity: ["active directory", "adcs", "kerberos", "ldap", "entra", "identity", "privilege"],
  container: ["docker", "container", "kubernetes", "k8s", "helm", "rbac"],
  mobile: ["android", "ios", "mobile", "apk", "ipa", "frida"],
  dfir: ["forensics", "dfir", "incident", "malware", "memory dump", "yara", "threat hunting"],
  ai_security: ["llm", "ai", "prompt injection", "agent", "mcp", "model", "rag"],
  reporting: ["report", "finding", "evidence", "cvss", "bug bounty", "disclosure"]
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9åäö._/-]+/g, " ").replace(/\s+/g, " ").trim();
}

function scoreNode(node: SecuritySkillNode, prompt: string): SecuritySkillMatch {
  const haystack = normalize(`${node.name} ${node.description} ${node.tags.join(" ")}`);
  const normalizedPrompt = normalize(prompt);
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const tag of node.tags) {
    const term = normalize(tag);
    if (term && normalizedPrompt.includes(term)) {
      matchedTerms.add(term);
      score += 5;
    }
  }
  for (const domain of node.domains) {
    for (const rawTerm of DOMAIN_TERMS[domain]) {
      const term = normalize(rawTerm);
      if (normalizedPrompt.includes(term)) {
        matchedTerms.add(term);
        score += 3;
      }
    }
    if (haystack.includes(normalizedPrompt) && normalizedPrompt.length >= 4) score += 1;
  }
  return { skill: node, score, matchedTerms: [...matchedTerms].sort() };
}

export function selectSecuritySkills(nodes: readonly SecuritySkillNode[], sources: readonly ExternalSkillSource[], query: SecuritySkillQuery): SecuritySkillMatch[] {
  if (query.mode !== "lab") return [];
  const maxSkills = Math.min(Math.max(query.maxSkills ?? DEFAULT_MAX_SKILLS, 1), MAX_SELECTABLE_SKILLS);
  const budget = Math.max(query.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS, 1_000);
  const validated = nodes.map((node) => validateSecuritySkillNode(node, sources));
  let estimatedChars = 0;

  return validated
    .map((node) => scoreNode(node, query.prompt))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .filter((match) => {
      if (estimatedChars >= budget) return false;
      estimatedChars += Math.min(match.skill.description.length + match.skill.tags.join(" ").length + 800, 6_000);
      return estimatedChars <= budget;
    })
    .slice(0, maxSkills);
}

export const SECURITY_REASONING_PRINCIPLES = Object.freeze([
  "Map the authorized attack surface before choosing tests.",
  "Form competing hypotheses and choose the smallest test that can distinguish them.",
  "Treat scanner output as evidence, not proof; independently verify material findings.",
  "After a verified primitive, explore realistic attack chains and business impact within scope.",
  "Actively try to falsify findings before reporting them.",
  "Keep knowledge selection separate from execution authorization; a skill never grants tool permission."
]);
