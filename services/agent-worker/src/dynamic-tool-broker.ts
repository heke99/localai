import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { isDirectTool, toolPolicy } from "./tool-registry";

const SEARCH_TOOL: ModelToolDefinition = {
  name: "search_tool",
  description: "Discover the smallest set of available tools relevant to a capability or task. Returns tool names, descriptions and input schemas; it does not execute them.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Capability or operation needed, for example database query profiling or GitHub pull request review." },
      limit: { type: "integer", minimum: 1, maximum: 12 }
    },
    required: ["query"],
    additionalProperties: false
  }
};

const USE_TOOL: ModelToolDefinition = {
  name: "use_tool",
  description: "Execute a tool previously returned by search_tool. Write-capable tools must be directly exposed instead and cannot be delegated through this generic entry point.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      arguments: { type: "object", additionalProperties: true }
    },
    required: ["name", "arguments"],
    additionalProperties: false
  }
};

const UNREGISTERED_WRITE_PATTERN = /(?:create|update|delete|write|apply|merge|deploy|rollback|cancel|archive|send|execute_sql|run_sql|mutation)/i;

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_.-]+/g).filter((part) => part.length >= 2);
}

function toolScore(definition: ModelToolDefinition, query: string): number {
  const queryTokens = tokens(query);
  const haystack = `${definition.name} ${definition.description ?? ""}`.toLowerCase();
  let score = definition.name.toLowerCase() === query.trim().toLowerCase() ? 100 : 0;
  for (const token of queryTokens) {
    if (definition.name.toLowerCase().includes(token)) score += 8;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

function isWriteLike(definition: ModelToolDefinition): boolean {
  const policy = toolPolicy(definition.name);
  if (policy) return policy.mutating;
  // Transitional fail-closed fallback until every integration tool is registered.
  return UNREGISTERED_WRITE_PATTERN.test(`${definition.name} ${definition.description ?? ""}`);
}

function immediateTool(definition: ModelToolDefinition, run: ClaimedRun): boolean {
  if (isDirectTool(definition.name, run.mode)) return true;
  const name = definition.name.toLowerCase();
  const value = run.prompt.toLowerCase();
  if (name === "current_time" && /\b(time|date|today|now|clock|tid|datum|idag|nu)\b/i.test(value)) return true;
  if (/github|repository|repo|pull request|commit|branch|kod|code/i.test(value) && /github|repo|repository/i.test(name)) return true;
  if (/database|postgres|supabase|sql|table|databas/i.test(value) && /supabase|postgres|sql|database/i.test(name)) return true;
  if (/vercel|deploy|deployment|domain/i.test(value) && /vercel|deploy|domain/i.test(name)) return true;
  return false;
}

export interface DynamicToolBrokerOptions {
  readonly enabled?: boolean;
  readonly maxImmediateTools?: number;
  readonly maxDiscoveredToolsPerRun?: number;
}

export class DynamicToolBroker implements WorkerToolRuntime {
  private readonly discovered = new Map<string, Set<string>>();
  private readonly enabled: boolean;
  private readonly maxImmediateTools: number;
  private readonly maxDiscoveredToolsPerRun: number;

  constructor(private readonly inner: WorkerToolRuntime, options: DynamicToolBrokerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.maxImmediateTools = Math.max(1, options.maxImmediateTools ?? 8);
    this.maxDiscoveredToolsPerRun = Math.max(1, options.maxDiscoveredToolsPerRun ?? 16);
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = await this.inner.list(run);
    if (!this.enabled || definitions.length <= this.maxImmediateTools) return definitions;

    const immediate = definitions.filter((definition) => immediateTool(definition, run));
    const direct = immediate.filter((definition) => isDirectTool(definition.name, run.mode));
    const optional = immediate.filter((definition) => !isDirectTool(definition.name, run.mode));
    const unique = new Map(
      [...direct, ...optional]
        .slice(0, Math.max(this.maxImmediateTools, direct.length))
        .map((definition) => [definition.name, definition])
    );
    return [SEARCH_TOOL, USE_TOOL, ...unique.values()];
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (!this.enabled || (call.name !== "search_tool" && call.name !== "use_tool")) return this.inner.execute(run, call);

    if (call.name === "search_tool") {
      const query = typeof call.input.query === "string" ? call.input.query.trim() : "";
      if (!query) throw new Error("dynamic_tool_search_query_required");
      const limitRaw = Number(call.input.limit ?? 8);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(12, Math.floor(limitRaw))) : 8;
      const definitions = await this.inner.list(run);
      const matches = definitions
        .map((definition) => ({ definition, score: toolScore(definition, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name))
        .slice(0, limit);
      const state = this.discovered.get(run.runId) ?? new Set<string>();
      for (const match of matches) {
        if (state.size >= this.maxDiscoveredToolsPerRun) break;
        state.add(match.definition.name);
      }
      this.discovered.set(run.runId, state);
      return {
        query,
        tools: matches.map(({ definition }) => ({
          name: definition.name,
          description: definition.description ?? "",
          inputSchema: definition.inputSchema,
          delegatedExecutionAllowed: !isWriteLike(definition) && !isDirectTool(definition.name, run.mode)
        }))
      };
    }

    const requestedName = typeof call.input.name === "string" ? call.input.name.trim() : "";
    const args = call.input.arguments;
    if (!requestedName || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("dynamic_tool_use_invalid_arguments");
    const discovered = this.discovered.get(run.runId);
    if (!discovered?.has(requestedName)) throw new Error(`dynamic_tool_not_discovered:${requestedName}`);
    const definitions = await this.inner.list(run);
    const definition = definitions.find((candidate) => candidate.name === requestedName);
    if (!definition) throw new Error(`dynamic_tool_unavailable:${requestedName}`);
    if (isWriteLike(definition) || isDirectTool(requestedName, run.mode)) {
      throw new Error(`dynamic_tool_write_requires_direct_schema:${requestedName}`);
    }
    return this.inner.execute(run, { id: `${call.id}:delegated`, name: requestedName, input: args as Record<string, unknown> });
  }

  release(runId: string): void {
    this.discovered.delete(runId);
  }

  async beginRun(_run: ClaimedRun): Promise<void> {}

  async endRun(run: ClaimedRun): Promise<void> {
    this.release(run.runId);
  }
}
