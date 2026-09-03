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
import {
  materializeExecutionObligation,
  routeExecutionObligation,
  withExecutionObligation
} from "./execution-obligation-router";

const executionCommandPattern = /```(?:bash|sh|shell|zsh|powershell)?[\s\S]*?\b(?:curl|wget|nmap|dig|nslookup|ping)\b/i;
const executionIntentPattern = /\b(?:behöver|måste|ska|need|needs|must|will|going\s+to)\b[\s\S]{0,240}\b(?:bekräfta|verifiera|testa|köra|confirm|verify|check|test|run|execute)\b/i;

interface RecoveryIntent {
  toolName: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function registeredNames(tools: readonly ModelToolDefinition[] | undefined): string[] {
  return (tools ?? []).map((tool) => tool.name.trim()).filter(Boolean);
}

function registeredInvocationName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  for (const name of registeredNames(tools)) {
    if (new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(name)}\\s*\\(`, "m").test(content)) return name;
  }
  return null;
}

function explicitRegisteredIntentName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  for (const name of registeredNames(tools)) {
    const escaped = escapeRegExp(name);
    const patterns = [
      new RegExp(`\\b(?:i\\s+)?(?:need|must|will|shall|am\\s+going\\s+to)\\s+(?:to\\s+)?(?:use|call|run|invoke)\\s+(?:the\\s+)?${escaped}\\b`, "i"),
      new RegExp(`\\b(?:jag\\s+)?(?:behöver|måste|ska|kommer\\s+att)\\s+(?:använda|köra|anropa)\\s+(?:verktyget\\s+)?${escaped}\\b`, "i")
    ];
    if (patterns.some((pattern) => pattern.test(content))) return name;
  }
  return null;
}

function qwenEnvelopeToolName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  const allowed = new Set(registeredNames(tools));
  for (const match of content.matchAll(/<tool_call\b[^>]*>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const body = match[1] ?? "";
    const functionName = /<function=([A-Za-z_][\w.:-]*)>/i.exec(body)?.[1]?.trim();
    if (functionName && allowed.has(functionName)) return functionName;
    const jsonName = /["'](?:name|tool)["']\s*:\s*["']([^"']+)["']/i.exec(body)?.[1]?.trim();
    if (jsonName && allowed.has(jsonName)) return jsonName;
  }
  return null;
}

function jsonEnvelopeToolName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const selector = typeof record.tool === "string"
      ? record.tool.trim()
      : typeof record.name === "string"
        ? record.name.trim()
        : "";
    if (!selector || !registeredNames(tools).includes(selector)) return null;
    const parameters = record.parameters ?? record.arguments ?? record.input;
    return parameters && typeof parameters === "object" && !Array.isArray(parameters) ? selector : null;
  } catch {
    return null;
  }
}

function assertCompleteModelResult(result: GenerateResult): void {
  if (result.finishReason === "error") throw new Error("model_generation_failed");
  if (result.finishReason === "length") throw new Error("model_output_truncated");
}

function recoveryIntent(request: GenerateRequest, result: GenerateResult): RecoveryIntent | null {
  if (result.finishReason === "tool_call") return result.toolCalls?.length ? null : { toolName: request.requiredToolName?.trim() || null };

  const tools = request.tools ?? [];
  if (tools.length) {
    const invocation = registeredInvocationName(result.content, tools);
    if (invocation) return { toolName: invocation };

    const envelope = qwenEnvelopeToolName(result.content, tools);
    if (envelope) return { toolName: envelope };

    const jsonEnvelope = jsonEnvelopeToolName(result.content, tools);
    if (jsonEnvelope) return { toolName: jsonEnvelope };

    const explicit = explicitRegisteredIntentName(result.content, tools);
    if (explicit) return { toolName: explicit };
  }

  if (executionCommandPattern.test(result.content) && executionIntentPattern.test(result.content)) return { toolName: null };
  return null;
}

function recoveryRequest(request: GenerateRequest, result: GenerateResult, intent: RecoveryIntent): GenerateRequest {
  const availableTools = registeredNames(request.tools);
  const requiredToolName = intent.toolName && availableTools.includes(intent.toolName) ? intent.toolName : undefined;
  const instruction = availableTools.length > 0
    ? `Runtime recovery: the previous response implied live execution but did not emit a valid structured tool call. Do not claim any command was executed and do not print function-style pseudo calls, Qwen <tool_call> markup, or JSON pseudo-tool envelopes such as {"tool":"...","parameters":{...}}. ${requiredToolName ? `You explicitly selected the exposed tool ${requiredToolName}; emit that native function/tool call now using only its schema.` : `Emit a native function/tool call using one of the exposed structured tools when execution is needed. Available tools: ${availableTools.join(", ")}.`} Use only fields allowed by the selected tool schema; generation controls such as max_output_tokens are not tool parameters unless the schema explicitly defines them. If none can perform the requested action, explicitly report TOOL_UNAVAILABLE and continue without fabricated live results.`
    : "Runtime recovery: no execution tools are exposed for this turn. Do not claim any displayed command, function-style pseudo call, Qwen tool markup, or JSON pseudo-tool envelope was executed. Explicitly report TOOL_UNAVAILABLE and continue with non-executed analysis.";

  return {
    ...request,
    requestId: `${request.requestId}:tool-recovery`,
    temperature: 0,
    ...(requiredToolName ? { requiredToolName } : {}),
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

function assertRequiredRecoveryTool(request: GenerateRequest, result: GenerateResult): void {
  const required = request.requiredToolName?.trim();
  if (!required || result.finishReason !== "tool_call") return;
  if (result.toolCalls?.length !== 1 || result.toolCalls[0]?.name !== required) throw new Error(`required_tool_call_mismatch:${required}`);
}

function deterministicToolResult(call: ModelToolCall): GenerateResult {
  return {
    modelVersionId: "runtime-deterministic-tool-router",
    content: "",
    finishReason: "tool_call",
    toolCalls: [call],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  };
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function parseToolOutput(message: ModelMessage): Record<string, unknown> | null {
  if (message.role !== "tool") return null;
  try {
    const parsed = JSON.parse(message.content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function latestExecutedTool(messages: readonly ModelMessage[]): { call: ModelToolCall; output: Record<string, unknown> | null } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const toolMessage = messages[index];
    if (toolMessage?.role !== "tool" || !toolMessage.toolCallId) continue;
    for (let assistantIndex = index - 1; assistantIndex >= 0; assistantIndex -= 1) {
      const assistant = messages[assistantIndex];
      if (assistant?.role !== "assistant") continue;
      const call = assistant.toolCalls?.find((candidate) => candidate.id === toolMessage.toolCallId);
      if (call) return { call, output: parseToolOutput(toolMessage) };
    }
  }
  return null;
}

function successfulToolOutput(output: Record<string, unknown> | null): boolean {
  if (!output) return false;
  if (output.retryable === true) return false;
  return output.ok === true || output.retryable === false || output.recovered === true || output.changed === true;
}

function isRedundantLatestSuccessfulCall(request: GenerateRequest, result: GenerateResult): boolean {
  if (result.finishReason !== "tool_call" || result.toolCalls?.length !== 1) return false;
  const latest = latestExecutedTool(request.messages);
  const candidate = result.toolCalls[0];
  return Boolean(
    latest &&
    candidate &&
    latest.call.name === candidate.name &&
    stableValue(latest.call.input) === stableValue(candidate.input) &&
    successfulToolOutput(latest.output)
  );
}

async function finalizeAfterRedundantCall(inner: ModelAdapter, request: GenerateRequest, duplicate: GenerateResult): Promise<GenerateResult> {
  const latest = latestExecutedTool(request.messages);
  const instruction = `Runtime duplicate suppression: the model attempted to repeat ${latest?.call.name ?? "the latest tool"} with identical arguments even though the immediately preceding authoritative result already completed successfully and was not retryable. The duplicate was NOT executed. Use the existing tool result to answer the user's request now. Do not call tools again in this turn.`;
  const final = await inner.generate({
    ...request,
    requestId: `${request.requestId}:duplicate-suppressed-final`,
    tools: [],
    requiredToolName: undefined,
    temperature: 0,
    messages: [...request.messages, { role: "system", content: instruction }]
  });
  assertCompleteModelResult(final);
  if (final.finishReason === "tool_call") throw new Error("duplicate_tool_suppression_failed");
  return mergeUsage(duplicate, final);
}

/**
 * Prevents an execution-looking textual response from bypassing the native tool
 * loop. Explicit user-requested tool work is first routed through a deterministic
 * runtime materializer. The materializer may emit a native tool call only when
 * every required argument is provable from the tool schema, the user's request,
 * or authoritative prior tool results. Otherwise the existing hardened Qwen
 * required-tool path remains the fallback and fails closed.
 *
 * Pure model-conformance requests are unaffected because deterministic
 * materialization is activated only for execution obligations inferred from the
 * user's agent request, never for a bare requiredToolName supplied by the caller.
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
    const obligation = routeExecutionObligation(request);
    if (obligation) {
      const materialized = materializeExecutionObligation(request, obligation);
      if (materialized) return deterministicToolResult(materialized);
    }

    const routedRequest = withExecutionObligation(request, obligation);
    const first = await this.inner.generate(routedRequest);
    assertCompleteModelResult(first);

    // Once an explicit obligation has succeeded, prevent the model from spinning
    // on the exact same successful call. A retryable result is deliberately not
    // suppressed, and an identical read after an intervening mutation is not the
    // latest tool result so it remains allowed.
    if (!obligation && isRedundantLatestSuccessfulCall(request, first)) {
      return finalizeAfterRedundantCall(this.inner, request, first);
    }

    const firstIntent = recoveryIntent(routedRequest, first);
    if (!firstIntent) return first;

    const secondRequest = recoveryRequest(routedRequest, first, firstIntent);
    const second = await this.inner.generate(secondRequest);
    assertCompleteModelResult(second);
    assertRequiredRecoveryTool(secondRequest, second);
    if (recoveryIntent(secondRequest, second)) throw new Error("tool_call_required_but_missing");
    return mergeUsage(first, second);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    if (request.tools !== undefined) {
      const result = await this.generate(request);
      if (result.content) await onDelta(result.content);
      return result;
    }

    if (this.inner.generateStreamed) {
      const result = await this.inner.generateStreamed(request, onDelta);
      assertCompleteModelResult(result);
      return result;
    }
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
