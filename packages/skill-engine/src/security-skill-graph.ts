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
  | "reporting"
  | "unknown";

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
  minimumRelativeScore?: number;
}

export interface SecuritySkillMatch {
  skill: SecuritySkillNode;
  score: number;
  matchedTerms: string[];
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._/-]*$/i;
const DEFAULT_MAX_SKILLS = 4;
const MAX_SELECTABLE_SKILLS = 8;
const DEFAULT_CONTEXT_BUDGET_CHARS = 18_000;
const DEFAULT_MINIMUM_RELATIVE_SCORE = 0.3;

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
  business_logic: ["business logic", "workflow", "race condition", "price", "coupon", "tenant", "multi tenant"],
  code: ["source code", "code review", "sast", "dependency", "secret", "repository"],
  cloud: ["aws", "azure", "gcp", "cloud", "iam", "bucket", "serverless"],
  identity: ["active directory", "adcs", "kerberos", "ldap", "entra", "identity", "privilege"],
  container: ["docker", "container", "kubernetes", "k8s", "helm", "rbac"],
  mobile: ["android", "ios", "mobile", "apk", "ipa", "frida"],
  dfir: ["forensics", "dfir", "incident", "malware", "memory dump", "yara", "threat hunting"],
  ai_security: ["llm", "prompt injection", "agentic", "agent security", "mcp", "model security", "rag", "ai security"],
  reporting: ["report", "finding", "evidence", "cvss", "bug bounty", "disclosure"],
  unknown: []
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9åäö]+/g, " ").replace(/\s+/g, " ").trim();
}

function includesTerm(normalizedText: string, rawTerm: string): boolean {
  const term = normalize(rawTerm);
  if (!term) return false;
  return ` ${normalizedText} `.includes(` ${term} `);
}

export function inferPromptSecurityDomains(prompt: string): SecuritySkillDomain[] {
  const normalizedPrompt = normalize(prompt);
  return (Object.entries(DOMAIN_TERMS) as Array<[SecuritySkillDomain, string[]]>)
    .filter(([domain, terms]) => domain !== "unknown" && terms.some((term) => includesTerm(normalizedPrompt, term)))
    .map(([domain]) => domain);
}

function scoreNode(node: SecuritySkillNode, prompt: string, promptDomains: ReadonlySet<SecuritySkillDomain>): SecuritySkillMatch {
  const normalizedPrompt = normalize(prompt);
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const tag of node.tags) {
    const term = normalize(tag);
    if (term && includesTerm(normalizedPrompt, term)) {
      matchedTerms.add(term);
      score += 6;
    }
  }
  for (const domain of node.domains) {
    if (domain !== "unknown" && promptDomains.has(domain)) {
      matchedTerms.add(`domain:${domain}`);
      score += 8;
    }
    for (const rawTerm of DOMAIN_TERMS[domain]) {
      const term = normalize(rawTerm);
      if (term && includesTerm(normalizedPrompt, term)) {
        matchedTerms.add(term);
        score += 3;
      }
    }
  }
  return { skill: node, score, matchedTerms: [...matchedTerms].sort() };
}

export function selectSecuritySkills(nodes: readonly SecuritySkillNode[], sources: readonly ExternalSkillSource[], query: SecuritySkillQuery): SecuritySkillMatch[] {
  if (query.mode !== "lab") return [];
  const maxSkills = Math.min(Math.max(query.maxSkills ?? DEFAULT_MAX_SKILLS, 1), MAX_SELECTABLE_SKILLS);
  const budget = Math.max(query.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS, 1_000);
  const relativeFloor = Math.min(1, Math.max(0, query.minimumRelativeScore ?? DEFAULT_MINIMUM_RELATIVE_SCORE));
  const validated = nodes.map((node) => validateSecuritySkillNode(node, sources));
  const promptDomains = new Set(inferPromptSecurityDomains(query.prompt));
  const ranked = validated
    .map((node) => scoreNode(node, query.prompt, promptDomains))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const topScore = ranked[0]?.score ?? 0;
  const minimumScore = topScore > 0 ? Math.max(1, Math.ceil(topScore * relativeFloor)) : 0;
  let estimatedChars = 0;

  return ranked
    .filter((match) => match.score >= minimumScore)
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
