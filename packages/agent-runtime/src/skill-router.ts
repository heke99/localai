import type { AgentMode } from "./contracts";
import { analyzeTask, type TaskAnalysis, type TaskCategory } from "./task-analyzer";

export interface SkillDescriptor {
  name: string;
  category: "process" | "domain" | "verification";
  modes: AgentMode[];
  taskCategories?: TaskCategory[];
  triggers?: RegExp[];
  dependencies?: string[];
}

const SKILLS: SkillDescriptor[] = [
  { name: "writing-plans", category: "process", modes: ["code", "lab", "research"], triggers: [/.*/] },
  { name: "repo-understanding", category: "process", modes: ["code"], triggers: [/.*/], dependencies: ["writing-plans"] },
  { name: "systematic-debugging", category: "domain", modes: ["code"], taskCategories: ["bugfix", "debug"], dependencies: ["repo-understanding"] },
  { name: "test-driven-development", category: "domain", modes: ["code"], taskCategories: ["build", "bugfix", "refactor", "testing"], dependencies: ["writing-plans"] },
  { name: "browser-e2e", category: "domain", modes: ["code"], taskCategories: ["frontend", "design", "testing"], dependencies: ["verification-before-completion"] },
  { name: "performance-profiling", category: "domain", modes: ["code"], taskCategories: ["performance"], dependencies: ["repo-understanding"] },
  { name: "supabase-postgres", category: "domain", modes: ["code"], taskCategories: ["database", "migration"], dependencies: ["repo-understanding"] },
  { name: "github-operations", category: "domain", modes: ["code"], taskCategories: ["repo_understanding", "deployment"], dependencies: ["repo-understanding"] },
  { name: "vercel-operations", category: "domain", modes: ["code"], taskCategories: ["deployment"], dependencies: ["verification-before-completion"] },
  { name: "audit-context-building", category: "domain", modes: ["code", "lab"], taskCategories: ["audit", "security"], dependencies: ["repo-understanding"] },
  { name: "differential-security-review", category: "domain", modes: ["code", "lab"], taskCategories: ["security", "audit"], dependencies: ["audit-context-building"] },
  { name: "code-review", category: "verification", modes: ["code"], taskCategories: ["build", "bugfix", "refactor", "audit", "architecture"], dependencies: ["verification-before-completion"] },
  { name: "knowledge-ingestion", category: "domain", modes: ["research", "code"], taskCategories: ["knowledge_ingestion"] },
  { name: "gpu-model-operations", category: "domain", modes: ["code"], triggers: [/gpu|model|qwen|quantization|inference/i] },
  { name: "authorized-pentest", category: "domain", modes: ["lab"], triggers: [/.*/], dependencies: ["writing-plans"] },
  { name: "web-research", category: "domain", modes: ["research"], triggers: [/.*/], dependencies: ["writing-plans"] },
  { name: "verification-before-completion", category: "verification", modes: ["chat", "code", "lab", "research"], triggers: [/.*/] }
];

function matchesTask(skill: SkillDescriptor, analysis: TaskAnalysis, prompt: string): boolean {
  const categoryMatch = skill.taskCategories?.some((category) => analysis.categories.includes(category)) ?? false;
  const triggerMatch = skill.triggers?.some((trigger) => trigger.test(prompt)) ?? false;
  return categoryMatch || triggerMatch;
}

export function routeSkills(mode: AgentMode, prompt: string, analysis: TaskAnalysis = analyzeTask(mode, prompt)): string[] {
  const matched = SKILLS.filter((skill) => skill.modes.includes(mode) && matchesTask(skill, analysis, prompt));
  const selected = new Set<string>();
  const add = (name: string, visiting = new Set<string>()) => {
    if (selected.has(name)) return;
    if (visiting.has(name)) throw new Error(`skill_dependency_cycle:${name}`);
    const descriptor = SKILLS.find((skill) => skill.name === name);
    if (!descriptor) throw new Error(`unknown_skill:${name}`);
    visiting.add(name);
    for (const dependency of descriptor.dependencies ?? []) add(dependency, visiting);
    visiting.delete(name);
    selected.add(name);
  };
  matched.forEach((skill) => add(skill.name));

  return [...selected].sort((a, b) => {
    const descriptor = (name: string) => SKILLS.find((skill) => skill.name === name)!;
    const rank = (name: string) => descriptor(name).category === "process" ? 0 : descriptor(name).category === "verification" ? 2 : 1;
    return rank(a) - rank(b);
  });
}

export function assertModeAuthorization(mode: AgentMode, authorization?: AgentRunRequestAuthorization): void {
  if (mode !== "lab") return;
  if (!authorization?.target || !authorization.scope || new Date(authorization.expiresAt).getTime() <= Date.now()) {
    throw new Error("lab_authorization_required");
  }
}

type AgentRunRequestAuthorization = { target: string; scope: string; expiresAt: string };
