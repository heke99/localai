export interface SkillMetadata {
  name: string;
  path: string;
  category: string;
  description: string;
  version: string;
  sha256: string;
}

export interface SkillManifest { schemaVersion: 1; skills: SkillMetadata[] }
export interface SkillSelection { metadata: SkillMetadata; reason: string; activationOrder: number }
export interface SkillBodyReader { read(path: string): Promise<string> }

const dependencies: Record<string, string[]> = {
  "test-driven-development": ["writing-plans"],
  "code-review": ["verification-before-completion"],
  "browser-e2e": ["verification-before-completion"],
  "knowledge-ingestion": ["data-poisoning-defense", "secrets-handling"],
  "authorized-pentest": ["policy-access-control", "sandbox-execution", "network-egress-control"],
  "gpu-model-operations": ["supply-chain-security", "evals-benchmarking"]
};

const modeDefaults: Record<string, string[]> = {
  chat: ["verification-before-completion"],
  code: ["writing-plans", "test-driven-development", "verification-before-completion"],
  lab: ["authorized-pentest", "verification-before-completion"],
  research: ["web-research", "verification-before-completion"]
};

const signals: Array<[RegExp, string[]]> = [
  [/bug|error|failed|debug/i, ["systematic-debugging"]],
  [/supabase|postgres|rls|database|sql/i, ["supabase-postgres"]],
  [/github|pull request|repository|branch/i, ["github-operations"]],
  [/vercel|deploy/i, ["vercel-operations"]],
  [/browser|e2e|playwright/i, ["browser-e2e"]],
  [/performance|latency|load test/i, ["performance-profiling"]],
  [/learn|knowledge|document|ingest/i, ["knowledge-ingestion"]],
  [/model|gpu|cuda|quantization/i, ["gpu-model-operations"]],
  [/security review|audit|threat/i, ["audit-context-building", "differential-security-review"]]
];

export class SkillEngine {
  private readonly skills: Map<string, SkillMetadata>;
  constructor(manifest: SkillManifest, private readonly reader?: SkillBodyReader) {
    if (manifest.schemaVersion !== 1) throw new Error("unsupported_skill_manifest");
    this.skills = new Map(manifest.skills.map((skill) => [skill.name, skill]));
    if (this.skills.size !== manifest.skills.length) throw new Error("duplicate_skill_name");
  }

  select(mode: string, prompt: string): SkillSelection[] {
    const requested = new Set(modeDefaults[mode] ?? ["verification-before-completion"]);
    for (const [pattern, names] of signals) if (pattern.test(prompt)) names.forEach((name) => requested.add(name));
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const add = (name: string) => {
      if (ordered.includes(name)) return;
      if (visiting.has(name)) throw new Error(`skill_dependency_cycle:${name}`);
      if (!this.skills.has(name)) throw new Error(`unknown_skill:${name}`);
      visiting.add(name);
      for (const dependency of dependencies[name] ?? []) add(dependency);
      visiting.delete(name);
      ordered.push(name);
    };
    requested.forEach(add);
    const verifier = ordered.indexOf("verification-before-completion");
    if (verifier >= 0) ordered.push(...ordered.splice(verifier, 1));
    return ordered.map((name, index) => ({ metadata: this.skills.get(name)!, reason: requested.has(name) ? "mode_or_prompt_match" : "dependency", activationOrder: index + 1 }));
  }

  async load(selection: SkillSelection[]): Promise<Array<SkillSelection & { instructions: string }>> {
    if (!this.reader) throw new Error("skill_body_reader_unavailable");
    return Promise.all(selection.map(async (selected) => ({ ...selected, instructions: await this.reader!.read(selected.metadata.path) })));
  }
}
