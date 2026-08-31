export type SkillCostLevel = "low" | "medium" | "high";

export interface SkillRoutingCost {
  context: SkillCostLevel;
  latency: SkillCostLevel;
}

export interface SkillMetadata {
  name: string;
  path: string;
  category: string;
  description: string;
  version: string;
  sha256: string;
  modes?: string[];
  triggers?: string[];
  requires?: string[];
  cost?: SkillRoutingCost;
  dependencies?: string[];
  conflicts?: string[];
  verification?: string[];
}

export interface SkillDescriptor {
  name: string;
  description: string;
  category: string;
  modes: string[];
  cost: SkillRoutingCost;
}

export interface SkillManifest { schemaVersion: 1; skills: SkillMetadata[] }
export interface SkillSelection { metadata: SkillMetadata; reason: string; activationOrder: number }
export interface SkillBodyReader { read(path: string): Promise<string> }

const legacyDependencies: Record<string, string[]> = {
  "brainstorming-design": ["using-skills"],
  "system-design": ["using-skills"],
  "writing-plans": ["using-skills"],
  "reasoning-router": ["using-skills"],
  "current-information-research": ["reasoning-router"],
  "capacity-benchmarking": ["performance-profiling", "evals-benchmarking"],
  "test-driven-development": ["writing-plans"],
  "systematic-debugging": ["using-skills"],
  "code-review": ["verification-before-completion"],
  "browser-e2e": ["verification-before-completion"],
  "knowledge-ingestion": ["data-poisoning-defense", "secrets-handling"],
  "memory-learning": ["data-poisoning-defense"],
  "authorized-pentest": ["policy-access-control", "sandbox-execution", "network-egress-control"],
  "audit-context-building": ["using-skills"],
  "differential-security-review": ["audit-context-building", "verification-before-completion"],
  "static-analysis": ["audit-context-building"],
  "gpu-model-operations": ["supply-chain-security", "evals-benchmarking"],
  "incident-recovery": ["observability"],
  "agentic-ci-security": ["policy-access-control", "secrets-handling", "supply-chain-security"]
};

const modeDefaults: Record<string, string[]> = {
  chat: ["using-skills", "reasoning-router", "verification-before-completion"],
  code: ["using-skills", "reasoning-router", "writing-plans", "test-driven-development", "verification-before-completion"],
  lab: ["using-skills", "reasoning-router", "authorized-pentest", "verification-before-completion"],
  research: ["using-skills", "reasoning-router", "web-research", "current-information-research", "verification-before-completion"]
};

const signals: Array<[RegExp, string[]]> = [
  [/new feature|build|implement|create|architecture change/i, ["brainstorming-design"]],
  [/architecture|system design|multi[- ]service|provider|adapter|portable|portability|boundary/i, ["system-design"]],
  [/bug|error|failed|failure|debug|regression|stack trace/i, ["systematic-debugging"]],
  [/review|refactor|cleanup|clean code|legacy|large file|complexity/i, ["code-review"]],
  [/supabase|postgres|rls|database|sql|migration|query|index/i, ["supabase-postgres"]],
  [/github|pull request|repository|repo\b|branch|commit|merge/i, ["github-operations"]],
  [/vercel|deploy|deployment|rollback|runtime log/i, ["vercel-operations"]],
  [/browser|e2e|playwright|responsive|viewport|accessibility|a11y|visual review|frontend|\bui\b/i, ["browser-e2e"]],
  [/performance|latency|slow|load test|k6|lighthouse|bundle|lcp|cls|inp|n\+1/i, ["performance-profiling"]],
  [/parallel|concurren|ttft|tokens\/s|tokens per second|p95|p99|kv cache|batch size|ubatch|throughput/i, ["capacity-benchmarking"]],
  [/latest|newest|current|currently|today|recent|up[- ]to[- ]date|right now|senaste|nyaste|aktuell|aktuella|idag|just nu|nuvarande|visa|visum|tax|skatt|regulation|regel|regler|price|pris|weather|väder|exchange rate|valutakurs/i, ["current-information-research"]],
  [/learn|knowledge|document|ingest|source material/i, ["knowledge-ingestion"]],
  [/memory|verified history|self[- ]improv|training data|experience/i, ["memory-learning"]],
  [/model|gpu|cuda|quantization|q8|inference|vram/i, ["gpu-model-operations"]],
  [/benchmark|eval|candidate model|canary|quality score/i, ["evals-benchmarking"]],
  [/security review|audit|threat|authorization|auth review|trust boundary/i, ["audit-context-building", "differential-security-review"]],
  [/semgrep|codeql|static analysis|sast|sarif|vulnerability scan/i, ["static-analysis"]],
  [/default credential|fail[- ]open|insecure default|debug mode|weak crypto/i, ["insecure-defaults"]],
  [/unsafe api|sharp edge|misuse[- ]resistant|footgun/i, ["sharp-edges"]],
  [/secret|credential|token|private key|api key/i, ["secrets-handling"]],
  [/dependency|package|container|third[- ]party|supply chain|model artifact|dataset/i, ["supply-chain-security"]],
  [/incident|outage|production failure|service down|recover/i, ["incident-recovery"]],
  [/observability|telemetry|trace|metrics|run id|latency breakdown/i, ["observability"]],
  [/github action|workflow|agentic ci|ai agent.*ci|ci.*agent/i, ["agentic-ci-security"]],
  [/property[- ]based|fuzz|invariant/i, ["property-based-testing"]]
];

const defaultCost: SkillRoutingCost = { context: "low", latency: "low" };
const externalSecurityQuery = Symbol("externalSecurityQuery");
type SkillSelectionQueryCarrier = SkillSelection[] & { [externalSecurityQuery]?: { mode: string; prompt: string } };
type ExternalSecurityRuntime = import("./external-security-runtime").ExternalSecuritySkillRuntime;
let externalSecurityRuntimeCache: { root: string; runtime: ExternalSecurityRuntime } | null = null;

async function externalSecurityRoot(): Promise<string | null> {
  if (typeof process === "undefined") return null;
  const explicit = process.env.DIV3RSA_SECURITY_SKILL_ROOT?.trim();
  if (explicit) return explicit;
  const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT?.trim();
  if (!repositoryRoot) return null;
  const [{ resolve }, { ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE }] = await Promise.all([
    import("node:path"),
    import("./security-skill-graph")
  ]);
  return resolve(repositoryRoot, "..", "runtime", "security-skills", ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE.commit);
}

export class SkillEngine {
  private readonly skills: Map<string, SkillMetadata>;
  constructor(manifest: SkillManifest, private readonly reader?: SkillBodyReader) {
    if (manifest.schemaVersion !== 1) throw new Error("unsupported_skill_manifest");
    for (const skill of manifest.skills) {
      if (!/^[a-f0-9]{64}$/i.test(skill.sha256)) throw new Error(`invalid_skill_sha256:${skill.name}`);
    }
    this.skills = new Map(manifest.skills.map((skill) => [skill.name, skill]));
    if (this.skills.size !== manifest.skills.length) throw new Error("duplicate_skill_name");
  }

  descriptors(mode?: string): SkillDescriptor[] {
    return [...this.skills.values()]
      .filter((skill) => !mode || !skill.modes?.length || skill.modes.includes(mode))
      .map((skill) => ({ name: skill.name, description: skill.description, category: skill.category, modes: skill.modes ?? [], cost: skill.cost ?? defaultCost }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  select(mode: string, prompt: string): SkillSelection[] {
    const requested = new Set(modeDefaults[mode] ?? ["using-skills", "reasoning-router", "verification-before-completion"]);
    for (const [pattern, names] of signals) if (pattern.test(prompt)) names.forEach((name) => requested.add(name));
    for (const skill of this.skills.values()) {
      if (skill.modes?.length && !skill.modes.includes(mode)) continue;
      if (skill.triggers?.some((trigger) => trigger.length > 0 && prompt.toLowerCase().includes(trigger.toLowerCase()))) requested.add(skill.name);
    }
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const add = (name: string) => {
      if (ordered.includes(name)) return;
      if (visiting.has(name)) throw new Error(`skill_dependency_cycle:${name}`);
      const skill = this.skills.get(name);
      if (!skill) throw new Error(`unknown_skill:${name}`);
      if (skill.modes?.length && !skill.modes.includes(mode)) throw new Error(`skill_mode_conflict:${name}:${mode}`);
      visiting.add(name);
      for (const dependency of skill.dependencies ?? legacyDependencies[name] ?? []) add(dependency);
      visiting.delete(name);
      ordered.push(name);
    };
    requested.forEach(add);
    const selected = new Set(ordered);
    for (const name of ordered) {
      const conflict = this.skills.get(name)?.conflicts?.find((candidate) => selected.has(candidate));
      if (conflict) throw new Error(`skill_conflict:${name}:${conflict}`);
    }
    const verifier = ordered.indexOf("verification-before-completion");
    if (verifier >= 0) ordered.push(...ordered.splice(verifier, 1));
    const result: SkillSelectionQueryCarrier = ordered.map((name, index) => ({ metadata: this.skills.get(name)!, reason: requested.has(name) ? "mode_or_prompt_match" : "dependency", activationOrder: index + 1 }));
    Object.defineProperty(result, externalSecurityQuery, { value: { mode, prompt }, enumerable: false });
    return result;
  }

  async load(selection: SkillSelection[]): Promise<Array<SkillSelection & { instructions: string }>> {
    if (!this.reader) throw new Error("skill_body_reader_unavailable");
    const { createHash } = await import("node:crypto");
    const local = await Promise.all(selection.map(async (selected) => {
      const instructions = await this.reader!.read(selected.metadata.path);
      const actual = createHash("sha256").update(instructions).digest("hex");
      if (actual !== selected.metadata.sha256.toLowerCase()) throw new Error(`skill_integrity_mismatch:${selected.metadata.name}`);
      return { ...selected, instructions };
    }));
    const query = (selection as SkillSelectionQueryCarrier)[externalSecurityQuery];
    if (!query || query.mode !== "lab") return local;

    const root = await externalSecurityRoot();
    if (!root) return local;
    const [{ access }, { resolve }, runtimeModule, graphModule] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("./external-security-runtime"),
      import("./security-skill-graph")
    ]);
    try {
      await access(resolve(root, "index.json"));
    } catch {
      return local;
    }

    if (!externalSecurityRuntimeCache || externalSecurityRuntimeCache.root !== root) {
      externalSecurityRuntimeCache = { root, runtime: new runtimeModule.ExternalSecuritySkillRuntime(root) };
    }
    const prepared = await externalSecurityRuntimeCache.runtime.prepare(query.mode, query.prompt);
    if (!prepared.skills.length) return local;

    const external = prepared.skills.map((skill, index) => ({
      metadata: {
        name: skill.name,
        path: `external://${graphModule.ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE.id}/${skill.name}`,
        category: "security-external",
        description: skill.description,
        version: graphModule.ANTHROPIC_CYBERSECURITY_SKILLS_SOURCE.commit,
        sha256: createHash("sha256").update(skill.instructions).digest("hex"),
        modes: ["lab"]
      },
      reason: "external_security_top_k",
      activationOrder: local.length + index + 1,
      instructions: skill.instructions
    }));

    const verifier = local.findIndex((item) => item.metadata.name === "verification-before-completion");
    if (verifier < 0) return [...local, ...external];
    return [...local.slice(0, verifier), ...external, ...local.slice(verifier)];
  }
}

export * from "./security-skill-graph";
export * from "./external-security-runtime";
