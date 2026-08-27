import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelMessage, ModelStreamDeltaHandler, ModelToolCall } from "@div3rsa/model-sdk";
import type { AdmissionController, ModelTimingObservation } from "./admission-control";
import { QWEN_Q8, QWEN_RUNTIME_MODEL } from "./registry";

type Fetch = typeof fetch;

type OpenAiToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenAiMessage = { content?: string | null; tool_calls?: OpenAiToolCall[] };
type OpenAiStreamToolCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
type LlamaTimings = {
  prompt_ms?: number;
  predicted_ms?: number;
  predicted_n?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
};

type StreamPayload = {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: OpenAiStreamToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  timings?: LlamaTimings;
};

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

function requestBody(request: GenerateRequest, stream: boolean) {
  return {
    model: QWEN_RUNTIME_MODEL,
    messages: request.messages.map(encodeMessage),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    tool_choice: request.tools?.length ? "auto" : undefined
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
      content: first.message.content ?? "",
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

    const consumePayload = async (data: string) => {
      const parsed = JSON.parse(data) as StreamPayload;
      const timing = timingObservation(parsed.timings);
      if (timing) this.admission?.observeTimings(timing);
      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: parsed.usage.completion_tokens ?? usage.outputTokens,
          cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens
        };
      }
      const choice = parsed.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      const text = delta?.content ?? "";
      if (text) {
        if (!observedFirstToken) {
          observedFirstToken = true;
          this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt });
        }
        content += text;
        await onDelta(text);
      }
      for (const part of delta?.tool_calls ?? []) {
        const index = Number.isInteger(part.index) ? part.index! : 0;
        const current = toolParts.get(index) ?? { id: `tool-call-${index}`, name: "", arguments: "" };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolParts.set(index, current);
      }
    };

    try {
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
            await consumePayload(data);
          }
        }
      }
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          await consumePayload(data);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolParts.entries()].sort(([a], [b]) => a - b).map(([index, part]) => {
      const name = part.name.trim();
      if (!name) throw new Error("Inference returned streamed tool call without name");
      let input: Record<string, unknown> = {};
      const raw = part.arguments.trim();
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Inference returned invalid streamed tool arguments");
        input = parsed as Record<string, unknown>;
      }
      return { id: part.id || `tool-call-${index}`, name, input } satisfies ModelToolCall;
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
    await this.admission?.waitForAdmission(this.estimateRequestContextTokens(request), request.signal);
    const requestStartedAt = performance.now();
    let observedFirstToken = false;
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId },
      body: JSON.stringify({ model: QWEN_RUNTIME_MODEL, messages: request.messages.map(encodeMessage), max_tokens: request.maxOutputTokens, temperature: request.temperature, stream: true }),
      signal: request.signal
    });
    if (!response.ok || !response.body) throw new Error(`Inference stream failed with status ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const parseData = (data: string): string | null => {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; timings?: LlamaTimings };
      const timing = timingObservation(parsed.timings);
      if (timing) this.admission?.observeTimings(timing);
      const content = parsed.choices?.[0]?.delta?.content;
      if (content && !observedFirstToken) {
        observedFirstToken = true;
        this.admission?.observeTimings({ ttftMs: performance.now() - requestStartedAt });
      }
      return content || null;
    };
    try {
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
            const content = parseData(data);
            if (content) yield content;
          }
        }
      }
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const content = parseData(data);
          if (content) yield content;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<ModelHealth> {
    const started = performance.now();
    try {
      const response = await this.fetcher(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.apiKey}` } });
      return { ok: response.ok, latencyMs: Math.round(performance.now() - started), detail: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : "unknown" };
    }
  }

  private estimateRequestContextTokens(request: GenerateRequest): number {
    const messageCharacters = request.messages.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0);
    const toolCharacters = JSON.stringify(request.tools ?? []).length;
    const estimatedInput = Math.max(1, Math.ceil((messageCharacters + toolCharacters) / 3.5));
    return estimatedInput + Math.max(0, request.maxOutputTokens ?? 1024);
  }
}
