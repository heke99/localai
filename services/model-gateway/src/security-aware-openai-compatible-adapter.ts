import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelMessage,
  ModelStreamDeltaHandler
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { OpenAiCompatibleAdapter as RawOpenAiCompatibleAdapter, type InferenceWatchdogOptions } from "./openai-compatible-adapter";
import { normalizeTextualToolResult, securityToolContract } from "./textual-tool-call-normalizer";

type Fetch = typeof fetch;

function hasSecurityTool(request: GenerateRequest): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "security_scan"));
}

function hasSecurityToolResult(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "tool" && message.name === "security_scan");
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function requestsSecurityExecution(request: GenerateRequest): boolean {
  if (!hasSecurityTool(request)) return false;
  const text = latestUserContent(request)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/gi, " ");
  return /\b(?:säkerhetsgranska|granska|testa|kontrollera|kör|börja|utför|pentest|penetrationstest|scan|assess|audit|test|review|check|execute|run)\b/i.test(text);
}

function withSecurityContract(request: GenerateRequest): GenerateRequest {
  const contract = securityToolContract(request.tools);
  if (!contract || request.messages.some((message) => message.role === "system" && message.content.includes("SECURITY TOOL CONTRACT V1"))) return request;
  const messages: ModelMessage[] = [{ role: "system", content: contract }, ...request.messages];
  return { ...request, messages };
}

function mergeUsage(first: GenerateResult["usage"], second: GenerateResult["usage"]): GenerateResult["usage"] {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens
  };
}

function repairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: "Execution repair: you stated or implied that you would perform the authorized security assessment, but no executable function call was produced. Invoke exactly one exposed security_scan function now using the SECURITY TOOL CONTRACT V1 JSON shape. Choose the least-disruptive useful supported subtool for the current step. Do not print XML/tool markup and do not invent unsupported parameters."
      }
    ]
  };
}

/**
 * Compatibility boundary for Qwen/llama.cpp deployments that occasionally serialize a function call
 * as textual <tool_call> markup instead of OpenAI tool_calls. The bridge only accepts currently
 * exposed function names, repairs security_scan to its bounded schema, and still routes every call
 * through the normal worker authorization/runtime gates.
 */
export class SecurityAwareOpenAiCompatibleAdapter implements ModelAdapter {
  private readonly raw: RawOpenAiCompatibleAdapter;

  constructor(
    baseUrl: string,
    apiKey: string,
    fetcher: Fetch = fetch,
    admission?: AdmissionController,
    watchdog: InferenceWatchdogOptions = {}
  ) {
    this.raw = new RawOpenAiCompatibleAdapter(baseUrl, apiKey, fetcher, admission, watchdog);
  }

  getCapabilities(): ReadonlySet<ModelCapability> { return this.raw.getCapabilities(); }
  estimateTokens(text: string): Promise<number> { return this.raw.estimateTokens(text); }
  healthCheck(): Promise<ModelHealth> { return this.raw.healthCheck(); }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const prepared = withSecurityContract(request);
    const first = await this.raw.generate(prepared);
    const normalizedFirst = normalizeTextualToolResult(first, prepared.tools).result;
    if (normalizedFirst.finishReason === "tool_call" || !requestsSecurityExecution(prepared) || hasSecurityToolResult(prepared)) return normalizedFirst;

    // One bounded model repair turn is allowed only before the first security tool result. We never
    // fabricate arguments from the user prompt; if Qwen still cannot emit a parseable call, it fails
    // normally and the outer agent/eval observes the failure.
    const second = await this.raw.generate(repairRequest(prepared, normalizedFirst));
    const normalizedSecond = normalizeTextualToolResult(second, prepared.tools).result;
    return { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    if (!hasSecurityTool(request)) {
      if (this.raw.generateStreamed) return this.raw.generateStreamed(request, onDelta);
      const result = await this.raw.generate(request);
      if (result.content) await onDelta(result.content);
      return result;
    }

    // Buffer security turns at this compatibility boundary so malformed pseudo-tool XML never leaks
    // into the user-visible stream. Activity still streams from the worker; a genuine final answer is
    // emitted after the tool-decision turn has been normalized.
    const result = await this.generate(request);
    if (result.finishReason !== "tool_call" && result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    if (!hasSecurityTool(request)) {
      yield* this.raw.stream(request);
      return;
    }
    const result = await this.generate(request);
    if (result.content) yield result.content;
  }
}