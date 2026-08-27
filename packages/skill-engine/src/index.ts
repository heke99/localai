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

export class SkillEngine {
  private readonly skills: Map<string, SkillMetadata>;
  constructor(manifest: SkillManifest, private readonly reader?: SkillBodyReader) {
    if (manifest.schemaVersion !== 1) throw new Error("unsupported_skill_manifest");
    this.skills = new Map(manifest.skills.map((skill) => [skill.name, skill]));
    if (this.skills.size !== manifest.skills.length) throw new Error("duplicate_skill_name");
  }

  select(mode: string, prompt: string): SkillSelection[] {
    const requested = new Set(modeDefaults[mode] ?? ["using-skills", "reasoning-router", "verification-before-completion"]);
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
