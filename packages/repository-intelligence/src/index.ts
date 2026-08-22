import { createHash } from "node:crypto";
import path from "node:path";

export interface RepositoryFileInput { path: string; content: string }
export interface IndexedFile extends RepositoryFileInput { hash: string; language: string; tokens: string[] }
export interface RepositorySymbol { name: string; kind: "function" | "class" | "interface" | "type" | "variable"; path: string; line: number }
export interface RepositoryIndex { repositoryId: string; revisionHash: string; files: IndexedFile[]; symbols: RepositorySymbol[]; edges: Array<{ from: string; to: string; kind: "imports" }> }

const excluded = /(^|\/)(?:\.git|node_modules|vendor|dist|build|\.next)(\/|$)|(^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i;
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|woff2?)$/i;
const language = (file: string) => ({ ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".sql": "sql", ".md": "markdown" }[path.extname(file)] ?? "text");
const tokens = (text: string) => [...new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])];

function extractSymbols(file: RepositoryFileInput): RepositorySymbol[] {
  const output: RepositorySymbol[] = [];
  const patterns: Array<[RepositorySymbol["kind"], RegExp]> = [
    ["function", /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g],
    ["class", /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g],
    ["interface", /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g],
    ["type", /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g],
    ["variable", /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/g]
  ];
  for (const [kind, regex] of patterns) for (const match of file.content.matchAll(regex)) output.push({ name: match[1]!, kind, path: file.path, line: file.content.slice(0, match.index).split("\n").length });
  return output;
}

function resolveImport(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
}

export function buildRepositoryIndex(repositoryId: string, input: RepositoryFileInput[]): RepositoryIndex {
  if (!repositoryId) throw new Error("repository_id_required");
  const files = input.filter((file) => !excluded.test(file.path) && !binary.test(file.path) && !file.content.includes("\0")).map((file) => ({ ...file, hash: createHash("sha256").update(file.content).digest("hex"), language: language(file.path), tokens: tokens(file.content) })).sort((a, b) => a.path.localeCompare(b.path));
  const symbols = files.flatMap(extractSymbols);
  const edges = files.flatMap((file) => [...file.content.matchAll(/(?:import[^'\"]*from\s*|require\s*\()["']([^"']+)["']/g)].map((match) => ({ from: file.path, to: resolveImport(file.path, match[1]!), kind: "imports" as const })));
  const revisionHash = createHash("sha256").update(files.map((file) => `${file.path}:${file.hash}`).join("\n")).digest("hex");
  return { repositoryId, revisionHash, files, symbols, edges };
}

export function searchRepository(index: RepositoryIndex, query: string, limit = 20): Array<{ path: string; score: number; symbols: string[] }> {
  const terms = tokens(query);
  return index.files.map((file) => {
    const matchingSymbols = index.symbols.filter((symbol) => symbol.path === file.path && terms.includes(symbol.name.toLowerCase())).map((symbol) => symbol.name);
    const contentHits = terms.filter((term) => file.tokens.includes(term)).length;
    return { path: file.path, score: matchingSymbols.length * 10 + contentHits, symbols: matchingSymbols };
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
