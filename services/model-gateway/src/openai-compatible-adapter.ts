import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelMessage, ModelStreamDeltaHandler, ModelToolCall } from "@div3rsa/model-sdk";
import type { AdmissionController, ModelTimingObservation } from "./admission-control";
import { QWEN_Q8, QWEN_RUNTIME_MODEL } from "./registry";

type Fetch = typeof fetch;

type OpenAiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenAiMessage = { content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiStreamToolCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
type OpenAiToolChoice = "auto" | "required";
type ToolDirective = { choice: OpenAiToolChoice; forcedToolName?: string };
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

export interface InferenceWatchdogOptions {
  firstOutputTimeoutMs?: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  nonStreamingTimeoutMs?: number;
}

type ResolvedInferenceWatchdogOptions = Required<InferenceWatchdogOptions>;

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const DEFAULT_WATCHDOG: ResolvedInferenceWatchdogOptions = {
  firstOutputTimeoutMs: 45_000,
  stallTimeoutMs: 30_000,
  totalTimeoutMs: 180_000,
  nonStreamingTimeoutMs: 90_000
};

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error("invalid_inference_watchdog_timeout");
  return Math.floor(resolved);
}

function watchdogOptions(options: InferenceWatchdogOptions): ResolvedInferenceWatchdogOptions {
  return {
    firstOutputTimeoutMs: positiveTimeout(options.firstOutputTimeoutMs, DEFAULT_WATCHDOG.firstOutputTimeoutMs),
    stallTimeoutMs: positiveTimeout(options.stallTimeoutMs, DEFAULT_WATCHDOG.stallTimeoutMs),
    totalTimeoutMs: positiveTimeout(options.totalTimeoutMs, DEFAULT_WATCHDOG.totalTimeoutMs),
    nonStreamingTimeoutMs: positiveTimeout(options.nonStreamingTimeoutMs, DEFAULT_WATCHDOG.nonStreamingTimeoutMs)
  };
}

function combinedSignal(requestSignal: AbortSignal | undefined, watchdogController: AbortController): AbortSignal {
  return requestSignal ? AbortSignal.any([requestSignal, watchdogController.signal]) : watchdogController.signal;
}

async function raceWithWatchdog<T>(operation: Promise<T>, timeoutMs: number, errorCode: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(errorCode);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function encodeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) };
  }
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.name };
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
  const interTokenLatencyMs = timings.predicted_per_token_ms ?? (timings.predicted_ms != null && timings.predicted_n != null && timings.predicted_n > 0 ? timings.predicted_ms / timings.predicted_n : undefined);
  if (timings.prompt_ms == null && timings.predicted_per_second == null && interTokenLatencyMs == null) return null;
  return { ttftMs: timings.prompt_ms, tokensPerSecond: timings.predicted_per_second, interTokenLatencyMs };
}

function longestTokenPrefixSuffix(value: string, token: string): number {
  const lower = value.toLowerCase();
  const target = token.toLowerCase();
  const max = Math.min(value.length, token.length - 1);
  for (let length = max; length > 0; length -= 1) if (lower.endsWith(target.slice(0, length))) return length;
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
        if (closeIndex >= 0) { this.pending = this.pending.slice(closeIndex + THINK_CLOSE.length); this.hidden = false; continue; }
        const keep = longestTokenPrefixSuffix(this.pending, THINK_CLOSE);
        this.pending = keep ? this.pending.slice(-keep) : "";
        return visible;
      }
      const openIndex = lower.indexOf(THINK_OPEN);
      if (openIndex >= 0) { visible += this.pending.slice(0, openIndex); this.pending = this.pending.slice(openIndex + THINK_OPEN.length); this.hidden = true; continue; }
      const keep = longestTokenPrefixSuffix(this.pending, THINK_OPEN);
      const emitLength = this.pending.length - keep;
      visible += this.pending.slice(0, emitLength);
      this.pending = keep ? this.pending.slice(emitLength) : "";
      return visible;
    }
    return visible;
  }
  finish(): string {
    if (this.hidden) { this.pending = ""; return ""; }
    const visible = this.pending;
    this.pending = "";
    return visible;
  }
}

function visibleContent(content: string): string {
  const filter = new VisibleContentFilter();
  return filter.push(content) + filter.finish();
}
function latestUserContent(request: GenerateRequest): string { return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? ""; }
function isDirectClockRequest(text: string): boolean { return /\b(?:klockan|vad\s+är\s+tiden|vilken\s+tid|aktuella\s+tiden|current\s+time|what\s+time|time\s+is\s+it|vilket\s+datum|dagens\s+datum|today'?s\s+date)\b/i.test(text); }
function toolResultCount(request: GenerateRequest, name: string): number { return request.messages.filter((message) => message.role === "tool" && message.name === name).length; }
function hasTool(request: GenerateRequest, name: string): boolean { return Boolean(request.tools?.some((tool) => tool.name === name)); }
function systemInstructions(request: GenerateRequest): string { return request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"); }

type QwenReasoningEffort = "none" | "low" | "medium" | "xhigh" | undefined;
function reasoningEffort(request: GenerateRequest): QwenReasoningEffort {
  if (request.disableThinking) return "none";
  const system = systemInstructions(request);
  const fast = /Reasoning policy:\s*FAST(?:\b|:)/i.test(system);
  const standard = /Reasoning policy:\s*STANDARD(?:\b|:)/i.test(system);
  const deep = /Reasoning policy:\s*DEEP(?:\b|:)/i.test(system);
  const stable = /STABLE INFORMATION:/i.test(system);
  const freshnessRequired = /(?:CURRENT|LIVE) INFORMATION REQUIRED:/i.test(system);
  const critical = /Task risk:\s*critical\b/i.test(system);
  if (fast && stable && !freshnessRequired) return "none";
  if (fast) return "low";
  if (standard) return undefined;
  if (deep || critical) return "xhigh";
  return undefined;
}

function requiredTool(name: string): ToolDirective {
  return { choice: "required", forcedToolName: name };
}

function toolDirective(request: GenerateRequest): ToolDirective | undefined {
  if (!request.tools?.length) return undefined;
  const system = systemInstructions(request);
  const securityReadinessRequired = system.includes("SECURITY READINESS REQUIRED");
  if (securityReadinessRequired && hasTool(request, "security_scan")) {
    return toolResultCount(request, "security_scan") === 0
      ? requiredTool("security_scan")
      : { choice: "auto" };
  }
  const currentRequired = system.includes("CURRENT INFORMATION REQUIRED") || system.includes("LIVE INFORMATION REQUIRED");
  if (!currentRequired) return { choice: "auto" };
  const directClock = system.includes("LIVE INFORMATION REQUIRED") && isDirectClockRequest(latestUserContent(request));
  if (directClock && hasTool(request, "current_time")) return toolResultCount(request, "current_time") === 0 ? requiredTool("current_time") : { choice: "auto" };
  if (hasTool(request, "web_search") && hasTool(request, "web_fetch")) {
    if (toolResultCount(request, "web_search") === 0) return requiredTool("web_search");
    const corroborationRequired = /Research depth:\s*deep\b/i.test(system) || /Task risk:\s*(?:high|critical)\b/i.test(system);
    const requiredFetches = corroborationRequired ? 2 : 1;
    if (toolResultCount(request, "web_fetch") < requiredFetches) return requiredTool("web_fetch");
  }
  return { choice: "auto" };
}

function requestBody(request: GenerateRequest, stream: boolean) {
  const directive = toolDirective(request);
  const requestTools = directive?.forcedToolName
    ? request.tools?.filter((tool) => tool.name === directive.forcedToolName)
    : request.tools;
  return {
    model: QWEN_RUNTIME_MODEL,
    messages: request.messages.map(encodeMessage),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    reasoning_effort: reasoningEffort(request),
    chat_template_kwargs: request.disableThinking ? { enable_thinking: false } : undefined,
    cache_prompt: true,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    tools: requestTools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    tool_choice: directive?.choice
  };
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  private readonly watchdog: ResolvedInferenceWatchdogOptions;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: Fetch = fetch, private readonly admission?: AdmissionController, watchdog: InferenceWatchdogOptions = {}) { this.watchdog = watchdogOptions(watchdog); }
  getCapabilities(): ReadonlySet<ModelCapability> { return new Set(QWEN_Q8.capabilities); }
  async estimateTokens(text: string): Promise<number> { return Math.max(1, Math.ceil(text.length / 3.5)); }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const controller = new AbortController();
    const signal = combinedSignal(request.signal, controller);
    const operation = (async () => {
      const response = await this.fetcher(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId }, body: JSON.stringify(requestBody(request, false)), signal });
      if (!response.ok) throw new Error(`Inference failed with status ${response.status}`);
      const body = await response.json() as { choices: Array<{ message: OpenAiMessage; finish_reason: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; timings?: LlamaTimings };
      const observation = timingObservation(body.timings);
      if (observation) this.admission?.observeTimings(observation);
      const first = body.choices[0];
      if (!first) throw new Error("Inference returned no choices");
      const toolCalls = parseToolCalls(first.message);
      return { modelVersionId: QWEN_Q8.id, content: visibleContent(first.message.content ?? ""), finishReason: toolCalls.length || first.finish_reason === "tool_calls" ? "tool_call" as const : first.finish_reason === "length" ? "length" as const : "stop" as const, toolCalls: toolCalls.length ? toolCalls : undefined, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0 } };
    })();
    return raceWithWatchdog(operation, this.watchdog.nonStreamingTimeoutMs, "inference_timeout:request", controller);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const requestStartedAt = performance.now();
    const controller = new AbortController();
    const signal = combinedSignal(request.signal, controller);
    let observedFirstToken = false;
    let observedUsefulOutput = false;
    const response = await raceWithWatchdog(this.fetcher(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId }, body: JSON.stringify(requestBody(request, true)), signal }), Math.min(this.watchdog.firstOutputTimeoutMs, this.watchdog.totalTimeoutMs), "inference_timeout:first_output", controller);
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
      observedUsefulOutput = true;
      if (!observedFirstToken) { observedFirstToken = true; this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt }); }
      content += visible;
      await onDelta(visible);
    };
    try {
      while (true) {
        const elapsed = performance.now() - requestStartedAt;
        const totalRemaining = this.watchdog.totalTimeoutMs - elapsed;
        if (totalRemaining <= 0) throw new Error("inference_timeout:total");
        const firstOutputRemaining = observedUsefulOutput ? Number.POSITIVE_INFINITY : this.watchdog.firstOutputTimeoutMs - elapsed;
        if (firstOutputRemaining <= 0) throw new Error("inference_timeout:first_output");
        const waitMs = Math.max(1, Math.min(this.watchdog.stallTimeoutMs, totalRemaining, firstOutputRemaining));
        const code = waitMs === firstOutputRemaining ? "inference_timeout:first_output" : waitMs === totalRemaining ? "inference_timeout:total" : "inference_timeout:stall";
        const { done, value } = await raceWithWatchdog(reader.read(), waitMs, code, controller);
        if (done) break;
        buffer += value;
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as StreamPayload;
          const choice = payload.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.content) await emitVisible(delta.content);
          for (const part of delta?.tool_calls ?? []) {
            observedUsefulOutput = true;
            const index = part.index ?? 0;
            const current = toolParts.get(index) ?? { id: "", name: "", arguments: "" };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) current.arguments += part.function.arguments;
            toolParts.set(index, current);
          }
          if (payload.usage) usage = { inputTokens: payload.usage.prompt_tokens ?? usage.inputTokens, outputTokens: payload.usage.completion_tokens ?? usage.outputTokens, cachedTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens };
          const observation = timingObservation(payload.timings);
          if (observation) this.admission?.observeTimings(observation);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("inference_timeout:")) { controller.abort(error); await reader.cancel(error.message).catch(() => undefined); }
      throw error;
    } finally { reader.releaseLock(); }
    const tail = contentFilter.finish();
    if (tail) {
      if (!observedFirstToken) { observedFirstToken = true; this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt }); }
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
    return { modelVersionId: QWEN_Q8.id, content, finishReason: toolCalls.length || finishReason === "tool_calls" ? "tool_call" : finishReason === "length" ? "length" : "stop", toolCalls: toolCalls.length ? toolCalls : undefined, usage };
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
    } catch (error) { return { ok: false, latencyMs: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : "unknown" }; }
  }

  private estimateRequestContextTokens(request: GenerateRequest): number {
    const messageTokens = request.messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 3.5)), 0);
    const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + Math.max(1, Math.ceil(JSON.stringify(tool).length / 3.5)), 0);
    return messageTokens + toolTokens + (request.maxOutputTokens ?? 1024);
  }
}
