import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "@div3rsa/model-sdk";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "../processor";
import type { PreparedRepositoryWorkspace, WorkerRepositoryRuntime } from "../repository-runtime";
import { AgentKernelRewindCoordinator, RewindAwareAgentQueue, RewindAwareToolRuntime } from "./rewind-runtime";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  modelAlias: "code-prod",
  prompt: "Fix the regression",
  requestId: "req-1",
  traceId: "trace-1",
  resourceContext: [{ resourceId: "repo-1", connectionId: "conn-1", provider: "github", resourceType: "repository", externalResourceId: "1", displayName: "heke99/localai", capabilities: ["github.contents.read", "github.contents.write"], metadata: { defaultBranch: "main" } }]
};

function workspace(content = "before") : PreparedRepositoryWorkspace {
  return {
    resourceId: "repo-1",
    repository: "heke99/localai",
    ref: "work",
    revision: "a".repeat(40),
    complete: true,
    workspacePath: "/tmp/repo",
    index: {
      resourceId: "repo-1",
      files: [{ path: "src/a.ts", content, hash: "b".repeat(64), language: "typescript", symbols: [], imports: [] }],
      routes: [], databaseEntities: [], tests: [], edges: [], projectProfile: { languages: ["typescript"], frameworks: [], database: [], services: [], hosting: [] }
    }
  } as unknown as PreparedRepositoryWorkspace;
}

function repositories() {
  return {
    prepare: vi.fn(async () => workspace()),
    release: vi.fn(async () => undefined)
  } as unknown as WorkerRepositoryRuntime;
}

function tools() {
  const execute = vi.fn(async (_run: ClaimedRun, call: ModelToolCall) => {
    if (call.name === "vercel_read_deployments") return [{ uid: "dep-green" }];
    return { ok: true };
  });
  return { list: vi.fn(async () => []), execute } as unknown as WorkerToolRuntime;
}

function queue() {
  const base = {
    claim: vi.fn(async () => null), step: vi.fn(async () => undefined), stream: vi.fn(async () => undefined),
    recordRunIntelligence: vi.fn(async () => undefined), recordRepositoryIndex: vi.fn(async () => "idx"), recordImpactAnalysis: vi.fn(async () => "impact"), recordVerificationRun: vi.fn(async () => "verification"),
    complete: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), isCancelled: vi.fn(async () => false)
  };
  return base as unknown as AgentQueue;
}

describe("AgentKernelRewindCoordinator", () => {
  it("restores an existing GitHub file to its exact pre-mutation content after verification failure", async () => {
    const repo = repositories();
    const baseTools = tools();
    const coordinator = new AgentKernelRewindCoordinator(repo, baseTools);
    const wrappedTools = new RewindAwareToolRuntime(baseTools, coordinator, true);

    await wrappedTools.execute(run, { id: "write-1", name: "github_write_file", input: { resourceId: "repo-1", path: "src/a.ts", branch: "work", content: "after", message: "change" } });
    await expect(coordinator.rewind(run.runId)).resolves.toBe(true);

    const calls = (baseTools.execute as ReturnType<typeof vi.fn>).mock.calls.map((entry) => entry[1] as ModelToolCall);
    expect(calls[0]?.input.content).toBe("after");
    expect(calls[1]).toMatchObject({ name: "github_write_file", input: { resourceId: "repo-1", path: "src/a.ts", branch: "work", content: "before" } });
    expect(repo.prepare).toHaveBeenCalledWith(run, "work");
  });

  it("captures and restores the previous Vercel deployment", async () => {
    const baseTools = tools();
    const coordinator = new AgentKernelRewindCoordinator(repositories(), baseTools);
    const wrappedTools = new RewindAwareToolRuntime(baseTools, coordinator, true);

    await wrappedTools.execute(run, { id: "deploy-1", name: "vercel_create_deployment", input: { resourceId: "vercel-1", ref: "work" } });
    await expect(coordinator.rewind(run.runId)).resolves.toBe(true);

    const calls = (baseTools.execute as ReturnType<typeof vi.fn>).mock.calls.map((entry) => entry[1] as ModelToolCall);
    expect(calls.map((call) => call.name)).toEqual(["vercel_read_deployments", "vercel_create_deployment", "vercel_rollback_deployment"]);
    expect(calls[2]?.input).toEqual({ resourceId: "vercel-1", deploymentId: "dep-green" });
  });

  it("fails closed before an unsupported destructive mutation", async () => {
    const baseTools = tools();
    const coordinator = new AgentKernelRewindCoordinator(repositories(), baseTools);
    const wrappedTools = new RewindAwareToolRuntime(baseTools, coordinator, true);
    await expect(wrappedTools.execute(run, { id: "db-1", name: "supabase_apply_migration", input: { resourceId: "db-1", name: "unsafe", sql: "drop table x" } })).rejects.toThrow("kernel_rewind_unsupported_mutation:supabase_apply_migration");
    expect(baseTools.execute).not.toHaveBeenCalled();
  });

  it("rewinds before the verification retry is exposed to the agent", async () => {
    const baseTools = tools();
    const coordinator = new AgentKernelRewindCoordinator(repositories(), baseTools);
    const wrappedTools = new RewindAwareToolRuntime(baseTools, coordinator, true);
    await wrappedTools.execute(run, { id: "write-2", name: "github_write_file", input: { resourceId: "repo-1", path: "src/a.ts", branch: "work", content: "bad", message: "bad" } });

    const baseQueue = queue();
    const wrappedQueue = new RewindAwareAgentQueue(baseQueue, coordinator, true);
    await wrappedQueue.step(run.runId, "verify", "verifying", "Verification failed; return blockers to agent", { blockers: ["tests"] });

    expect(baseQueue.step).toHaveBeenCalledWith(run.runId, "verify", "verifying", "Verification failed; return blockers to agent", expect.objectContaining({ rewindAttempted: true, rewound: true }));
    const calls = (baseTools.execute as ReturnType<typeof vi.fn>).mock.calls.map((entry) => entry[1] as ModelToolCall);
    expect(calls.at(-1)?.input.content).toBe("before");
  });
});
