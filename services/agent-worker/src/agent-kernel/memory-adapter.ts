import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelMessage, ModelStreamDeltaHandler } from "@div3rsa/model-sdk";
import { memoryIsEligibleForPlanning, type AgentMemoryRecord } from "./verified-experience";
import type { SupabaseAgentKernelStore } from "./store";

const HISTORY_CACHE_LIMIT = 256;
const DEFAULT_CONTEXT_BUDGET = 16_000;

function isPrimaryExecution(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "system" && message.content.includes("Execution contract:") && message.content.includes("Selected project resources:"));
}

function rootAgentRequestId(requestId: string): string {
  const uuid = requestId.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?::|$)/i)?.[1];
  if (uuid) return uuid;
  const separator = requestId.indexOf(":");
  return separator > 0 ? requestId.slice(0, separator) : requestId;
}

function contextBudgetFromRequest(request: GenerateRequest): number {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const raw = system.match(/context budget:\s*(\d{1,7})/i)?.[1];
  const parsed = raw ? Number(raw) : DEFAULT_CONTEXT_BUDGET;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_BUDGET;
}

function historyCharacterBudget(request: GenerateRequest): number {
  // Reserve most of the model context for the current user turn, system/skills,
  // repository intelligence, tool results and the answer. Roughly 0.8 chars per
  // declared context token corresponds to ~20% of a 4 chars/token context.
  return Math.min(32_000, Math.max(4_000, Math.floor(contextBudgetFromRequest(request) * 0.8)));
}

export function fitConversationHistory(history: readonly ModelMessage[], maxCharacters: number): ModelMessage[] {
  if (!history.length || maxCharacters <= 0) return [];
  const selected: ModelMessage[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const cost = message.content.length + 32;
    if (used + cost > maxCharacters) break;
    selected.push(message);
    used += cost;
  }
  selected.reverse();
  // A leading assistant message without its preceding user turn is ambiguous and
  // can make the model treat an answer as an instruction. Drop it rather than
  // supplying a broken half-turn.
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function injectConversationHistory(request: GenerateRequest, history: readonly ModelMessage[]): GenerateRequest {
  if (!history.length) return request;
  const firstUserIndex = request.messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) return request;
  return {
    ...request,
    messages: [
      ...request.messages.slice(0, firstUserIndex),
      ...history,
      ...request.messages.slice(firstUserIndex)
    ]
  };
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
  private readonly conversationHistoryCache = new Map<string, ModelMessage[]>();

  constructor(
    private readonly base: ModelAdapter,
    private readonly store: SupabaseAgentKernelStore,
    private readonly enabled: boolean,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  private async historyFor(request: GenerateRequest): Promise<ModelMessage[]> {
    const requestId = rootAgentRequestId(request.requestId);
    const cached = this.conversationHistoryCache.get(requestId);
    if (cached) return cached;
    const history = await this.store.conversationHistory(requestId, 60);
    this.conversationHistoryCache.set(requestId, history);
    if (this.conversationHistoryCache.size > HISTORY_CACHE_LIMIT) {
      const oldest = this.conversationHistoryCache.keys().next().value as string | undefined;
      if (oldest) this.conversationHistoryCache.delete(oldest);
    }
    return history;
  }

  private async augment(request: GenerateRequest): Promise<GenerateRequest> {
    if (!isPrimaryExecution(request)) return request;

    const fullHistory = await this.historyFor(request);
    let augmented = injectConversationHistory(request, fitConversationHistory(fullHistory, historyCharacterBudget(request)));

    if (!this.enabled) return augmented;
    const scope = memoryScopeFromRequest(augmented);
    let memories: AgentMemoryRecord[] = [];
    try { memories = await this.store.findMemories(scope, 8); }
    catch (error) {
      this.logger.warn("[agent-kernel-memory] retrieval failed", { scope, error: error instanceof Error ? error.message : "unknown" });
      return augmented;
    }
    const context = memoryContext(memories);
    if (!context) return augmented;
    let injected = false;
    const messages = augmented.messages.map((message) => {
      if (!injected && message.role === "system" && message.content.includes("Execution contract:")) {
        injected = true;
        return { ...message, content: `${message.content}${context}` };
      }
      return message;
    });
    augmented = { ...augmented, messages };
    return augmented;
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