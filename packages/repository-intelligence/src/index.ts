import { createHash } from "node:crypto";
import path from "node:path";

export interface RepositoryFileInput { path: string; content: string }
export interface IndexedFile extends RepositoryFileInput { hash: string; language: string; tokens: string[] }
export interface RepositorySymbol { name: string; kind: "function" | "class" | "interface" | "type" | "variable"; path: string; line: number }
export interface RepositoryEdge { from: string; to: string; kind: "imports" }
export interface RepositoryRoute { path: string; file: string; kind: "page" | "api"; methods: string[] }
export interface RepositoryDatabaseEntity { name: string; file: string; kind: "table" | "policy" | "function" | "rpc" }
export interface RepositoryTest { path: string; kind: "unit" | "integration" | "e2e"; targets: string[] }
export interface ProjectProfile {
  projectType: "web_application" | "service" | "library" | "unknown";
  frameworks: string[];
  languages: string[];
  database: string[];
  services: string[];
  hosting: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  testing: string[];
  monorepo: boolean;
}
export interface RepositoryIndex {
  repositoryId: string;
  revisionHash: string;
  files: IndexedFile[];
  symbols: RepositorySymbol[];
  edges: RepositoryEdge[];
  routes: RepositoryRoute[];
  databaseEntities: RepositoryDatabaseEntity[];
  tests: RepositoryTest[];
  projectProfile: ProjectProfile;
}

const excluded = /(^|\/)(?:\.git|node_modules|vendor|dist|build|\.next)(\/|$)|(^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i;
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|woff2?)$/i;
const language = (file: string) => ({ ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".sql": "sql", ".md": "markdown", ".json": "json", ".toml": "toml", ".yml": "yaml", ".yaml": "yaml" }[path.extname(file)] ?? "text");
const tokens = (text: string) => [...new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])];
const unique = <T>(values: T[]) => [...new Set(values)];

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

function resolveImport(from: string, specifier: string, knownFiles: ReadonlySet<string>): string {
  if (!specifier.startsWith(".")) return specifier;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? base;
}

function nextRoute(file: IndexedFile): RepositoryRoute | null {
  const appMatch = file.path.match(/(?:^|\/)app\/(.+)\/(page|route)\.[cm]?[jt]sx?$/);
  const rootMatch = file.path.match(/(?:^|\/)app\/(page|route)\.[cm]?[jt]sx?$/);
  const match = appMatch ?? rootMatch;
  if (!match) return null;
  const routePart = appMatch ? appMatch[1]! : "";
  const leaf = appMatch ? appMatch[2]! : rootMatch![1]!;
  const normalized = `/${routePart.split("/").filter((segment) => !/^\(.+\)$/.test(segment)).join("/")}`.replace(/\/+/g, "/");
  const methods = leaf === "route" ? unique([...file.content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((match) => match[1]!)) : ["GET"];
  return { path: normalized === "" ? "/" : normalized, file: file.path, kind: leaf === "route" ? "api" : "page", methods };
}

function databaseEntities(file: IndexedFile): RepositoryDatabaseEntity[] {
  if (file.language !== "sql") return [];
  const output: RepositoryDatabaseEntity[] = [];
  for (const match of file.content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z_][\w$]*\.)?([a-z_][\w$]*)/gi)) output.push({ name: match[1]!, file: file.path, kind: "table" });
  for (const match of file.content.matchAll(/create\s+policy\s+"?([^"\n]+?)"?\s+on\s+/gi)) output.push({ name: match[1]!.trim(), file: file.path, kind: "policy" });
  for (const match of file.content.matchAll(/create(?:\s+or\s+replace)?\s+function\s+(?:[a-z_][\w$]*\.)?([a-z_][\w$]*)/gi)) {
    const name = match[1]!;
    output.push({ name, file: file.path, kind: /rpc|api|worker|superadmin/i.test(name) ? "rpc" : "function" });
  }
  return output;
}

function testKind(file: string): RepositoryTest["kind"] | null {
  if (/(?:^|\/)e2e\/|playwright/i.test(file)) return "e2e";
  if (/(?:^|\/)integration\/|\.integration\.[cm]?[jt]sx?$/i.test(file)) return "integration";
  if (/(?:^|\/)(?:__tests__|tests?)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)) return "unit";
  return null;
}

function inferProjectProfile(files: IndexedFile[]): ProjectProfile {
  const names = new Set(files.map((file) => file.path));
  const packageFiles = files.filter((file) => /(^|\/)package\.json$/.test(file.path));
  const packageText = packageFiles.map((file) => file.content).join("\n");
  const frameworks = unique([
    ...( /\"next\"\s*:/.test(packageText) ? ["nextjs"] : []),
    ...( /\"react\"\s*:/.test(packageText) ? ["react"] : []),
    ...( /\"@nestjs\//.test(packageText) ? ["nestjs"] : []),
    ...( /\"express\"\s*:/.test(packageText) ? ["express"] : []),
    ...(files.some((file) => /(^|\/)pyproject\.toml$/.test(file.path) && /fastapi/i.test(file.content)) ? ["fastapi"] : [])
  ]);
  const services = unique([
    ...(files.some((file) => /supabase/i.test(file.path) || /@supabase\//i.test(file.content)) ? ["supabase"] : []),
    ...(files.some((file) => /stripe/i.test(file.path) || /\"stripe\"\s*:/i.test(file.content)) ? ["stripe"] : [])
  ]);
  const hosting = unique([
    ...(names.has("vercel.json") || files.some((file) => /\.vercel\//.test(file.path)) ? ["vercel"] : []),
    ...(names.has("Dockerfile") || files.some((file) => /(^|\/)Dockerfile$/.test(file.path)) ? ["docker"] : []),
    ...(files.some((file) => /(^|\/)k8s\/|kubernetes/i.test(file.path)) ? ["kubernetes"] : [])
  ]);
  const testing = unique([
    ...(/\"vitest\"\s*:/.test(packageText) ? ["vitest"] : []),
    ...(/\"jest\"\s*:/.test(packageText) ? ["jest"] : []),
    ...(/\"@playwright\/test\"\s*:/.test(packageText) ? ["playwright"] : []),
    ...(files.some((file) => /pytest/i.test(file.content)) ? ["pytest"] : [])
  ]);
  const packageManager: ProjectProfile["packageManager"] = names.has("pnpm-lock.yaml") ? "pnpm" : names.has("yarn.lock") ? "yarn" : names.has("bun.lockb") || names.has("bun.lock") ? "bun" : names.has("package-lock.json") ? "npm" : "unknown";
  const monorepo = packageFiles.length > 1 || files.some((file) => /(^|\/)pnpm-workspace\.yaml$|(^|\/)turbo\.json$/.test(file.path)) || packageFiles.some((file) => /\"workspaces\"\s*:/.test(file.content));
  const projectType: ProjectProfile["projectType"] = frameworks.includes("nextjs") || frameworks.includes("react") ? "web_application" : packageFiles.length || files.some((file) => ["python", "go", "rust"].includes(file.language)) ? "service" : files.some((file) => /(^|\/)src\//.test(file.path)) ? "library" : "unknown";
  return { projectType, frameworks, languages: unique(files.map((file) => file.language).filter((item) => item !== "text" && item !== "json" && item !== "markdown")), database: services.includes("supabase") || files.some((file) => file.language === "sql") ? ["postgres"] : [], services, hosting, packageManager, testing, monorepo };
}

export function buildRepositoryIndex(repositoryId: string, input: RepositoryFileInput[]): RepositoryIndex {
  if (!repositoryId) throw new Error("repository_id_required");
  const files = input.filter((file) => !excluded.test(file.path) && !binary.test(file.path) && !file.content.includes("\0")).map((file) => ({ ...file, path: file.path.replace(/^\.\//, ""), hash: createHash("sha256").update(file.content).digest("hex"), language: language(file.path), tokens: tokens(file.content) })).sort((a, b) => a.path.localeCompare(b.path));
  const knownFiles = new Set(files.map((file) => file.path));
  const symbols = files.flatMap(extractSymbols);
  const edges = files.flatMap((file) => [...file.content.matchAll(/(?:import[^'\"]*from\s*|require\s*\()["']([^"']+)["']/g)].map((match) => ({ from: file.path, to: resolveImport(file.path, match[1]!, knownFiles), kind: "imports" as const })));
  const routes = files.map(nextRoute).filter((route): route is RepositoryRoute => Boolean(route));
  const entities = files.flatMap(databaseEntities);
  const tests = files.flatMap((file): RepositoryTest[] => {
    const kind = testKind(file.path);
    if (!kind) return [];
    return [{ path: file.path, kind, targets: edges.filter((edge) => edge.from === file.path && knownFiles.has(edge.to)).map((edge) => edge.to) }];
  });
  const revisionHash = createHash("sha256").update(files.map((file) => `${file.path}:${file.hash}`).join("\n")).digest("hex");
  return { repositoryId, revisionHash, files, symbols, edges, routes, databaseEntities: entities, tests, projectProfile: inferProjectProfile(files) };
}

export function updateRepositoryIndex(index: RepositoryIndex, changed: RepositoryFileInput[], deletedPaths: string[] = []): RepositoryIndex {
  const next = new Map(index.files.map((file) => [file.path, { path: file.path, content: file.content }]));
  for (const deleted of deletedPaths) next.delete(deleted.replace(/^\.\//, ""));
  for (const file of changed) next.set(file.path.replace(/^\.\//, ""), { path: file.path.replace(/^\.\//, ""), content: file.content });
  return buildRepositoryIndex(index.repositoryId, [...next.values()]);
}

export function searchRepository(index: RepositoryIndex, query: string, limit = 20): Array<{ path: string; score: number; symbols: string[] }> {
  const terms = tokens(query);
  return index.files.map((file) => {
    const matchingSymbols = index.symbols.filter((symbol) => symbol.path === file.path && terms.includes(symbol.name.toLowerCase())).map((symbol) => symbol.name);
    const contentHits = terms.filter((term) => file.tokens.includes(term)).length;
    const structuralBoost = index.routes.some((route) => route.file === file.path && terms.some((term) => route.path.toLowerCase().includes(term))) ? 8 : index.databaseEntities.some((entity) => entity.file === file.path && terms.includes(entity.name.toLowerCase())) ? 8 : 0;
    return { path: file.path, score: matchingSymbols.length * 10 + contentHits + structuralBoost, symbols: matchingSymbols };
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

export function consequenceGraphInput(index: RepositoryIndex) {
  return {
    files: index.files.map((file) => file.path),
    imports: index.edges.filter((edge) => index.files.some((file) => file.path === edge.to)).map((edge) => ({ from: edge.from, to: edge.to })),
    tests: index.tests.map((test) => ({ path: test.path, targets: test.targets }))
  };
}
