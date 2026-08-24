import type { TaskRisk } from "./task-analyzer";

export type ImpactKind =
  | "file"
  | "symbol"
  | "route"
  | "api"
  | "database"
  | "rpc"
  | "policy"
  | "test"
  | "service"
  | "workflow"
  | "deployment"
  | "configuration";

export type ImpactEdgeKind = "imports" | "calls" | "routes_to" | "queries" | "tests" | "deploys" | "configures" | "depends_on";

export interface ImpactNode {
  id: string;
  kind: ImpactKind;
  label: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface ImpactEdge {
  from: string;
  to: string;
  kind: ImpactEdgeKind;
}

export interface ConsequenceGraph {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

export interface ChangeSet {
  files: string[];
  symbols?: Array<{ path: string; name: string }>;
}

export interface ImpactEvidence {
  nodeId: string;
  distance: number;
  direction: "caller" | "dependency" | "changed";
  via?: ImpactEdgeKind;
}

export interface ImpactAnalysis {
  changed: ImpactNode[];
  direct: ImpactNode[];
  transitive: ImpactNode[];
  affected: ImpactNode[];
  evidence: ImpactEvidence[];
  risk: TaskRisk;
  testNodeIds: string[];
  verificationHints: string[];
}

const uniqueNodes = (nodes: ImpactNode[]) => [...new Map(nodes.map((node) => [node.id, node])).values()];

function classifyRisk(nodes: ImpactNode[]): TaskRisk {
  const kinds = new Set(nodes.map((node) => node.kind));
  if (["database", "policy", "deployment"].some((kind) => kinds.has(kind as ImpactKind))) return "critical";
  if (["api", "route", "rpc", "service", "workflow", "configuration"].some((kind) => kinds.has(kind as ImpactKind)) || nodes.length >= 20) return "high";
  if (nodes.length >= 6) return "medium";
  return "low";
}

function verificationHints(nodes: ImpactNode[]): string[] {
  const kinds = new Set(nodes.map((node) => node.kind));
  const hints = ["diff-review", "typecheck", "targeted-tests"];
  if (["database", "rpc", "policy"].some((kind) => kinds.has(kind as ImpactKind))) hints.push("database-invariants");
  if (["route", "api"].some((kind) => kinds.has(kind as ImpactKind))) hints.push("integration-tests", "browser-e2e");
  if (kinds.has("deployment") || kinds.has("workflow") || kinds.has("configuration")) hints.push("build", "deployment-health");
  if (nodes.some((node) => /(?:^|\/)app\/|(?:^|\/)components?\/|\.tsx$/i.test(node.path ?? ""))) hints.push("multi-viewport-review", "accessibility");
  return [...new Set(hints)];
}

function changedIds(graph: ConsequenceGraph, change: ChangeSet): Set<string> {
  const files = new Set(change.files.map((value) => value.replace(/^\.\//, "")));
  const symbols = new Set((change.symbols ?? []).map((symbol) => `${symbol.path.replace(/^\.\//, "")}#${symbol.name}`));
  return new Set(graph.nodes.filter((node) => {
    const path = node.path?.replace(/^\.\//, "");
    if (path && files.has(path)) return true;
    if (node.kind === "symbol" && path && symbols.has(`${path}#${node.label}`)) return true;
    return false;
  }).map((node) => node.id));
}

export function analyzeConsequences(graph: ConsequenceGraph, change: ChangeSet, maximumDepth = 8): ImpactAnalysis {
  if (!change.files.length && !(change.symbols?.length)) throw new Error("change_set_required");
  if (maximumDepth < 1 || maximumDepth > 32) throw new Error("invalid_consequence_depth");

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const seeds = changedIds(graph, change);
  const evidence = new Map<string, ImpactEvidence>();
  const queue: Array<{ id: string; distance: number }> = [];
  for (const id of seeds) {
    evidence.set(id, { nodeId: id, distance: 0, direction: "changed" });
    queue.push({ id, distance: 0 });
  }

  while (queue.length) {
    const current = queue.shift()!;
    if (current.distance >= maximumDepth) continue;
    for (const edge of graph.edges) {
      let next: string | null = null;
      let direction: ImpactEvidence["direction"] = "dependency";
      if (edge.from === current.id) {
        next = edge.to;
        direction = "dependency";
      } else if (edge.to === current.id) {
        next = edge.from;
        direction = "caller";
      }
      if (!next || !nodeById.has(next)) continue;
      const nextDistance = current.distance + 1;
      const known = evidence.get(next);
      if (known && known.distance <= nextDistance) continue;
      evidence.set(next, { nodeId: next, distance: nextDistance, direction, via: edge.kind });
      queue.push({ id: next, distance: nextDistance });
    }
  }

  const affected = uniqueNodes([...evidence.keys()].map((id) => nodeById.get(id)).filter((node): node is ImpactNode => Boolean(node)));
  const changed = affected.filter((node) => seeds.has(node.id));
  const direct = affected.filter((node) => evidence.get(node.id)?.distance === 1);
  const transitive = affected.filter((node) => (evidence.get(node.id)?.distance ?? 0) > 1);
  const testNodeIds = affected.filter((node) => node.kind === "test" || /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(node.path ?? "")).map((node) => node.id);

  return {
    changed,
    direct,
    transitive,
    affected,
    evidence: [...evidence.values()].sort((a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId)),
    risk: classifyRisk(affected),
    testNodeIds,
    verificationHints: verificationHints(affected)
  };
}

export function buildFileImpactGraph(input: {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  tests?: Array<{ path: string; targets: string[] }>;
}): ConsequenceGraph {
  const nodes: ImpactNode[] = input.files.map((path) => ({ id: `file:${path}`, kind: /(?:^|\/)(?:tests?|e2e)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(path) ? "test" : "file", label: path, path }));
  const known = new Set(input.files);
  const edges: ImpactEdge[] = input.imports.filter((edge) => known.has(edge.from) && known.has(edge.to)).map((edge) => ({ from: `file:${edge.from}`, to: `file:${edge.to}`, kind: "imports" }));
  for (const test of input.tests ?? []) {
    if (!known.has(test.path)) continue;
    for (const target of test.targets) if (known.has(target)) edges.push({ from: `file:${test.path}`, to: `file:${target}`, kind: "tests" });
  }
  return { nodes, edges };
}
