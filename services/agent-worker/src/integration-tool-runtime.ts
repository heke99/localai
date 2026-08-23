import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { integrationToolByName, integrationToolsForResources, type IntegrationToolDefinition } from "@div3rsa/integrations";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown | null; error: { message: string } | null }> };

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
  executionGrantId: string;
}

export interface ProviderToolExecutor {
  execute(input: { run: ClaimedRun; authorization: ToolAuthorization; tool: IntegrationToolDefinition; arguments: Record<string, unknown> }): Promise<unknown>;
}

const LIST_PROJECT_RESOURCES = "div3rsa_list_project_resources";
const REMEMBER_RESOURCE_LINK = "div3rsa_remember_resource_link";

const projectMemoryTools: ModelToolDefinition[] = [
  {
    name: LIST_PROJECT_RESOURCES,
    description: "List the resources and remembered relationships in the current DIV3RSA project. Use this when the user refers to a repo, database, deployment, service or other plugin resource that is not already obvious from the selected context.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: REMEMBER_RESOURCE_LINK,
    description: "Permanently remember that two resources in the current project belong together. Use only when the user explicitly states or confirms the relationship. This never grants permissions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceOneId", "resourceTwoId"],
      properties: {
        resourceOneId: { type: "string", description: "First resource id returned by the project resource directory." },
        resourceTwoId: { type: "string", description: "Second resource id returned by the project resource directory." },
        relation: { type: "string", description: "Stable relation key, normally same_application.", default: "same_application" },
        note: { type: "string", description: "Short user-grounded explanation of the relationship." }
      }
    }
  }
];

function isToolAuthorization(value: unknown): value is ToolAuthorization {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.runId === "string"
    && typeof item.actorId === "string"
    && typeof item.resourceId === "string"
    && typeof item.connectionId === "string"
    && typeof item.provider === "string"
    && typeof item.resourceType === "string"
    && typeof item.externalResourceId === "string"
    && typeof item.displayName === "string"
    && typeof item.capability === "string"
    && typeof item.executionGrantId === "string";
}

export class PermissionedIntegrationToolRuntime implements WorkerToolRuntime {
  constructor(private readonly client: RpcClient, private readonly executors: ReadonlyMap<string, ProviderToolExecutor>) {}

  async list(run: ClaimedRun) {
    const providerTools = integrationToolsForResources(run.resourceContext, new Set(this.executors.keys()));
    return [...projectMemoryTools, ...providerTools];
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (call.name === LIST_PROJECT_RESOURCES) {
      const { data, error } = await this.client.rpc("worker_project_resource_directory", { target_run_id: run.runId });
      if (error || !data) throw new Error(error?.message ?? "project_resource_directory_failed");
      return data;
    }

    if (call.name === REMEMBER_RESOURCE_LINK) {
      const one = typeof call.input.resourceOneId === "string" ? call.input.resourceOneId : "";
      const two = typeof call.input.resourceTwoId === "string" ? call.input.resourceTwoId : "";
      const relation = typeof call.input.relation === "string" && call.input.relation.trim() ? call.input.relation.trim() : "same_application";
      const note = typeof call.input.note === "string" ? call.input.note.trim().slice(0, 2000) : null;
      if (!one || !two || one === two) throw new Error("resource_link_requires_two_resources");
      const { data, error } = await this.client.rpc("worker_remember_resource_link", {
        target_run_id: run.runId,
        target_resource_one_id: one,
        target_resource_two_id: two,
        target_relation_key: relation,
        target_note: note
      });
      if (error || !data) throw new Error(error?.message ?? "resource_link_memory_failed");
      return data;
    }

    const tool = integrationToolByName(call.name);
    if (!tool) throw new Error("unknown_integration_tool");
    const resourceId = typeof call.input.resourceId === "string" ? call.input.resourceId : "";
    if (!resourceId) throw new Error("tool_resource_required");
    const selected = run.resourceContext.find((resource) => resource.resourceId === resourceId && resource.provider === tool.provider && resource.capabilities.includes(tool.capability));
    if (!selected) throw new Error("tool_resource_not_selected");
    const executor = this.executors.get(tool.provider);
    if (!executor) throw new Error("provider_executor_not_configured");

    const { data, error } = await this.client.rpc("worker_create_tool_execution_grant", {
      target_run_id: run.runId,
      target_resource_id: resourceId,
      target_capability: tool.capability,
      target_tool_name: tool.name
    });
    if (error || !isToolAuthorization(data)) throw new Error(error?.message ?? "tool_resource_capability_denied");
    if (data.resourceId !== resourceId || data.provider !== tool.provider || data.capability !== tool.capability) throw new Error("tool_authorization_mismatch");
    return executor.execute({ run, authorization: data, tool, arguments: call.input });
  }
}