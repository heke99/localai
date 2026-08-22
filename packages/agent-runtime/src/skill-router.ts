import type { AgentMode } from "./contracts";

export interface SkillDescriptor {
  name: string;
  category: "process" | "domain" | "verification";
  modes: AgentMode[];
  triggers: RegExp[];
  dependencies?: string[];
}

const SKILLS: SkillDescriptor[] = [
  { name: "implementation-planning", category: "process", modes: ["code", "lab", "research"], triggers: [/.*/] },
  { name: "repo-understanding", category: "domain", modes: ["code"], triggers: [/.*/] },
  { name: "test-driven-development", category: "domain", modes: ["code"], triggers: [/build|implement|fix|bug|code|test/i], dependencies: ["implementation-planning"] },
  { name: "authorized-pentest", category: "domain", modes: ["lab"], triggers: [/.*/], dependencies: ["implementation-planning"] },
  { name: "research", category: "domain", modes: ["research"], triggers: [/.*/], dependencies: ["implementation-planning"] },
  { name: "verification-before-completion", category: "verification", modes: ["chat", "code", "lab", "research"], triggers: [/.*/] }
];

export function routeSkills(mode: AgentMode, prompt: string): string[] {
  const matched = SKILLS.filter((skill) => skill.modes.includes(mode) && skill.triggers.some((trigger) => trigger.test(prompt)));
  const selected = new Set(matched.map((skill) => skill.name));
  for (const skill of matched) for (const dependency of skill.dependencies ?? []) selected.add(dependency);
  return [...selected].sort((a, b) => {
    const rank = (name: string) => SKILLS.find((skill) => skill.name === name)?.category === "process" ? 0 : SKILLS.find((skill) => skill.name === name)?.category === "verification" ? 2 : 1;
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
