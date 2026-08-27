import { searchRepository, type RepositoryIndex } from "./index";

export type ContextCompressionMode = "none" | "deterministic-pruning" | "semantic";

export interface ContextSelectionOptions {
  maxTokens?: number;
  dependencyDepth?: number;
  maxSeedFiles?: number;
}

export interface RepositoryContextItem {
  path: string;
  score: number;
  reasons: string[];
  symbols: string[];
  excerpt: string;
  estimatedTokens: number;
}

export interface RepositoryContextPacket {
  repositoryId: string;
  revisionHash: string;
  query: string;
  items: RepositoryContextItem[];
  repoMap: string;
  estimatedTokens: number;
  compression: ReturnType<typeof planContextCompression>;
}

interface Candidate {
  path: string;
  score: number;
  reasons: Set<string>;
}

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export function planContextCompression(estimatedTokens: number): { mode: ContextCompressionMode; semanticCompressorRequired: boolean } {
  if (estimatedTokens < 8_000) return { mode: "none", semanticCompressorRequired: false };
  if (estimatedTokens <= 16_000) return { mode: "deterministic-pruning", semanticCompressorRequired: false };
  return { mode: "semantic", semanticCompressorRequired: true };
}

function addCandidate(candidates: Map<string, Candidate>, path: string, score: number, reason: string): void {
  const current = candidates.get(path);
  if (current) {
    current.score = Math.max(current.score, score);
    current.reasons.add(reason);
    return;
  }
  candidates.set(path, { path, score, reasons: new Set([reason]) });
}

function expandDependencies(index: RepositoryIndex, candidates: Map<string, Candidate>, seeds: string[], maxDepth: number): void {
  const knownFiles = new Set(index.files.map((file) => file.path));
  let frontier = [...seeds];
  const visited = new Set(frontier);
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of index.edges) {
        if (edge.from === current && knownFiles.has(edge.to)) {
          addCandidate(candidates, edge.to, Math.max(10, 70 - depth * 10), `dependency:${depth}`);
          if (!visited.has(edge.to)) { visited.add(edge.to); next.push(edge.to); }
        }
        if (edge.to === current && knownFiles.has(edge.from)) {
          addCandidate(candidates, edge.from, Math.max(10, 75 - depth * 10), `caller:${depth}`);
          if (!visited.has(edge.from)) { visited.add(edge.from); next.push(edge.from); }
        }
      }
    }
    frontier = next;
  }
}

function impactedTests(index: RepositoryIndex, paths: ReadonlySet<string>, candidates: Map<string, Candidate>): void {
  for (const test of index.tests) {
    if (test.targets.some((target) => paths.has(target)) || paths.has(test.path)) addCandidate(candidates, test.path, 65, "impacted-test");
  }
}

function buildRepoMap(index: RepositoryIndex, selectedPaths: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const file of [...selectedPaths].sort()) {
    const symbols = index.symbols.filter((symbol) => symbol.path === file).map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`);
    const imports = index.edges.filter((edge) => edge.from === file && selectedPaths.has(edge.to)).map((edge) => edge.to);
    const callers = index.edges.filter((edge) => edge.to === file && selectedPaths.has(edge.from)).map((edge) => edge.from);
    const route = index.routes.find((item) => item.file === file);
    const db = index.databaseEntities.filter((item) => item.file === file).map((item) => `${item.kind}:${item.name}`);
    lines.push(`${file}${symbols.length ? ` | ${symbols.join(", ")}` : ""}${route ? ` | ${route.kind}:${route.path}[${route.methods.join(",")}]` : ""}${db.length ? ` | ${db.join(", ")}` : ""}${imports.length ? ` | imports:${imports.join(",")}` : ""}${callers.length ? ` | callers:${callers.join(",")}` : ""}`);
  }
  return lines.join("\n");
}

export function selectRepositoryContext(index: RepositoryIndex, query: string, options: ContextSelectionOptions = {}): RepositoryContextPacket {
  const maxTokens = Math.max(1, options.maxTokens ?? 8_000);
  const maxSeedFiles = Math.max(1, options.maxSeedFiles ?? 12);
  const dependencyDepth = Math.max(0, Math.min(6, options.dependencyDepth ?? 2));
  const candidates = new Map<string, Candidate>();
  const seeds = searchRepository(index, query, maxSeedFiles);
  for (const seed of seeds) addCandidate(candidates, seed.path, 100 + seed.score, seed.symbols.length ? `symbol:${seed.symbols.join(",")}` : "query-match");
  expandDependencies(index, candidates, seeds.map((seed) => seed.path), dependencyDepth);
  impactedTests(index, new Set(candidates.keys()), candidates);

  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const items: RepositoryContextItem[] = [];
  let used = 0;
  for (const candidate of ordered) {
    if (used >= maxTokens) break;
    const file = fileByPath.get(candidate.path);
    if (!file) continue;
    const available = maxTokens - used;
    const fullEstimate = estimateTokens(file.content);
    const itemTokens = Math.min(fullEstimate, available);
    if (itemTokens <= 0) break;
    const excerpt = fullEstimate <= available ? file.content : `${file.content.slice(0, Math.max(1, available * 4 - 1))}…`;
    items.push({
      path: candidate.path,
      score: candidate.score,
      reasons: [...candidate.reasons],
      symbols: index.symbols.filter((symbol) => symbol.path === candidate.path).map((symbol) => symbol.name),
      excerpt,
      estimatedTokens: itemTokens
    });
    used += itemTokens;
  }
  const selectedPaths = new Set(items.map((item) => item.path));
  return {
    repositoryId: index.repositoryId,
    revisionHash: index.revisionHash,
    query,
    items,
    repoMap: buildRepoMap(index, selectedPaths),
    estimatedTokens: used,
    compression: planContextCompression(used)
  };
}
