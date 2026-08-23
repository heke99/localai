import { describe, expect, it, vi } from "vitest";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import type { ClaimedRun } from "./processor";

const run: ClaimedRun = {
  jobId: "job", runId: "run", mode: "code", modelAlias: "code-prod", prompt: "read file", requestId: "request", traceId: "trace",
  resourceContext: [{ resourceId: "repo-1", connectionId: "connection-1", provider: "github", resourceType: "repository", externalResourceId: "heke99/localai", displayName: "localai", capabilities: ["github.contents.read", "github.contents.write"] }]
};

describe("PermissionedIntegrationToolRuntime", () => {
  it("only exposes tools for providers with an executor", async () => {
    const runtime = new PermissionedIntegrationToolRuntime({ rpc: vi.fn() }, new Map());
    expect(await runtime.list(run)).toEqual([]);
  });

  it("JIT authorizes the exact resource and capability before execution", async () => {
    const rpc = vi.fn(async () => ({ data: { runId: "run", actorId: "user", resourceId: "repo-1", connectionId: "connection-1", provider: "github", resourceType: "repository", externalResourceId: "heke99/localai", displayName: "localai", capability: "github.contents.read" }, error: null }));
    const execute = vi.fn(async () => ({ content: "ok" }));
    const runtime = new PermissionedIntegrationToolRuntime({ rpc }, new Map([["github", { execute }]]));
    const output = await runtime.execute(run, { id: "call-1", name: "github_read_file", input: { resourceId: "repo-1", path: "README.md" } });
    expect(output).toEqual({ content: "ok" });
    expect(rpc).toHaveBeenCalledWith("worker_authorize_tool_call", { target_run_id: "run", target_resource_id: "repo-1", target_capability: "github.contents.read" });
    expect(execute).toHaveBeenCalledOnce();
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
