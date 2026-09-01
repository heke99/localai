import type { ModelToolCall, ModelMessage, ModelToolDefinition } from "@div3rsa/model-sdk";

export type ToolRisk = "read" | "write" | "destructive" | "sensitive";

export interface RuntimeToolDefinition extends ModelToolDefinition {
  risk: ToolRisk;
  requiredPermissions: string[];
}

export interface ToolExecutionContext {
  runId: string;
  actorId: string;
  organizationId: string;
  workspaceId: string;
  permissions: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  output: unknown;
  artifactRefs?: string[];
}

export interface RuntimeTool {
  definition: RuntimeToolDefinition;
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  constructor(tools: readonly RuntimeTool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.definition.name)) throw new Error(`duplicate_tool:${tool.definition.name}`);
      this.tools.set(tool.definition.name, tool);
    }
  }

  definitions(): ModelToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema
    }));
  }

  async execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error(`unknown_tool:${call.name}`);
    for (const permission of tool.definition.requiredPermissions) {
      if (!context.permissions.has(permission)) throw new Error(`tool_permission_denied:${call.name}:${permission}`);
    }
    if (context.signal?.aborted) throw new Error("run_cancelled");
    return tool.execute(call, context);
  }
}

export function toolResultMessage(call: ModelToolCall, result: ToolExecutionResult): ModelMessage {
  return {
    role: "tool",
    name: call.name,
    toolCallId: call.id,
    content: JSON.stringify(result.output)
  };
}
