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

function needsStructuredToolRecovery(result: GenerateResult): boolean {
  if (result.finishReason === "tool_call") return !result.toolCalls?.length;
  return executionCommandPattern.test(result.content) && executionIntentPattern.test(result.content);
}

function recoveryRequest(request: GenerateRequest, result: GenerateResult): GenerateRequest {
  const availableTools = request.tools?.map((tool) => tool.name) ?? [];
  const instruction = availableTools.length > 0
    ? `Runtime recovery: the previous response implied live execution but did not emit a valid structured tool call. Do not claim any command was executed. Use one of the exposed structured tools when execution is needed. Available tools: ${availableTools.join(", ")}. If none can perform the requested action, explicitly report TOOL_UNAVAILABLE and continue without fabricated live results.`
    : "Runtime recovery: no execution tools are exposed for this turn. Do not claim any displayed command was executed. Explicitly report TOOL_UNAVAILABLE and continue with non-executed analysis.";

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
 * loop. It never parses or executes shell text. The model gets one bounded
 * recovery turn to emit an exposed structured tool call or state that execution
 * is unavailable.
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
    if (!needsStructuredToolRecovery(first)) return first;

    const second = await this.inner.generate(recoveryRequest(request, first));
    if (needsStructuredToolRecovery(second)) throw new Error("tool_call_required_but_missing");
    return mergeUsage(first, second);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    // A tool-enabled turn must be validated before visible streaming. Otherwise
    // a malformed textual curl response has already escaped to the UI before the
    // runtime can turn it into a structured tool call.
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
