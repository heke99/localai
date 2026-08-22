import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth } from "@div3rsa/model-sdk";
import { QWEN_Q8 } from "./registry";

type Fetch = typeof fetch;

export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: Fetch = fetch) {}

  getCapabilities(): ReadonlySet<ModelCapability> { return new Set(QWEN_Q8.capabilities); }
  async estimateTokens(text: string): Promise<number> { return Math.max(1, Math.ceil(text.length / 3.5)); }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId },
      body: JSON.stringify({ model: QWEN_Q8.id, messages: request.messages, max_tokens: request.maxOutputTokens, temperature: request.temperature, stream: false })
    });
    if (!response.ok) throw new Error(`Inference failed with status ${response.status}`);
    const body = await response.json() as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
    const first = body.choices[0];
    if (!first) throw new Error("Inference returned no choices");
    return {
      modelVersionId: QWEN_Q8.id,
      content: first.message.content,
      finishReason: first.finish_reason === "length" ? "length" : "stop",
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0 }
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": request.requestId },
      body: JSON.stringify({ model: QWEN_Q8.id, messages: request.messages, max_tokens: request.maxOutputTokens, temperature: request.temperature, stream: true })
    });
    if (!response.ok || !response.body) throw new Error(`Inference stream failed with status ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
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
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
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
}
