import { describe, expect, it } from "vitest";
import { buildRepositoryIndex } from "@div3rsa/repository-intelligence";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import { chunk, repositoryGraph } from "./observability";

function workspace(files?: Array<{ path: string; content: string }>): PreparedRepositoryWorkspace {
  return {
    resourceId: "00000000-0000-0000-0000-000000000001",
    repository: "div3rsa/example",
    ref: "agent/test",
    revision: "a".repeat(40),
    complete: true,
    workspacePath: "/tmp/example",
    index: buildRepositoryIndex("repo", files ?? [
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

  it("hash-bounds oversized unicode graph keys while retaining the original path as metadata", () => {
    const longPath = `src/${"å".repeat(700)}.ts`;
    const graph = repositoryGraph(workspace([{ path: longPath, content: "export const value = true" }]));
    const node = graph.nodes.find((item) => item.path === longPath)!;
    expect(Buffer.byteLength(node.node_key, "utf8")).toBeLessThanOrEqual(512);
    expect(node.node_key).toMatch(/#[a-f0-9]{64}$/);
    expect(node.path).toBe(longPath);
  });

  it("bounds persistence batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow("invalid_observability_batch_size");
  });
});
