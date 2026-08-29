import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { DynamicToolBroker } from "./dynamic-tool-broker";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "run-1",
  mode: "chat",
  modelAlias: "general-prod",
  prompt: "Profile this database query and explain why it is slow",
  requestId: "req-1",
  traceId: "trace-1",
  resourceContext: []
};

const definitions: ModelToolDefinition[] = [
  { name: "postgres_explain", description: "Explain a PostgreSQL query plan", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "database_stats", description: "Read database runtime statistics", inputSchema: { type: "object", properties: {} } },
  { name: "github_create_pull_request", description: "Create a pull request", inputSchema: { type: "object", properties: {} } },
  { name: "web_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "web_fetch", description: "Fetch a web page", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "current_time", description: "Read current time", inputSchema: { type: "object", properties: {} } },
  { name: "vercel_deployments", description: "Read deployments", inputSchema: { type: "object", properties: {} } },
  { name: "github_repository", description: "Read repository metadata", inputSchema: { type: "object", properties: {} } },
  { name: "supabase_tables", description: "List Supabase tables", inputSchema: { type: "object", properties: {} } }
];

function runtime() {
  const execute = vi.fn(async (_run: ClaimedRun, call: ModelToolCall) => ({ delegated: call.name, input: call.input }));
  const inner: WorkerToolRuntime = { list: async () => definitions, execute };
  return { broker: new DynamicToolBroker(inner, { enabled: true, maxImmediateTools: 2 }), execute };
}

describe("DynamicToolBroker", () => {
  it("exposes a bounded bootstrap surface instead of every schema", async () => {
    const { broker } = runtime();
    const listed = await broker.list(run);
    expect(listed.map((tool) => tool.name)).toContain("search_tool");
    expect(listed.map((tool) => tool.name)).toContain("use_tool");
    expect(listed.length).toBeLessThan(definitions.length);
  });

  it("discovers and delegates only a previously discovered read tool", async () => {
    const { broker, execute } = runtime();
    const search = await broker.execute(run, { id: "1", name: "search_tool", input: { query: "postgres query explain", limit: 4 } }) as { tools: Array<{ name: string }> };
    expect(search.tools.map((tool) => tool.name)).toContain("postgres_explain");
    await broker.execute(run, { id: "2", name: "use_tool", input: { name: "postgres_explain", arguments: { sql: "select 1" } } });
    expect(execute).toHaveBeenCalledWith(run, expect.objectContaining({ name: "postgres_explain", input: { sql: "select 1" } }));
  });

  it("fails closed for undiscovered or write-like delegated tools", async () => {
    const { broker } = runtime();
    await expect(broker.execute(run, { id: "1", name: "use_tool", input: { name: "database_stats", arguments: {} } })).rejects.toThrow("dynamic_tool_not_discovered");
    await broker.execute(run, { id: "2", name: "search_tool", input: { query: "create pull request", limit: 4 } });
    await expect(broker.execute(run, { id: "3", name: "use_tool", input: { name: "github_create_pull_request", arguments: {} } })).rejects.toThrow("dynamic_tool_write_requires_direct_schema");
  });
});
