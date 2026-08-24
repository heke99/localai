import { describe, expect, it } from "vitest";
import { buildRepositoryIndex } from "@div3rsa/repository-intelligence";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import { chunk, repositoryGraph } from "./observability";

function workspace(): PreparedRepositoryWorkspace {
  return {
    resourceId: "00000000-0000-0000-0000-000000000001",
    repository: "div3rsa/example",
    ref: "agent/test",
    revision: "a".repeat(40),
    complete: true,
    workspacePath: "/tmp/example",
    index: buildRepositoryIndex("repo", [
      { path: "src/auth.ts", content: "export const secretName = 'not-persisted'; export function auth() { return true }" },
      { path: "app/api/login/route.ts", content: "import { auth } from '../../../src/auth'; export async function POST() { return auth() }" },
      { path: "tests/login.test.ts", content: "import '../app/api/login/route'; test('login', () => {})" }
    ])
  };
}

describe("agent observability serialization", () => {
  it("persists graph metadata without source content", () => {
    const graph = repositoryGraph(workspace());
    expect(graph.nodes.some((node) => node.node_key === "file:src/auth.ts")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "imports" && edge.from_key === "file:app/api/login/route.ts" && edge.to_key === "file:src/auth.ts")).toBe(true);
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("not-persisted");
    expect(serialized).not.toContain("export function auth");
    expect(serialized).toContain("sha256");
  });

  it("bounds persistence batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow("invalid_observability_batch_size");
  });
});
