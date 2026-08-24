import type { AgentMode } from "./contracts";

export type TaskCategory =
  | "build"
  | "bugfix"
  | "debug"
  | "refactor"
  | "audit"
  | "performance"
  | "database"
  | "frontend"
  | "backend"
  | "design"
  | "security"
  | "testing"
  | "devops"
  | "architecture"
  | "research"
  | "knowledge_ingestion"
  | "repo_understanding"
  | "migration"
  | "deployment";

export type TaskRisk = "low" | "medium" | "high" | "critical";
export type TaskComplexity = "small" | "medium" | "large";

export interface ProjectContext {
  projectId?: string;
  repositoryId?: string;
  frameworks?: string[];
  languages?: string[];
  database?: string[];
  services?: string[];
  hosting?: string[];
}

export interface TaskAnalysis {
  primaryCategory: TaskCategory;
  categories: TaskCategory[];
  risk: TaskRisk;
  complexity: TaskComplexity;
  affectedDomains: string[];
  requiresRepository: boolean;
  requiresBrowser: boolean;
  requiresDatabase: boolean;
  requiresDeployment: boolean;
  requiresSecurityReview: boolean;
  verificationRequirements: string[];
  project: ProjectContext;
}

type Rule = { category: TaskCategory; pattern: RegExp; domains?: string[] };

const rules: Rule[] = [
  { category: "bugfix", pattern: /\bfix\b|\bbug\b|broken|regression|doesn'?t work|not working/i },
  { category: "debug", pattern: /debug|stack trace|exception|error|failed|failure|log(s)?\b/i },
  { category: "refactor", pattern: /refactor|clean up|simplif|legacy|large file|complexity|dead code/i },
  { category: "audit", pattern: /\baudit\b|review (the )?(whole|entire|security|architecture|code)|assessment/i },
  { category: "performance", pattern: /performance|latency|slow|lcp|cls|inp|bundle|n\+1|load test|k6|throughput/i, domains: ["performance"] },
  { category: "database", pattern: /database|postgres|supabase|sql|rls|migration|index|query plan|rpc\b/i, domains: ["database"] },
  { category: "frontend", pattern: /frontend|react|next\.?js|tsx|component|page|browser|responsive|mobile/i, domains: ["frontend"] },
  { category: "design", pattern: /design|layout|typography|spacing|visual|ui\b|ux\b|accessibility/i, domains: ["design", "frontend"] },
  { category: "backend", pattern: /backend|api\b|server|worker|queue|webhook|service/i, domains: ["backend"] },
  { category: "security", pattern: /security|auth\b|authorization|permission|secret|vulnerab|pentest|threat/i, domains: ["security"] },
  { category: "testing", pattern: /test|playwright|vitest|e2e|integration test|unit test|regression test/i, domains: ["testing"] },
  { category: "devops", pattern: /docker|kubernetes|ci\b|github actions|infrastructure|infra\b|gpu|compute/i, domains: ["devops"] },
  { category: "architecture", pattern: /architecture|system design|boundary|provider|adapter|portable|portability/i, domains: ["architecture"] },
  { category: "research", pattern: /research|investigate|compare|look up|documentation/i, domains: ["research"] },
  { category: "knowledge_ingestion", pattern: /learn (this|it)|ingest|knowledge source|read this.*learn/i, domains: ["knowledge"] },
  { category: "repo_understanding", pattern: /repository|repo\b|codebase|project structure|repo map/i, domains: ["repository"] },
  { category: "migration", pattern: /migrat(e|ion)|schema change|move data/i, domains: ["database", "deployment"] },
  { category: "deployment", pattern: /deploy|deployment|release|rollback|vercel|production/i, domains: ["deployment"] },
  { category: "build", pattern: /build|implement|create|add|make|develop/i }
];

const unique = <T>(values: T[]) => [...new Set(values)];

function riskFor(categories: TaskCategory[], prompt: string, mode: AgentMode): TaskRisk {
  if (mode === "lab" || /production database|service[_ -]?role|credential|secret|billing|payment|authorization|rls|schema migration/i.test(prompt)) return "critical";
  if (categories.some((category) => ["security", "migration", "deployment"].includes(category))) return "high";
  if (categories.some((category) => ["database", "backend", "architecture", "refactor", "performance"].includes(category))) return "medium";
  return "low";
}

function complexityFor(categories: TaskCategory[], prompt: string, project: ProjectContext): TaskComplexity {
  const breadth = categories.length + (project.frameworks?.length ?? 0) + (project.services?.length ?? 0);
  if (breadth >= 7 || /whole|entire|all affected|end[- ]to[- ]end|platform|multi[- ]agent/i.test(prompt)) return "large";
  if (breadth >= 3 || prompt.length > 1200) return "medium";
  return "small";
}

export function analyzeTask(mode: AgentMode, prompt: string, project: ProjectContext = {}): TaskAnalysis {
  const matched = rules.filter((rule) => rule.pattern.test(prompt));
  const categories = unique(matched.map((rule) => rule.category));
  if (!categories.length) categories.push(mode === "research" ? "research" : mode === "code" ? "repo_understanding" : "build");

  const affectedDomains = unique([
    ...matched.flatMap((rule) => rule.domains ?? []),
    ...(project.database?.length ? ["database"] : []),
    ...(project.hosting?.length ? ["deployment"] : [])
  ]);
  const risk = riskFor(categories, prompt, mode);
  const requiresRepository = mode === "code" || categories.some((category) => ["build", "bugfix", "debug", "refactor", "audit", "repo_understanding", "architecture", "testing"].includes(category));
  const requiresBrowser = categories.some((category) => ["frontend", "design", "testing", "performance"].includes(category));
  const requiresDatabase = categories.some((category) => ["database", "migration"].includes(category));
  const requiresDeployment = categories.includes("deployment");
  const requiresSecurityReview = risk === "critical" || risk === "high" || categories.includes("security");

  const verificationRequirements = unique([
    "diff-review",
    ...(requiresRepository ? ["consequence-analysis", "typecheck", "targeted-tests"] : []),
    ...(requiresDatabase ? ["database-invariants"] : []),
    ...(requiresBrowser ? ["browser-e2e"] : []),
    ...(categories.includes("design") ? ["multi-viewport-review", "accessibility"] : []),
    ...(categories.includes("performance") ? ["performance-regression"] : []),
    ...(requiresSecurityReview ? ["security-review"] : []),
    ...(requiresDeployment ? ["build", "deployment-health"] : []),
    "completion-proof"
  ]);

  return {
    primaryCategory: categories[0]!,
    categories,
    risk,
    complexity: complexityFor(categories, prompt, project),
    affectedDomains,
    requiresRepository,
    requiresBrowser,
    requiresDatabase,
    requiresDeployment,
    requiresSecurityReview,
    verificationRequirements,
    project
  };
}
