/** Runtime skill policy is independent of model, provider, endpoint and tokenizer. */
export interface SkillRuntimeOptions {
  readonly profile: "minimal" | "legacy";
  readonly additionalSkills: readonly string[];
  readonly loadExternalSecuritySkills: boolean;
  readonly maxSkills: number;
  /** UTF-16 code units, including skill headings/separators; not a token count. */
  readonly maxInstructionChars: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function positiveInteger(env: Environment, name: string, fallback: number, ceiling: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_skill_configuration:${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`invalid_skill_configuration:${name}`);
  return value;
}

function booleanValue(env: Environment, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`invalid_skill_configuration:${name}`);
}

export function validateSkillRuntimeOptions(options: SkillRuntimeOptions): SkillRuntimeOptions {
  if (options.profile !== "minimal" && options.profile !== "legacy") throw new Error("invalid_skill_configuration:profile");
  if (typeof options.loadExternalSecuritySkills !== "boolean") throw new Error("invalid_skill_configuration:loadExternalSecuritySkills");
  if (!Number.isSafeInteger(options.maxSkills) || options.maxSkills < 1 || options.maxSkills > 256) throw new Error("invalid_skill_configuration:maxSkills");
  if (!Number.isSafeInteger(options.maxInstructionChars) || options.maxInstructionChars < 1 || options.maxInstructionChars > 1_000_000) throw new Error("invalid_skill_configuration:maxInstructionChars");
  if (!Array.isArray(options.additionalSkills) || options.additionalSkills.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 100)) {
    throw new Error("invalid_skill_configuration:additionalSkills");
  }
  return Object.freeze({ ...options, additionalSkills: Object.freeze([...new Set(options.additionalSkills)]) });
}

/** Read only trusted worker configuration, never a prompt or tool-result setting. */
export function skillRuntimeOptionsFromEnvironment(env: Environment = typeof process === "undefined" ? {} : process.env): SkillRuntimeOptions {
  const profile = env.DIV3RSA_SKILL_PROFILE?.trim().toLowerCase() || "minimal";
  if (profile !== "minimal" && profile !== "legacy") throw new Error("invalid_skill_configuration:DIV3RSA_SKILL_PROFILE");
  return validateSkillRuntimeOptions({
    profile,
    additionalSkills: (env.DIV3RSA_SKILL_ADDITIONAL?.trim() || "").split(",").map((name) => name.trim()).filter(Boolean),
    loadExternalSecuritySkills: booleanValue(env, "DIV3RSA_SKILL_EXTERNAL_ENABLED", profile === "legacy"),
    maxSkills: positiveInteger(env, "DIV3RSA_SKILL_MAX_COUNT", profile === "minimal" ? 12 : 64, 256),
    maxInstructionChars: positiveInteger(env, "DIV3RSA_SKILL_MAX_INSTRUCTION_CHARS", profile === "minimal" ? 32_000 : 256_000, 1_000_000)
  });
}

/** Preserve live-information routing in every mode; specialists are explicit opt-ins. */
export function automaticSkillAllowed(name: string, options?: SkillRuntimeOptions): boolean {
  return !options || options.profile === "legacy" || name === "current-information-research";
}

export interface SkillInstructionBlock {
  metadata: { name: string; version: string };
  instructions: string;
}

/** Keep the existing worker's instruction format byte-for-byte. */
export function formatSkillInstructions(skills: readonly SkillInstructionBlock[]): string {
  return skills.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n");
}

export function assertSkillCount(count: number, options?: SkillRuntimeOptions): void {
  if (options && count > options.maxSkills) throw new Error(`skill_count_budget_exceeded:${count}:${options.maxSkills}`);
}

/** Never silently truncate a skill or remove one of its required dependencies. */
export function assertSkillInstructionBudget(skills: readonly SkillInstructionBlock[], options?: SkillRuntimeOptions): void {
  assertSkillCount(skills.length, options);
  if (!options) return;
  const chars = formatSkillInstructions(skills).length;
  if (chars > options.maxInstructionChars) throw new Error(`skill_instruction_budget_exceeded:${chars}:${options.maxInstructionChars}`);
}
