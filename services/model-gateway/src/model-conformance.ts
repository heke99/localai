import type {
  GenerateResult,
  ModelAdapter,
  ModelAlias,
  ModelCapability,
  ModelProtocolProfile,
  ModelToolCall,
  ModelToolDefinition
} from "@div3rsa/model-sdk";

export type ModelConformanceCaseId = "health" | "declared-capabilities" | "text-generation" | "native-tool-call" | "tool-result-continuation";

export interface ModelConformanceCaseResult {
  id: ModelConformanceCaseId;
  passed: boolean;
  failures: string[];
  latencyMs: number;
  modelVersionId: string | null;
}

export interface ModelConformanceReport {
  schemaVersion: 1;
  protocolContractVersion: 1;
  protocol: ModelProtocolProfile["protocol"];
  runtimeModel: string;
  expectedModelVersionId: string;
  cases: number;
  passed: number;
  failed: number;
  allowed: boolean;
  results: ModelConformanceCaseResult[];
}

export interface ModelConformanceOptions {
  alias?: ModelAlias;
  tokenSeed?: string;
  requiredCapabilities?: ModelCapability[];
}

const CONFORMANCE_TIMEZONE = "Europe/Stockholm";
const currentTimeTool: ModelToolDefinition = {
  name: "current_time",
  description: "Return the current date and time for an IANA timezone. This deterministic runtime-required tool is used to verify native tool-call wire compatibility.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["timezone"],
    properties: { timezone: { type: "string", enum: [CONFORMANCE_TIMEZONE] } }
  }
};

const recordToolResultTool: ModelToolDefinition = {
  name: "record_tool_result",
  description: "Record the opaque continuationToken from the immediately preceding authoritative tool result. Copy only that field value verbatim; never substitute a timestamp, timezone, placeholder, or derived value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["continuationToken"],
    properties: {
      continuationToken: {
        type: "string",
        description: "Verbatim continuationToken string from the immediately preceding tool message. Copy character-for-character and do not derive or normalize it."
      }
    }
  }
};

function hiddenReasoningExposed(result: GenerateResult): boolean {
  return /<think\b|<\/think>/i.test(result.content);
}

function matchingCurrentTimeCall(result: GenerateResult): ModelToolCall | null {
  return result.toolCalls?.find((call) => call.name === currentTimeTool.name && call.input.timezone === CONFORMANCE_TIMEZONE) ?? null;
}

function matchingContinuationCall(result: GenerateResult, continuationToken: string): ModelToolCall | null {
  return result.toolCalls?.find((call) => call.name === recordToolResultTool.name && call.input.continuationToken === continuationToken) ?? null;
}

function observedContinuationToken(result: GenerateResult): string | null {
  const call = result.toolCalls?.find((candidate) => candidate.name === recordToolResultTool.name);
  if (!call) return null;
  const value = call.input.continuationToken;
  if (typeof value !== "string") return value == null ? null : String(value);
  return value.slice(0, 160);
}

async function probe(id: ModelConformanceCaseId, operation: () => Promise<{ failures: string[]; modelVersionId?: string | null }>): Promise<ModelConformanceCaseResult> {
  const started = performance.now();
  try {
    const value = await operation();
    return {
      id,
      passed: value.failures.length === 0,
      failures: value.failures,
      latencyMs: Math.round(performance.now() - started),
      modelVersionId: value.modelVersionId ?? null
    };
  } catch (error) {
    return {
      id,
      passed: false,
      failures: [error instanceof Error ? error.message : "conformance_probe_failed"],
      latencyMs: Math.round(performance.now() - started),
      modelVersionId: null
    };
  }
}

export async function runModelConformance(
  adapter: ModelAdapter,
  profile: ModelProtocolProfile,
  options: ModelConformanceOptions = {}
): Promise<ModelConformanceReport> {
  const alias = options.alias ?? "general-prod";
  const seed = (options.tokenSeed ?? `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "probe";
  const textToken = `MODEL_CONFORMANCE_TEXT_${seed}`;
  const continuationToken = `MODEL_CONFORMANCE_CONTINUATION_${seed}`;
  const requiredCapabilities = options.requiredCapabilities ?? ["general", "tool_use"];
  const results: ModelConformanceCaseResult[] = [];

  results.push(await probe("health", async () => {
    const health = await adapter.healthCheck();
    return { failures: health.ok ? [] : [`model_unhealthy:${health.detail ?? "unknown"}`] };
  }));

  results.push(await probe("declared-capabilities", async () => {
    const capabilities = adapter.getCapabilities();
    const failures = requiredCapabilities.filter((capability) => !capabilities.has(capability)).map((capability) => `capability_missing:${capability}`);
    return { failures };
  }));

  results.push(await probe("text-generation", async () => {
    const result = await adapter.generate({
      requestId: `conformance-text-${seed}`,
      alias,
      temperature: 0,
      maxOutputTokens: 64,
      disableThinking: true,
      messages: [
        { role: "system", content: "This is a model protocol conformance probe. Follow the requested output exactly and do not call tools." },
        { role: "user", content: `Reply with exactly this token and nothing else: ${textToken}` }
      ]
    });
    const failures: string[] = [];
    if (result.content.trim() !== textToken) failures.push("text_exact_output_failed");
    if (result.finishReason === "tool_call" || result.toolCalls?.length) failures.push("unexpected_tool_call");
    if (hiddenReasoningExposed(result)) failures.push("hidden_reasoning_exposed");
    if (result.modelVersionId !== profile.modelVersionId) failures.push(`model_version_mismatch:${result.modelVersionId}`);
    return { failures, modelVersionId: result.modelVersionId };
  }));

  let acceptedToolCall: ModelToolCall | null = null;
  const toolUserPrompt = [
    `Run the current_time runtime tool for ${CONFORMANCE_TIMEZONE} as step 1 of a protocol probe.`,
    "Do not answer with the date or time.",
    "After the tool result arrives, the next step will copy only its continuationToken field into record_tool_result."
  ].join(" ");
  results.push(await probe("native-tool-call", async () => {
    const result = await adapter.generate({
      requestId: `conformance-tool-${seed}`,
      alias,
      temperature: 0,
      maxOutputTokens: 128,
      disableThinking: true,
      requiredToolName: currentTimeTool.name,
      messages: [
        { role: "system", content: "This is a deterministic model protocol conformance probe. Use the required native runtime function. Do not print XML, pseudo tool markup, or a prose answer before the tool result arrives." },
        { role: "user", content: toolUserPrompt }
      ],
      tools: [currentTimeTool]
    });
    const failures: string[] = [];
    acceptedToolCall = matchingCurrentTimeCall(result);
    if (result.finishReason !== "tool_call") failures.push(`finish_reason_not_tool_call:${result.finishReason}`);
    if (!acceptedToolCall) failures.push("native_tool_call_missing_or_invalid");
    if ((result.toolCalls?.length ?? 0) !== 1) failures.push(`tool_call_count:${result.toolCalls?.length ?? 0}`);
    if (result.content && /<tool_call\b|<function=|<parameter=/i.test(result.content)) failures.push("textual_tool_protocol_exposed");
    if (result.modelVersionId !== profile.modelVersionId) failures.push(`model_version_mismatch:${result.modelVersionId}`);
    return { failures, modelVersionId: result.modelVersionId };
  }));

  results.push(await probe("tool-result-continuation", async () => {
    if (!acceptedToolCall) return { failures: ["tool_call_prerequisite_failed"] };
    const result = await adapter.generate({
      requestId: `conformance-continuation-${seed}`,
      alias,
      temperature: 0,
      maxOutputTokens: 128,
      disableThinking: true,
      requiredToolName: recordToolResultTool.name,
      messages: [
        {
          role: "system",
          content: "This is a tool-result continuation protocol probe, not a date/time question. The immediately preceding tool message is authoritative. Call record_tool_result and copy only its continuationToken field value verbatim into the continuationToken argument. Do not use or derive any other value."
        },
        { role: "user", content: toolUserPrompt },
        { role: "assistant", content: "", toolCalls: [acceptedToolCall] },
        { role: "tool", name: currentTimeTool.name, toolCallId: acceptedToolCall.id, content: JSON.stringify({ continuationToken }) },
        {
          role: "user",
          content: "Read the continuationToken field from the immediately preceding tool message and call record_tool_result now. Copy that exact string character-for-character. Do not answer with time, do not invent a value, and do not normalize it."
        }
      ],
      tools: [recordToolResultTool]
    });
    const failures: string[] = [];
    const continuationCall = matchingContinuationCall(result, continuationToken);
    if (result.finishReason !== "tool_call") failures.push(`continuation_finish_reason_not_tool_call:${result.finishReason}`);
    if (!continuationCall) {
      failures.push("tool_result_token_missing");
      const observed = observedContinuationToken(result);
      if (observed !== null) failures.push(`tool_result_token_observed:${observed}`);
    }
    if ((result.toolCalls?.length ?? 0) !== 1) failures.push(`continuation_tool_call_count:${result.toolCalls?.length ?? 0}`);
    if (result.content && /<tool_call\b|<function=|<parameter=/i.test(result.content)) failures.push("textual_tool_protocol_exposed");
    if (hiddenReasoningExposed(result)) failures.push("hidden_reasoning_exposed");
    if (result.modelVersionId !== profile.modelVersionId) failures.push(`model_version_mismatch:${result.modelVersionId}`);
    return { failures, modelVersionId: result.modelVersionId };
  }));

  const passed = results.filter((result) => result.passed).length;
  return {
    schemaVersion: 1,
    protocolContractVersion: 1,
    protocol: profile.protocol,
    runtimeModel: profile.runtimeModel,
    expectedModelVersionId: profile.modelVersionId,
    cases: results.length,
    passed,
    failed: results.length - passed,
    allowed: passed === results.length,
    results
  };
}
