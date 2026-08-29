import type { TaskAnalysis } from "@div3rsa/agent-runtime";

export type SpecialistRole = "planner" | "researcher" | "coder" | "performance" | "tester" | "verifier";
export interface SpecialistPlanEntry { readonly role: SpecialistRole; readonly execution: "parallel-readonly" | "serial"; readonly allowedToolClasses: readonly string[]; readonly context: Readonly<Record<string, unknown>>; }
function bounded(value: string, max: number) { return value.trim().slice(0, Math.max(256, max)); }
function compactTask(task: TaskAnalysis) { return { categories: task.categories, risk: task.risk, complexity: task.complexity, reasoningLevel: task.reasoningLevel, informationFreshness: task.informationFreshness, researchDepth: task.researchDepth, requiresCurrentInformation: task.requiresCurrentInformation, requiresRepository: task.requiresRepository, requiresDatabase: task.requiresDatabase, requiresDeployment: task.requiresDeployment, requiresSecurityReview: task.requiresSecurityReview, verificationRequirements: task.verificationRequirements }; }
function requested(prompt: string, selectedSkills: readonly string[], pattern: RegExp) { return pattern.test(`${prompt}\n${selectedSkills.join("\n")}`); }

export function buildSpecialistPlan(input: { task: TaskAnalysis; prompt: string; selectedSkills: readonly string[]; maxSubagents: number; maxPromptChars: number; }): SpecialistPlanEntry[] {
  const task = compactTask(input.task); const request = bounded(input.prompt, input.maxPromptChars); const skills = input.selectedSkills.slice(0, 24); const common = { task, selectedSkills: skills };
  const entries: SpecialistPlanEntry[] = [{ role: "planner", execution: "parallel-readonly", allowedToolClasses: ["none"], context: { ...common, request } }];
  if (input.task.requiresCurrentInformation || input.task.researchDepth !== "none") entries.push({ role: "researcher", execution: "parallel-readonly", allowedToolClasses: ["web_search", "web_fetch", "current_time"], context: { task, request } });
  if (input.task.requiresRepository || requested(input.prompt, skills, /\b(code|coding|implementation|refactor|repository|repo|kod|implement|fix|bug)\b/i)) entries.push({ role: "coder", execution: "serial", allowedToolClasses: ["repository_read", "repository_write_after_checkpoint"], context: { ...common, request } });
  if (requested(input.prompt, skills, /\b(performance|latency|throughput|benchmark|profil|optimi[sz]|prestanda|snabbare)\b/i)) entries.push({ role: "performance", execution: "parallel-readonly", allowedToolClasses: ["repository_read", "metrics_read", "benchmark_read"], context: { task, request } });
  if (input.task.verificationRequirements.length > 0 || input.task.requiresRepository) entries.push({ role: "tester", execution: "parallel-readonly", allowedToolClasses: ["repository_read", "test_read", "ci_read"], context: { task, verificationRequirements: input.task.verificationRequirements, request } });
  entries.push({ role: "verifier", execution: "parallel-readonly", allowedToolClasses: ["evidence_read", "ci_read", "repository_read"], context: { task, request, verificationRequirements: input.task.verificationRequirements } });
  const priority: SpecialistRole[] = ["planner", "verifier", "coder", "researcher", "tester", "performance"];
  return entries.sort((a, b) => priority.indexOf(a.role) - priority.indexOf(b.role)).slice(0, Math.max(1, input.maxSubagents));
}

export function specialistInstruction(role: SpecialistRole, allowedToolClasses: readonly string[]): string {
  const boundary = `Authorized tool classes for this role: ${allowedToolClasses.join(", ")}. In this bounded advisory pass no tool is actually executed; never claim a tool was called or evidence was fetched.`;
  switch (role) {
    case "planner": return `You are the planner specialist. Produce a concise execution plan, dependencies, failure modes and checkpoints. ${boundary}`;
    case "researcher": return `You are the research specialist. Identify authoritative source categories, freshness requirements and claims that require live verification. ${boundary}`;
    case "coder": return `You are the coding specialist. Propose the smallest coherent implementation surface, affected dependencies and mutation order. Treat every write as requiring a checkpoint and later verification. ${boundary}`;
    case "performance": return `You are the performance specialist. Identify measurable bottlenecks, baselines, benchmark design and non-regression thresholds. ${boundary}`;
    case "tester": return `You are the testing specialist. Define the minimum unit, integration, end-to-end and regression evidence needed for safe completion. ${boundary}`;
    case "verifier": return `You are an independent verifier specialist. Challenge assumptions, identify unsupported claims, and define fail-closed acceptance criteria. Do not trust other specialists merely because they agree. ${boundary}`;
  }
}
