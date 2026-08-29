import { describe, expect, it, vi } from "vitest";
import type { ClaimedRun, WorkerToolRuntime } from "../processor";
import type { PreparedRepositoryWorkspace, WorkerRepositoryRuntime } from "../repository-runtime";
import { AgentKernelRewindCoordinator, RewindAwareToolRuntime } from "./rewind-runtime";

const run = {
  jobId: "job", runId: "11111111-1111-4111-8111-111111111111", mode: "code", modelAlias: "code-prod", prompt: "fix", requestId: "req", traceId: "trace",
  resourceContext: [{ resourceId: "repo-1", connectionId: "c", provider: "github", resourceType: "repository", externalResourceId: "1", displayName: "heke99/localai", capabilities: ["github.contents.read", "github.contents.write"], metadata: { defaultBranch: "main" } }]
} as ClaimedRun;

function workspace(hash: string, complete = true): PreparedRepositoryWorkspace {
  return { resourceId: "repo-1", repository: "heke99/localai", ref: "work", revision: "a".repeat(40), complete, workspacePath: "/tmp/x", index: { resourceId: "repo-1", files: [{ path: "src/a.ts", content: "before", hash, language: "typescript", symbols: [], imports: [] }], routes: [], databaseEntities: [], tests: [], edges: [], projectProfile: { languages: [], frameworks: [], database: [], services: [], hosting: [] } } } as unknown as PreparedRepositoryWorkspace;
}

describe("repository rewind tree verification", () => {
  it("fails closed when the restored tree differs from its checkpoint", async () => {
    const prepare = vi.fn().mockResolvedValueOnce(workspace("1".repeat(64))).mockResolvedValueOnce(workspace("2".repeat(64)));
    const repositories = { prepare, release: vi.fn(async () => undefined) } as unknown as WorkerRepositoryRuntime;
    const tools = { list: vi.fn(async () => []), execute: vi.fn(async () => ({ ok: true })) } as unknown as WorkerToolRuntime;
    const coordinator = new AgentKernelRewindCoordinator(repositories, tools);
    const wrapped = new RewindAwareToolRuntime(tools, coordinator, true);
    await wrapped.execute(run, { id: "w", name: "github_write_file", input: { resourceId: "repo-1", branch: "work", path: "src/a.ts", content: "after", message: "change" } });
    await expect(coordinator.rewind(run.runId)).rejects.toThrow("kernel_rewind_repository_tree_mismatch");
  });

  it("refuses rewind-protected mutations when the checkpoint snapshot is incomplete", async () => {
    const repositories = { prepare: vi.fn(async () => workspace("1".repeat(64), false)), release: vi.fn(async () => undefined) } as unknown as WorkerRepositoryRuntime;
    const tools = { list: vi.fn(async () => []), execute: vi.fn(async () => ({ ok: true })) } as unknown as WorkerToolRuntime;
    const wrapped = new RewindAwareToolRuntime(tools, new AgentKernelRewindCoordinator(repositories, tools), true);
    await expect(wrapped.execute(run, { id: "w", name: "github_write_file", input: { resourceId: "repo-1", branch: "work", path: "src/a.ts", content: "after", message: "change" } })).rejects.toThrow("kernel_rewind_requires_complete_repository_snapshot");
    expect(tools.execute).not.toHaveBeenCalled();
  });
});
