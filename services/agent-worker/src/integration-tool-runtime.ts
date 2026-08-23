import type { ModelToolCall } from "@div3rsa/model-sdk";
import { integrationToolByName, integrationToolsForResources, type IntegrationToolDefinition } from "@div3rsa/integrations";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export interface ToolAuthorization {
  runId: string;
  actorId: string;
  resourceId: string;
  connectionId: string;
  provider: string;
  resourceType: string;
  externalResourceId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
  capability: string;
}

export interface ProviderToolExecutor {
  execute(input: { run: ClaimedRun; authorization: ToolAuthorization; tool: IntegrationToolDefinition; arguments: Record<string, unknown> }): Promise<unknown>;
}

export class PermissionedIntegrationToolRuntime implements WorkerToolRuntime {
  constructor(private readonly client: RpcClient, private readonly executors: ReadonlyMap<string, ProviderToolExecutor>) {}

  async list(run: ClaimedRun) {
    return integrationToolsForResources(run.resourceContext, new Set(this.executors.keys()));
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    const tool = integrationToolByName(call.name);
    if (!tool) throw new Error("unknown_integration_tool");
    const resourceId = typeof call.input.resourceId === "string" ? call.input.resourceId : "";
    if (!resourceId) throw new Error("tool_resource_required");
    const selected = run.resourceContext.find((resource) => resource.resourceId === resourceId && resource.provider === tool.provider && resource.capabilities.includes(tool.capability));
    if (!selected) throw new Error("tool_resource_not_selected");
    const executor = this.executors.get(tool.provider);
    if (!executor) throw new Error("provider_executor_not_configured");

    const { data, error } = await this.client.rpc<ToolAuthorization>("worker_authorize_tool_call", {
      target_run_id: run.runId,
      target_resource_id: resourceId,
      target_capability: tool.capability
    });
    if (error || !data) throw new Error(error?.message ?? "tool_resource_capability_denied");
    if (data.resourceId !== resourceId || data.provider !== tool.provider || data.capability !== tool.capability) throw new Error("tool_authorization_mismatch");
    return executor.execute({ run, authorization: data, tool, arguments: call.input });
  }
}
