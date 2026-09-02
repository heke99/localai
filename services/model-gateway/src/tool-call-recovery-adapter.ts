import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelStreamDeltaHandler
} from "@div3rsa/model-sdk";

const executionCommandPattern = /```(?:bash|sh|shell|zsh|powershell)?[\s\S]*?\b(?:curl|wget|nmap|dig|nslookup|ping)\b/i;
const executionIntentPattern = /\b(?:behöver|måste|ska|need|needs|must|will|going\s+to)\b[\s\S]{0,240}\b(?:bekräfta|verifiera|testa|köra|confirm|verify|check|test|run|execute)\b/i;

function looksLikeJsonToolEnvelope(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return false;
    const record = parsed as Record<string, unknown>;
    const selector = typeof record.tool === "string"
      ? record.tool.trim()
      : typeof record.name === "string"
        ? record.name.trim()
        : "";
    if (!selector) return false;
    const parameters = record.parameters ?? record.arguments ?? record.input;
    return Boolean(parameters && typeof parameters === "object" && !Array.isArray(parameters));
  } catch {
    return false;
  }
}

function needsStructuredToolRecovery(request: GenerateRequest, result: GenerateResult): boolean {
  if (result.finishReason === "tool_call") return !result.toolCalls?.length;
  if (request.tools !== undefined && looksLikeJsonToolEnvelope(result.content)) return true;
  return executionCommandPattern.test(result.content) && executionIntentPattern.test(result.content);
}

function recoveryRequest(request: GenerateRequest, result: GenerateResult): GenerateRequest {
  const availableTools = request.tools?.map((tool) => tool.name) ?? [];
  const instruction = availableTools.length > 0
    ? `Runtime recovery: the previous response implied live execution but did not emit a valid structured tool call. Do not claim any command was executed and do not print JSON pseudo-tool envelopes such as {"tool":"...","parameters":{...}}. Emit a native function/tool call using one of the exposed structured tools when execution is needed. Available tools: ${availableTools.join(", ")}. Use only fields allowed by the selected tool schema; generation controls such as max_output_tokens are not tool parameters unless the schema explicitly defines them. If none can perform the requested action, explicitly report TOOL_UNAVAILABLE and continue without fabricated live results.`
    : "Runtime recovery: no execution tools are exposed for this turn. Do not claim any displayed command or JSON pseudo-tool envelope was executed. Explicitly report TOOL_UNAVAILABLE and continue with non-executed analysis.";

  return {
    ...request,
    requestId: `${request.requestId}:tool-recovery`,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: result.content },
      { role: "system", content: instruction }
    ]
  };
}

function mergeUsage(first: GenerateResult, second: GenerateResult): GenerateResult {
  return {
    ...second,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cachedTokens: first.usage.cachedTokens + second.usage.cachedTokens
    }
  };
}

/**
 * Prevents an execution-looking textual response from bypassing the native tool
 * loop. It never parses shell text into execution and never executes JSON pseudo
 * tool envelopes. The model gets one bounded recovery turn to emit an exposed
 * structured tool call or state that execution is unavailable.
 */
export class ToolCallRecoveryAdapter implements ModelAdapter {
  constructor(private readonly inner: ModelAdapter) {}

  getCapabilities(): ReadonlySet<ModelCapability> {
    return this.inner.getCapabilities();
  }

  estimateTokens(text: string): Promise<number> {
    return this.inner.estimateTokens(text);
  }

  healthCheck(): Promise<ModelHealth> {
    return this.inner.healthCheck();
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const first = await this.inner.generate(request);
    if (!needsStructuredToolRecovery(request, first)) return first;

    const secondRequest = recoveryRequest(request, first);
    const second = await this.inner.generate(secondRequest);
    if (needsStructuredToolRecovery(secondRequest, second)) throw new Error("tool_call_required_but_missing");
    return mergeUsage(first, second);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    // A tool-enabled turn must be validated before visible streaming. Otherwise
    // malformed textual execution or a JSON pseudo-tool envelope has already
    // escaped to the UI before the runtime can recover it into a native call.
    if (request.tools !== undefined) {
      const result = await this.generate(request);
      if (result.content) await onDelta(result.content);
      return result;
    }

    if (this.inner.generateStreamed) return this.inner.generateStreamed(request, onDelta);
    const result = await this.generate(request);
    if (result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const chunks: string[] = [];
    const result = await this.generateStreamed(request, (delta) => { chunks.push(delta); });
    for (const chunk of chunks) yield chunk;
    if (!chunks.length && result.content) yield result.content;
  }
}
