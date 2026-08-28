import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelMessage, ModelStreamDeltaHandler, ModelToolCall } from "@div3rsa/model-sdk";
import type { AdmissionController, ModelTimingObservation } from "./admission-control";
import { QWEN_Q8, QWEN_RUNTIME_MODEL } from "./registry";

type Fetch = typeof fetch;

type OpenAiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenAiMessage = { content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiStreamToolCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
type OpenAiToolChoice = "auto" | { type: "function"; function: { name: string } };
type LlamaTimings = {
  prompt_ms?: number;
  predicted_ms?: number;
  predicted_n?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
};

type StreamPayload = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAiStreamToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  timings?: LlamaTimings;
};

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

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

function timingObservation(timings?: LlamaTimings): ModelTimingObservation | null {
  if (!timings) return null;
  const interTokenLatencyMs = timings.predicted_per_token_ms ?? (
    timings.predicted_ms != null && timings.predicted_n != null && timings.predicted_n > 0
      ? timings.predicted_ms / timings.predicted_n
      : undefined
  );
  if (timings.prompt_ms == null && timings.predicted_per_second == null && interTokenLatencyMs == null) return null;
  return { ttftMs: timings.prompt_ms, tokensPerSecond: timings.predicted_per_second, interTokenLatencyMs };
}

function longestTokenPrefixSuffix(value: string, token: string): number {
  const lower = value.toLowerCase();
  const target = token.toLowerCase();
  const max = Math.min(value.length, token.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (lower.endsWith(target.slice(0, length))) return length;
  }
  return 0;
}

class VisibleContentFilter {
  private pending = "";
  private hidden = false;

  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    let visible = "";

    while (this.pending) {
      const lower = this.pending.toLowerCase();
      if (this.hidden) {
        const closeIndex = lower.indexOf(THINK_CLOSE);
        if (closeIndex >= 0) {
          this.pending = this.pending.slice(closeIndex + THINK_CLOSE.length);
          this.hidden = false;
          continue;
        }
        const keep = longestTokenPrefixSuffix(this.pending, THINK_CLOSE);
        this.pending = keep ? this.pending.slice(-keep) : "";
        return visible;
      }

      const openIndex = lower.indexOf(THINK_OPEN);
      if (openIndex >= 0) {
        visible += this.pending.slice(0, openIndex);
        this.pending = this.pending.slice(openIndex + THINK_OPEN.length);
        this.hidden = true;
        continue;
      }

      const keep = longestTokenPrefixSuffix(this.pending, THINK_OPEN);
      const emitLength = this.pending.length - keep;
      visible += this.pending.slice(0, emitLength);
      this.pending = keep ? this.pending.slice(emitLength) : "";
      return visible;
    }

    return visible;
  }

  finish(): string {
    if (this.hidden) {
      this.pending = "";
      return "";
    }
    const visible = this.pending;
    this.pending = "";
    return visible;
  }
}

function visibleContent(content: string): string {
  const filter = new VisibleContentFilter();
  return filter.push(content) + filter.finish();
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function isDirectClockRequest(text: string): boolean {
  return /\b(?:klockan|vad\s+är\s+tiden|vilken\s+tid|aktuella\s+tiden|current\s+time|what\s+time|time\s+is\s+it|vilket\s+datum|dagens\s+datum|today'?s\s+date)\b/i.test(text);
}

function toolResultCount(request: GenerateRequest, name: string): number {
  return request.messages.filter((message) => message.role === "tool" && message.name === name).length;
}

function hasTool(request: GenerateRequest, name: string): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === name));
}

function systemInstructions(request: GenerateRequest): string {
  return request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

type QwenReasoningEffort = "none" | "low" | "medium" | "xhigh" | undefined;

function reasoningEffort(request: GenerateRequest): QwenReasoningEffort {
  const system = systemInstructions(request);
  const fast = /Reasoning policy:\s*FAST(?:\b|:)/i.test(system);
  const standard = /Reasoning policy:\s*STANDARD(?:\b|:)/i.test(system);
  const deep = /Reasoning policy:\s*DEEP(?:\b|:)/i.test(system);
  const stable = /STABLE INFORMATION:/i.test(system);
  const freshnessRequired = /(?:CURRENT|LIVE) INFORMATION REQUIRED:/i.test(system);
  const critical = /Task risk:\s*critical\b/i.test(system);

  // Qwen3.8 defaults to its deepest reasoning level when no effort is supplied.
  // Keep full reasoning for DEEP/CRITICAL work, but avoid paying that latency on
  // normal STANDARD or FAST requests. llama.cpp maps `none` to
  // enable_thinking=false and forwards the explicit effort into the Qwen chat
  // template for the remaining levels.
  if (fast && stable && !freshnessRequired) return "none";
  if (fast) return "low";
  if (standard) return "medium";
  if (deep || critical) return "xhigh";
  return undefined;
}

function toolChoice(request: GenerateRequest): OpenAiToolChoice | undefined {
  if (!request.tools?.length) return undefined;
  const system = systemInstructions(request);
  const currentRequired = system.includes("CURRENT INFORMATION REQUIRED") || system.includes("LIVE INFORMATION REQUIRED");
  if (!currentRequired) return "auto";

  const directClock = system.includes("LIVE INFORMATION REQUIRED") && isDirectClockRequest(latestUserContent(request));
  if (directClock && hasTool(request, "current_time")) {
    return toolResultCount(request, "current_time") === 0
      ? { type: "function", function: { name: "current_time" } }
      : "auto";
  }

  if (hasTool(request, "web_search") && hasTool(request, "web_fetch")) {
    if (toolResultCount(request, "web_search") === 0) return { type: "function", function: { name: "web_search" } };
    const corroborationRequired = /Research depth:\s*deep\b/i.test(system) || /Task risk:\s*(?:high|critical)\b/i.test(system);
    const requiredFetches = corroborationRequired ? 2 : 1;
    if (toolResultCount(request, "web_fetch") < requiredFetches) return { type: "function", function: { name: "web_fetch" } };
  }

  return "auto";
}

function requestBody(request: GenerateRequest, stream: boolean) {
  return {
    model: QWEN_RUNTIME_MODEL,
    messages: request.messages.map(encodeMessage),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    reasoning_effort: reasoningEffort(request),
    cache_prompt: true,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    tool_choice: toolChoice(request)
  };
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
    private readonly admission?: AdmissionController
  ) {}

  getCapabilities(): ReadonlySet<ModelCapability> { return new Set(QWEN_Q8.capabilities); }
  async estimateTokens(text: string): Promise<number> { return Math.max(1, Math.ceil(text.length / 3.5)); }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId },
      body: JSON.stringify(requestBody(request, false)),
      signal: request.signal
    });
    if (!response.ok) throw new Error(`Inference failed with status ${response.status}`);
    const body = await response.json() as {
      choices: Array<{ message: OpenAiMessage; finish_reason: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      timings?: LlamaTimings;
    };
    const observation = timingObservation(body.timings);
    if (observation) this.admission?.observeTimings(observation);
    const first = body.choices[0];
    if (!first) throw new Error("Inference returned no choices");
    const toolCalls = parseToolCalls(first.message);
    return {
      modelVersionId: QWEN_Q8.id,
      content: visibleContent(first.message.content ?? ""),
      finishReason: toolCalls.length || first.finish_reason === "tool_calls" ? "tool_call" : first.finish_reason === "length" ? "length" : "stop",
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0 }
    };
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const requestStartedAt = performance.now();
    let observedFirstToken = false;
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId },
      body: JSON.stringify(requestBody(request, true)),
      signal: request.signal
    });
    if (!response.ok || !response.body) throw new Error(`Inference stream failed with status ${response.status}`);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let content = "";
    let finishReason = "stop";
    let usage: GenerateResult["usage"] = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const toolParts = new Map<number, { id: string; name: string; arguments: string }>();
    const contentFilter = new VisibleContentFilter();

    const emitVisible = async (text: string) => {
      const visible = contentFilter.push(text);
      if (!visible) return;
      if (!observedFirstToken) {
        observedFirstToken = true;
        this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt });
      }
      content += visible;
      await onDelta(visible);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as StreamPayload;
          const choice = payload.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.content) await emitVisible(delta.content);
          for (const part of delta?.tool_calls ?? []) {
            const index = part.index ?? 0;
            const current = toolParts.get(index) ?? { id: "", name: "", arguments: "" };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) current.arguments += part.function.arguments;
            toolParts.set(index, current);
          }
          if (payload.usage) {
            usage = {
              inputTokens: payload.usage.prompt_tokens ?? usage.inputTokens,
              outputTokens: payload.usage.completion_tokens ?? usage.outputTokens,
              cachedTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens
            };
          }
          const observation = timingObservation(payload.timings);
          if (observation) this.admission?.observeTimings(observation);
        }
      }
    }

    const tail = contentFilter.finish();
    if (tail) {
      if (!observedFirstToken) {
        observedFirstToken = true;
        this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt });
      }
      content += tail;
      await onDelta(tail);
    }

    const toolCalls: ModelToolCall[] = [...toolParts.entries()].sort(([left], [right]) => left - right).map(([index, part]) => {
      if (!part.name) throw new Error("Inference stream returned tool call without name");
      let input: Record<string, unknown> = {};
      if (part.arguments.trim()) {
        const parsed = JSON.parse(part.arguments) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Inference stream returned invalid tool arguments");
        input = parsed as Record<string, unknown>;
      }
      return { id: part.id || `tool-call-${index}`, name: part.name, input };
    });

    return {
      modelVersionId: QWEN_Q8.id,
      content,
      finishReason: toolCalls.length || finishReason === "tool_calls" ? "tool_call" : finishReason === "length" ? "length" : "stop",
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const chunks: string[] = [];
    const result = await this.generateStreamed(request, (delta) => { chunks.push(delta); });
    for (const chunk of chunks) yield chunk;
    if (!chunks.length && result.content) yield result.content;
  }

  async healthCheck(): Promise<ModelHealth> {
    const started = performance.now();
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/v1$/, "")}/health`);
      return { ok: response.ok, latencyMs: Math.round(performance.now() - started), detail: response.ok ? undefined : `status:${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : "unknown" };
    }
  }

  private estimateRequestContextTokens(request: GenerateRequest): number {
    const messageTokens = request.messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 3.5)), 0);
    const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + Math.max(1, Math.ceil(JSON.stringify(tool).length / 3.5)), 0);
    return messageTokens + toolTokens + (request.maxOutputTokens ?? 1024);
  }
}
