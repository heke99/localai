import { decidePolicy, type PolicyInput, type PolicyRule } from "./policy";

export interface ToolDefinition {
  name: string;
  requiredPermission: string;
  risk: "read" | "write" | "destructive";
  inputSchema: { required: string[] };
}

export interface ToolCall {
  requestId: string;
  runId: string;
  tool: string;
  resource: string;
  mode: string;
  input: Record<string, unknown>;
  actor: { permissions: ReadonlySet<string>; assuranceLevel: "aal1" | "aal2" };
}

export interface ToolExecutor { execute(call: ToolCall, credential?: ScopedCredential): Promise<unknown> }
export interface ToolAuditSink { record(event: { requestId: string; runId: string; tool: string; outcome: "allowed" | "denied" | "failed" | "completed"; detail: string }): Promise<void> }
export interface ScopedCredential { token: string; expiresAt: Date; capabilities: ReadonlySet<string>; resource: string }

export class ToolGateway {
  constructor(
    private readonly tools: Map<string, ToolDefinition>,
    private readonly policies: PolicyRule[],
    private readonly executor: ToolExecutor,
    private readonly audit: ToolAuditSink
  ) {}

  async execute(call: ToolCall, credential?: ScopedCredential): Promise<unknown> {
    const definition = this.tools.get(call.tool);
    if (!definition) throw new Error("unknown_tool");
    const missing = definition.inputSchema.required.find((key) => !(key in call.input));
    if (missing) throw new Error(`invalid_tool_input:${missing}`);
    const policyInput: PolicyInput = { action: definition.requiredPermission, resource: call.resource, mode: call.mode, assuranceLevel: call.actor.assuranceLevel, permissions: call.actor.permissions };
    const decision = decidePolicy(policyInput, this.policies);
    if (!decision.allowed) {
      await this.audit.record({ requestId: call.requestId, runId: call.runId, tool: call.tool, outcome: "denied", detail: decision.reason });
      throw new Error(`tool_denied:${decision.reason}`);
    }
    if (definition.risk !== "read") {
      if (!credential || credential.expiresAt.getTime() <= Date.now() || !credential.capabilities.has(definition.requiredPermission) || credential.resource !== call.resource) {
        await this.audit.record({ requestId: call.requestId, runId: call.runId, tool: call.tool, outcome: "denied", detail: "scoped_credential_required" });
        throw new Error("scoped_credential_required");
      }
    }
    try {
      const result = await this.executor.execute(call, credential);
      await this.audit.record({ requestId: call.requestId, runId: call.runId, tool: call.tool, outcome: "completed", detail: "ok" });
      return result;
    } catch (error) {
      await this.audit.record({ requestId: call.requestId, runId: call.runId, tool: call.tool, outcome: "failed", detail: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }
}
