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
const NONCE_PROBE_KIND = "copy-once";

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

const nonceSourceTool: ModelToolDefinition = {
  name: "probe_nonce_source",
  description: "Start a neutral two-step protocol probe. The runtime returns an opaque nonce in the tool result. The nonce has no date, time, identifier, search, or domain meaning.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["probe"],
    properties: { probe: { type: "string", enum: [NONCE_PROBE_KIND] } }
  }
};

const submitNonceTool: ModelToolDefinition = {
  name: "submit_probe_nonce",
  description: "Submit the nonce from the immediately preceding tool result. Copy the nonce field character-for-character. Do not generate, derive, normalize, reformat, prefix, suffix, or replace it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["nonce"],
    properties: {
      nonce: {
        type: "string",
        description: "Exact nonce string from the immediately preceding tool message. Copy it verbatim."
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

function matchingNonceSourceCall(result: GenerateResult): ModelToolCall | null {
  return result.toolCalls?.find((call) => call.name === nonceSourceTool.name && call.input.probe === NONCE_PROBE_KIND) ?? null;
}

function matchingNonceSubmission(result: GenerateResult, nonce: string): ModelToolCall | null {
  return result.toolCalls?.find((call) => call.name === submitNonceTool.name && call.input.nonce === nonce) ?? null;
}

function observedNonce(result: GenerateResult): string | null {
  const call = result.toolCalls?.find((candidate) => candidate.name === submitNonceTool.name);
  if (!call) return null;
  const value = call.input.nonce;
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
  const nonce = `NX_${seed}`;
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

  const clockUserPrompt = `Use the current_time runtime tool for ${CONFORMANCE_TIMEZONE}. Do not answer before the runtime tool result arrives.`;
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
        { role: "user", content: clockUserPrompt }
      ],
      tools: [currentTimeTool]
    });
    const failures: string[] = [];
    const acceptedToolCall = matchingCurrentTimeCall(result);
    if (result.finishReason !== "tool_call") failures.push(`finish_reason_not_tool_call:${result.finishReason}`);
    if (!acceptedToolCall) failures.push("native_tool_call_missing_or_invalid");
    if ((result.toolCalls?.length ?? 0) !== 1) failures.push(`tool_call_count:${result.toolCalls?.length ?? 0}`);
    if (result.content && /<tool_call\b|<function=|<parameter=/i.test(result.content)) failures.push("textual_tool_protocol_exposed");
    if (hiddenReasoningExposed(result)) failures.push("hidden_reasoning_exposed");
    if (result.modelVersionId !== profile.modelVersionId) failures.push(`model_version_mismatch:${result.modelVersionId}`);
    return { failures, modelVersionId: result.modelVersionId };
  }));

  results.push(await probe("tool-result-continuation", async () => {
    const sourcePrompt = "Call probe_nonce_source to start the neutral copy probe. Do not create a nonce yourself; wait for the runtime tool result.";
    const sourceResult = await adapter.generate({
      requestId: `conformance-nonce-source-${seed}`,
      alias,
      temperature: 0,
      maxOutputTokens: 128,
      disableThinking: true,
      requiredToolName: nonceSourceTool.name,
      messages: [
        {
          role: "system",
          content: "This is a neutral two-step tool-result protocol probe. Call only the required source tool and wait for its runtime result."
        },
        { role: "user", content: sourcePrompt }
      ],
      tools: [nonceSourceTool]
    });

    const failures: string[] = [];
    const sourceCall = matchingNonceSourceCall(sourceResult);
    if (sourceResult.finishReason !== "tool_call") failures.push(`nonce_source_finish_reason_not_tool_call:${sourceResult.finishReason}`);
    if (!sourceCall) failures.push("nonce_source_tool_missing_or_invalid");
    if ((sourceResult.toolCalls?.length ?? 0) !== 1) failures.push(`nonce_source_tool_call_count:${sourceResult.toolCalls?.length ?? 0}`);
    if (sourceResult.content && /<tool_call\b|<function=|<parameter=/i.test(sourceResult.content)) failures.push("nonce_source_textual_tool_protocol_exposed");
    if (hiddenReasoningExposed(sourceResult)) failures.push("nonce_source_hidden_reasoning_exposed");
    if (sourceResult.modelVersionId !== profile.modelVersionId) failures.push(`nonce_source_model_version_mismatch:${sourceResult.modelVersionId}`);
    if (!sourceCall) return { failures, modelVersionId: sourceResult.modelVersionId };

    const result = await adapter.generate({
      requestId: `conformance-nonce-submit-${seed}`,
      alias,
      temperature: 0,
      maxOutputTokens: 128,
      disableThinking: true,
      requiredToolName: submitNonceTool.name,
      messages: [
        {
          role: "system",
          content: "This is a neutral tool-result copy probe. The immediately preceding tool message is authoritative. Call submit_probe_nonce and copy its nonce field exactly into the nonce argument. Do not create or infer a nonce."
        },
        { role: "user", content: sourcePrompt },
        { role: "assistant", content: "", toolCalls: [sourceCall] },
        { role: "tool", name: nonceSourceTool.name, toolCallId: sourceCall.id, content: JSON.stringify({ nonce }) },
        {
          role: "user",
          content: "Read the nonce field from the immediately preceding tool message and call submit_probe_nonce now. Copy the exact string unchanged."
        }
      ],
      tools: [submitNonceTool]
    });

    const nonceCall = matchingNonceSubmission(result, nonce);
    if (result.finishReason !== "tool_call") failures.push(`nonce_finish_reason_not_tool_call:${result.finishReason}`);
    if (!nonceCall) {
      failures.push("tool_result_nonce_missing");
      const observed = observedNonce(result);
      if (observed !== null) failures.push(`tool_result_nonce_observed:${observed}`);
    }
    if ((result.toolCalls?.length ?? 0) !== 1) failures.push(`nonce_tool_call_count:${result.toolCalls?.length ?? 0}`);
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
