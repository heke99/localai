import type { ImpactAnalysis, VerificationPlan, VerificationReport } from "@div3rsa/agent-runtime";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";

export interface RepositoryGraphNode {
  node_key: string;
  kind: "file" | "symbol" | "route" | "database" | "test";
  path: string | null;
  label: string;
  metadata: Record<string, unknown>;
}

export interface RepositoryGraphEdge {
  from_key: string;
  to_key: string;
  kind: "imports" | "contains" | "routes_to" | "queries" | "tests" | "depends_on";
  metadata: Record<string, unknown>;
}

export function repositoryGraph(workspace: PreparedRepositoryWorkspace): { nodes: RepositoryGraphNode[]; edges: RepositoryGraphEdge[] } {
  const index = workspace.index;
  const testPaths = new Set(index.tests.map((test) => test.path));
  const knownFiles = new Set(index.files.map((file) => file.path));
  const nodes: RepositoryGraphNode[] = index.files.map((file) => ({
    node_key: `file:${file.path}`,
    kind: testPaths.has(file.path) ? "test" : "file",
    path: file.path,
    label: file.path,
    metadata: { sha256: file.hash, language: file.language, tokenCount: file.tokens.length }
  }));
  const edges: RepositoryGraphEdge[] = index.edges
    .filter((edge) => knownFiles.has(edge.from) && knownFiles.has(edge.to))
    .map((edge) => ({ from_key: `file:${edge.from}`, to_key: `file:${edge.to}`, kind: "imports", metadata: {} }));

  for (const symbol of index.symbols) {
    const key = `symbol:${symbol.path}#${symbol.name}@${symbol.line}`;
    nodes.push({ node_key: key, kind: "symbol", path: symbol.path, label: symbol.name, metadata: { symbolKind: symbol.kind, line: symbol.line } });
    edges.push({ from_key: key, to_key: `file:${symbol.path}`, kind: "contains", metadata: {} });
  }
  for (const route of index.routes) {
    const key = `route:${route.kind}:${route.path}@${route.file}`;
    nodes.push({ node_key: key, kind: "route", path: route.file, label: route.path, metadata: { routeKind: route.kind, methods: route.methods } });
    edges.push({ from_key: key, to_key: `file:${route.file}`, kind: "routes_to", metadata: {} });
  }
  for (const entity of index.databaseEntities) {
    const key = `database:${entity.kind}:${entity.name}@${entity.file}`;
    nodes.push({ node_key: key, kind: "database", path: entity.file, label: entity.name, metadata: { databaseKind: entity.kind } });
    edges.push({ from_key: key, to_key: `file:${entity.file}`, kind: "depends_on", metadata: {} });
  }
  for (const test of index.tests) for (const target of test.targets) if (knownFiles.has(target)) {
    edges.push({ from_key: `file:${test.path}`, to_key: `file:${target}`, kind: "tests", metadata: { testKind: test.kind } });
  }

  return {
    nodes: [...new Map(nodes.map((node) => [node.node_key, node])).values()],
    edges: [...new Map(edges.map((edge) => [`${edge.from_key}|${edge.kind}|${edge.to_key}`, edge])).values()]
  };
}

export function chunk<T>(values: readonly T[], size = 250): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error("invalid_observability_batch_size");
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

export function impactNodePayload(impact: ImpactAnalysis) {
  const evidence = new Map(impact.evidence.map((item) => [item.nodeId, item]));
  return impact.affected.map((node) => {
    const item = evidence.get(node.id);
    return {
      node_key: node.id,
      kind: node.kind,
      path: node.path ?? null,
      distance: item?.distance ?? 0,
      direction: item?.direction === "caller" ? "reverse" : item?.direction === "dependency" ? "forward" : "changed",
      via: item?.via ?? null
    };
  });
}

export function verificationResultPayload(plan: VerificationPlan, report: VerificationReport) {
  const required = new Map(plan.checks.map((check) => [check.kind, check.required]));
  return report.results.map((result) => ({
    check_kind: result.kind,
    required: required.get(result.kind) ?? false,
    status: result.status,
    summary: result.summary,
    evidence: result.evidence ?? [],
    duration_ms: result.durationMs ?? null
  }));
}
