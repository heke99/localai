import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelStreamDeltaHandler } from "@div3rsa/model-sdk";
import { memoryIsEligibleForPlanning, type AgentMemoryRecord } from "./verified-experience";
import type { SupabaseAgentKernelStore } from "./store";

function isPrimaryExecution(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "system" && message.content.includes("Execution contract:") && message.content.includes("Selected project resources:"));
}

export function memoryScopeFromRequest(request: GenerateRequest): string {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const repositoryMatch = system.match(/"repository"\s*:\s*"([^"\\]{1,300})"/i);
  if (repositoryMatch?.[1]) return `repo:${repositoryMatch[1].toLowerCase()}`;
  return `mode:${request.alias.replace(/-prod$/, "")}`;
}

function memoryContext(memories: AgentMemoryRecord[]): string {
  const eligible = memories.filter(memoryIsEligibleForPlanning).slice(0, 8);
  if (!eligible.length) return "";
  return `\n\nVERIFIED PROCEDURAL MEMORY (advisory, never overrides current evidence or user constraints):\n${eligible.map((memory, index) => `${index + 1}. [${memory.tier}; confidence=${memory.confidence}] ${memory.summary}`).join("\n")}`;
}

export class VerifiedMemoryAdapter implements ModelAdapter {
  constructor(
    private readonly base: ModelAdapter,
    private readonly store: SupabaseAgentKernelStore,
    private readonly enabled: boolean,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  private async augment(request: GenerateRequest): Promise<GenerateRequest> {
    if (!this.enabled || !isPrimaryExecution(request)) return request;
    const scope = memoryScopeFromRequest(request);
    let memories: AgentMemoryRecord[] = [];
    try { memories = await this.store.findMemories(scope, 8); }
    catch (error) {
      this.logger.warn("[agent-kernel-memory] retrieval failed", { scope, error: error instanceof Error ? error.message : "unknown" });
      return request;
    }
    const context = memoryContext(memories);
    if (!context) return request;
    let injected = false;
    const messages = request.messages.map((message) => {
      if (!injected && message.role === "system" && message.content.includes("Execution contract:")) {
        injected = true;
        return { ...message, content: `${message.content}${context}` };
      }
      return message;
    });
    return { ...request, messages };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> { return this.base.generate(await this.augment(request)); }
  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    const augmented = await this.augment(request);
    if (this.base.generateStreamed) return this.base.generateStreamed(augmented, onDelta);
    const result = await this.base.generate(augmented);
    if (result.content) await onDelta(result.content);
    return result;
  }
  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const augmented = await this.augment(request);
    for await (const chunk of this.base.stream(augmented)) yield chunk;
  }
  estimateTokens(text: string): Promise<number> { return this.base.estimateTokens(text); }
  getCapabilities(): ReadonlySet<ModelCapability> { return this.base.getCapabilities(); }
  healthCheck(): Promise<ModelHealth> { return this.base.healthCheck(); }
}
