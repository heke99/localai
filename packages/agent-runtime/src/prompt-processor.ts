import type { AgentMode } from "./contracts";
import { executionPolicyFor, type AgentExecutionPolicy } from "./execution-policy";
import { analyzeTask, type InformationFreshness, type ProjectContext, type ReasoningLevel, type ResearchDepth, type TaskAnalysis, type TaskCategory, type TaskRisk } from "./task-analyzer";

export interface ExecutionRequirements {
  repo: boolean;
  web: boolean;
  browser: boolean;
  database: boolean;
  deployment: boolean;
  securityReview: boolean;
  mutation: boolean;
  tests: boolean;
}

export interface DetectionResult {
  detected: boolean;
  reasons: string[];
}

export interface ExecutionContract {
  schemaVersion: 1;
  normalizedPrompt: string;
  intent: TaskCategory;
  mode: AgentMode;
  risk: TaskRisk;
  freshness: InformationFreshness;
  depth: ReasoningLevel;
  researchDepth: ResearchDepth;
  requirements: string[];
  constraints: string[];
  requires: ExecutionRequirements;
  skills: string[];
  contextBudget: number;
  execution: AgentExecutionPolicy;
  ambiguity: DetectionResult;
  contradictions: DetectionResult;
  affectedDomains: string[];
  verificationRequirements: string[];
  analysis: TaskAnalysis;
}

export const EXECUTION_CONTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "mode", "risk", "freshness", "depth", "requirements", "constraints", "requires", "skills", "contextBudget"],
  properties: {
    intent: { type: "string" },
    mode: { enum: ["chat", "code", "lab", "research"] },
    risk: { enum: ["low", "medium", "high", "critical"] },
    freshness: { enum: ["stable", "current", "live"] },
    depth: { enum: ["fast", "standard", "deep"] },
    requirements: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    requires: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "web", "browser", "database", "deployment", "securityReview", "mutation", "tests"],
      properties: {
        repo: { type: "boolean" }, web: { type: "boolean" }, browser: { type: "boolean" }, database: { type: "boolean" },
        deployment: { type: "boolean" }, securityReview: { type: "boolean" }, mutation: { type: "boolean" }, tests: { type: "boolean" }
      }
    },
    skills: { type: "array", items: { type: "string" } },
    contextBudget: { type: "integer", minimum: 1 }
  }
} as const;

const mutationCategories = new Set<TaskCategory>(["build", "bugfix", "refactor", "migration", "deployment"]);
const requirementSignal = /\b(?:must|need(?:s)? to|required|requirement|ensure|should|måste|behöver|krävs|säkerställ|ska)\b/i;
const constraintSignal = /\b(?:do not|don'?t|must not|without|avoid|never|inte|får inte|utan|undvik|aldrig)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function sentences(prompt: string): string[] {
  return prompt.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
}

function extractRequirements(prompt: string): string[] {
  return unique(sentences(prompt).filter((sentence) => requirementSignal.test(sentence) && !constraintSignal.test(sentence)));
}

function extractConstraints(prompt: string): string[] {
  return unique(sentences(prompt).filter((sentence) => constraintSignal.test(sentence)));
}

function positiveRoutingPrompt(prompt: string): string {
  const positive = sentences(prompt).filter((sentence) => !constraintSignal.test(sentence)).join(" ").trim();
  return positive || prompt;
}

function detectAmbiguity(prompt: string): DetectionResult {
  const reasons: string[] = [];
  const words = prompt.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length < 3) reasons.push("underspecified_request");
  if (/^(?:fix|ändra|gör|do|update)\s+(?:it|this|that|det|den|detta)[.!?]?$/i.test(prompt)) reasons.push("unresolved_referent");
  return { detected: reasons.length > 0, reasons };
}

function detectContradictions(prompt: string): DetectionResult {
  const reasons: string[] = [];
  if (/\bdeploy\b/i.test(prompt) && /\b(?:do not|don'?t|must not|never)\s+deploy\b/i.test(prompt)) reasons.push("deploy_and_do_not_deploy");
  if (/\b(?:search|browse|web search|sök)\b/i.test(prompt) && /\b(?:without|do not|don'?t|never|utan)\b[^.!?]{0,40}\b(?:web|internet|browse|search|sök)\b/i.test(prompt)) reasons.push("web_and_no_web");
  if (/\b(?:change|modify|edit|update|ändra|implement)\b/i.test(prompt) && /\b(?:do not|don'?t|without|never|inte|utan)\b[^.!?]{0,40}\b(?:change|modify|edit|update|ändra|mutation)\b/i.test(prompt)) reasons.push("mutation_and_no_mutation");
  return { detected: reasons.length > 0, reasons };
}

function executionRequirements(task: TaskAnalysis): ExecutionRequirements {
  const executionScope = task.requiresRepository || task.requiresDatabase || task.requiresDeployment;
  return {
    repo: task.requiresRepository,
    web: task.requiresCurrentInformation,
    browser: task.requiresBrowser,
    database: task.requiresDatabase,
    deployment: task.requiresDeployment,
    securityReview: task.requiresSecurityReview,
    mutation: executionScope && task.categories.some((category) => mutationCategories.has(category)),
    tests: task.verificationRequirements.some((item) => /test|e2e|regression/i.test(item))
  };
}

export function processPrompt(mode: AgentMode, prompt: string, project: ProjectContext = {}): ExecutionContract {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) throw new Error("prompt_required");
  const requirements = extractRequirements(normalizedPrompt);
  const constraints = extractConstraints(normalizedPrompt);
  const analysis = analyzeTask(mode, positiveRoutingPrompt(normalizedPrompt), project);
  const execution = executionPolicyFor(analysis);
  return {
    schemaVersion: 1,
    normalizedPrompt,
    intent: analysis.primaryCategory,
    mode,
    risk: analysis.risk,
    freshness: analysis.informationFreshness,
    depth: analysis.reasoningLevel,
    researchDepth: analysis.researchDepth,
    requirements,
    constraints,
    requires: executionRequirements(analysis),
    skills: [],
    contextBudget: execution.maxContextTokens,
    execution,
    ambiguity: detectAmbiguity(normalizedPrompt),
    contradictions: detectContradictions(normalizedPrompt),
    affectedDomains: analysis.affectedDomains,
    verificationRequirements: analysis.verificationRequirements,
    analysis
  };
}

export function withSelectedSkills(contract: ExecutionContract, skills: string[]): ExecutionContract {
  return { ...contract, skills: unique(skills) };
}
