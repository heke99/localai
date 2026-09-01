import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelMessage,
  ModelStreamDeltaHandler,
  ModelToolCall,
  ModelToolDefinition
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";

type Fetch = typeof fetch;
type OpenAiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenAiMessage = { content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiResponse = {
  choices?: Array<{ message?: OpenAiMessage; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

type ToolChoice = "auto" | { type: "function"; function: { name: string } };

export interface GenericOpenAiCompatibleProfile {
  runtimeModel: string;
  modelVersionId: string;
  capabilities: readonly ModelCapability[];
  requestTimeoutMs?: number;
}

function encodeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) }
      }))
    };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.name };
  }
  return { role: message.role, content: message.content };
}

function parseToolCalls(message: OpenAiMessage): ModelToolCall[] {
  return (message.tool_calls ?? []).map((call, index) => {
    const name = call.function?.name?.trim();
    if (!name) throw new Error("Inference returned tool call without name");
    let input: Record<string, unknown> = {};
    const raw = call.function?.arguments?.trim();
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Inference returned invalid tool arguments");
      input = parsed as Record<string, unknown>;
    }
    return { id: call.id || `tool-call-${index}`, name, input };
  });
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function systemInstructions(request: GenerateRequest): string {
  return request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

function isDirectClockRequest(text: string): boolean {
  return /\b(?:klockan|vad\s+är\s+tiden|vilken\s+tid|aktuella\s+tiden|datum\s+och\s+tid|dagens\s+datum|vilket\s+datum|current\s+(?:date(?:\s+(?:and|&)\s+time)?|time(?:\s+(?:and|&)\s+date)?)|date\s+(?:and|&)\s+time|what\s+(?:time|date)|time\s+is\s+it|today'?s\s+date)\b/i.test(text);
}

function toolResultCount(request: GenerateRequest, name: string): number {
  return request.messages.filter((message) => message.role === "tool" && message.name === name).length;
}

function hasTool(request: GenerateRequest, name: string): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === name));
}

function forcedToolName(request: GenerateRequest): string | null {
  const explicitRequired = request.requiredToolName?.trim();
  if (explicitRequired) {
    if (!hasTool(request, explicitRequired)) throw new Error(`required_tool_definition_missing:${explicitRequired}`);
    return explicitRequired;
  }
  if (!request.tools?.length) return null;
  const system = systemInstructions(request);
  const currentRequired = system.includes("CURRENT INFORMATION REQUIRED") || system.includes("LIVE INFORMATION REQUIRED");
  if (!currentRequired) return null;
  if (system.includes("LIVE INFORMATION REQUIRED") && isDirectClockRequest(latestUserContent(request)) && hasTool(request, "current_time")) {
    return toolResultCount(request, "current_time") === 0 ? "current_time" : null;
  }
  if (hasTool(request, "web_search") && hasTool(request, "web_fetch")) {
    if (toolResultCount(request, "web_search") === 0) return "web_search";
    const corroborationRequired = /Research depth:\s*deep\b/i.test(system) || /Task risk:\s*(?:high|critical)\b/i.test(system);
    const requiredFetches = corroborationRequired ? 2 : 1;
    if (toolResultCount(request, "web_fetch") < requiredFetches) return "web_fetch";
  }
  return null;
}

function toolChoice(request: GenerateRequest): ToolChoice | undefined {
  const forced = forcedToolName(request);
  if (!request.tools?.length) return undefined;
  return forced ? { type: "function", function: { name: forced } } : "auto";
}

function validateRequiredToolCall(request: GenerateRequest, toolCalls: ModelToolCall[]): void {
  const required = request.requiredToolName?.trim();
  if (!required) return;
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== required) throw new Error(`required_tool_call_mismatch:${required}`);
}

function encodeTools(tools: ModelToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

function combinedSignal(requestSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
}

function responseFinishReason(raw: string | null | undefined, toolCalls: ModelToolCall[]): GenerateResult["finishReason"] {
  if (toolCalls.length || raw === "tool_calls") return "tool_call";
  if (raw === "length") return "length";
  return "stop";
}

/**
 * Provider-neutral OpenAI chat-completions adapter. It intentionally sends only
 * portable OpenAI-compatible fields: model/messages/tools/tool_choice plus basic
 * generation controls. Family-specific llama.cpp/Qwen grammar and thinking
 * controls remain isolated in the existing qwen-llamacpp adapter.
 */
export class GenericOpenAiCompatibleAdapter implements ModelAdapter {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly profile: GenericOpenAiCompatibleProfile,
    private readonly fetcher: Fetch = fetch,
    private readonly admission?: AdmissionController
  ) {
    this.timeoutMs = Math.max(1_000, Math.floor(profile.requestTimeoutMs ?? 90_000));
  }

  getCapabilities(): ReadonlySet<ModelCapability> {
    return new Set(this.profile.capabilities);
  }

  async estimateTokens(text: string): Promise<number> {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-request-id": request.requestId
      },
      body: JSON.stringify({
        model: this.profile.runtimeModel,
        messages: request.messages.map(encodeMessage),
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        tools: encodeTools(request.tools),
        tool_choice: toolChoice(request),
        stream: false
      }),
      signal: combinedSignal(request.signal, this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Inference failed with status ${response.status}`);
    const body = await response.json() as OpenAiResponse;
    const first = body.choices?.[0];
    if (!first?.message) throw new Error("Inference returned no choices");
    const toolCalls = parseToolCalls(first.message);
    validateRequiredToolCall(request, toolCalls);
    return {
      modelVersionId: this.profile.modelVersionId,
      content: first.message.content ?? "",
      finishReason: responseFinishReason(first.finish_reason, toolCalls),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0
      }
    };
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    const result = await this.generate(request);
    if (result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const result = await this.generate(request);
    if (result.content) yield result.content;
  }

  async healthCheck(): Promise<ModelHealth> {
    const started = performance.now();
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/v1$/, "")}/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000))
      });
      return {
        ok: response.ok,
        latencyMs: Math.round(performance.now() - started),
        detail: response.ok ? undefined : `status:${response.status}`
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        detail: error instanceof Error ? error.message : "unknown"
      };
    }
  }

  private estimateRequestContextTokens(request: GenerateRequest): number {
    const messageTokens = request.messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 3.5)), 0);
    const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + Math.max(1, Math.ceil(JSON.stringify(tool).length / 3.5)), 0);
    return messageTokens + toolTokens + (request.maxOutputTokens ?? 1024);
  }
}
