import { describe, expect, it, vi } from "vitest";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import type { ClaimedRun } from "./processor";

const run: ClaimedRun = {
  jobId: "job", runId: "run", mode: "code", modelAlias: "code-prod", prompt: "read file", requestId: "request", traceId: "trace",
  resourceContext: [{ resourceId: "repo-1", connectionId: "connection-1", provider: "github", resourceType: "repository", externalResourceId: "heke99/localai", displayName: "localai", capabilities: ["github.contents.read", "github.contents.write"] }]
};

const stableReadOperationId = "cf4d2aa3f5844a790dc12479be043d1cda25365a90e3d6c764393f997f0356ab";

describe("PermissionedIntegrationToolRuntime", () => {
  it("always exposes project-memory tools but no provider tools without executors", async () => {
    const runtime = new PermissionedIntegrationToolRuntime({ rpc: vi.fn() }, new Map());
    expect((await runtime.list(run)).map((tool) => tool.name)).toEqual(["div3rsa_list_project_resources", "div3rsa_remember_resource_link"]);
  });

  it("lists the project directory without granting provider access", async () => {
    const rpc = vi.fn(async () => ({ data: { projectId: "project", resources: [], links: [] }, error: null }));
    const runtime = new PermissionedIntegrationToolRuntime({ rpc }, new Map());
    await expect(runtime.execute(run, { id: "memory-list", name: "div3rsa_list_project_resources", input: {} })).resolves.toEqual({ projectId: "project", resources: [], links: [] });
    expect(rpc).toHaveBeenCalledWith("worker_project_resource_directory", { target_run_id: "run" });
  });

  it("persists a user-grounded resource relationship through the protected worker RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { id: "link" }, error: null }));
    const runtime = new PermissionedIntegrationToolRuntime({ rpc }, new Map());
    await runtime.execute(run, { id: "memory-save", name: "div3rsa_remember_resource_link", input: { resourceOneId: "repo-1", resourceTwoId: "db-1", relation: "same_application", note: "User confirmed these belong together" } });
    expect(rpc).toHaveBeenCalledWith("worker_remember_resource_link", {
      target_run_id: "run",
      target_resource_one_id: "repo-1",
      target_resource_two_id: "db-1",
      target_relation_key: "same_application",
      target_note: "User confirmed these belong together"
    });
  });

  it("issues an idempotent JIT grant for the exact resource, capability and stable operation before execution", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        runId: "run",
        actorId: "user",
        resourceId: "repo-1",
        connectionId: "connection-1",
        provider: "github",
        resourceType: "repository",
        externalResourceId: "heke99/localai",
        displayName: "localai",
        capability: "github.contents.read",
        executionGrantId: "grant-1",
        operationId: stableReadOperationId,
        operationStatus: "queued",
        operationAttempt: 1
      },
      error: null
    }));
    const execute = vi.fn(async () => ({ content: "ok" }));
    const runtime = new PermissionedIntegrationToolRuntime({ rpc }, new Map([["github", { execute }]]));
    const output = await runtime.execute(run, { id: "call-1", name: "github_read_file", input: { resourceId: "repo-1", path: "README.md" } });
    expect(output).toEqual({ content: "ok" });
    expect(rpc).toHaveBeenCalledWith("worker_create_idempotent_tool_execution_grant", {
      target_run_id: "run",
      target_resource_id: "repo-1",
      target_capability: "github.contents.read",
      target_tool_name: "github_read_file",
      target_operation_id: stableReadOperationId,
      target_attempt: 1
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      authorization: { operationId: stableReadOperationId, operationAttempt: 1 },
      context: { operationId: stableReadOperationId, attempt: 1 }
    });
  });

  it("denies a capability that is not present in the run resource context before contacting the provider", async () => {
    const rpc = vi.fn();
    const execute = vi.fn();
    const runtime = new PermissionedIntegrationToolRuntime({ rpc }, new Map([["github", { execute }]]));
    await expect(runtime.execute(run, { id: "call-2", name: "github_merge_pull_request", input: { resourceId: "repo-1", pullNumber: 10 } })).rejects.toThrow("tool_resource_not_selected");
    expect(rpc).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});