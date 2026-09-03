import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelProtocolProfile,
  ModelStreamDeltaHandler,
  ModelToolDefinition
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { GenericOpenAiCompatibleAdapter } from "./generic-openai-compatible-adapter";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";
import { StrictToolProtocolOpenAiCompatibleAdapter } from "./strict-tool-protocol-openai-compatible-adapter";

type Fetch = typeof fetch;

function qwenNativeRequiredToolFetcher(fetcher: Fetch, thinking: "disabled" | "enabled" = "disabled"): Fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return fetcher(input, init);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
    } catch {
      return fetcher(input, init);
    }

    if (Array.isArray(body.tools) && body.tools.length === 1 && body.tool_choice) {
      body.tool_choice = "required";
      body.cache_prompt = true;
      body.stream = false;
      if (thinking === "disabled") {
        body.reasoning_effort = "none";
        body.chat_template_kwargs = { enable_thinking: false };
      } else {
        delete body.reasoning_effort;
        body.chat_template_kwargs = { enable_thinking: true };
      }
    }

    return fetcher(input, { ...init, body: JSON.stringify(body) });
  }) as Fetch;
}

function requiredToolRequest(request: GenerateRequest): GenerateRequest | null {
  const requiredToolName = request.requiredToolName?.trim();
  if (!requiredToolName) return null;

  const requiredTool = request.tools?.find((tool) => tool.name === requiredToolName);
  if (!requiredTool) throw new Error(`required_tool_definition_missing:${requiredToolName}`);

  return {
    ...request,
    tools: [requiredTool],
    temperature: 0,
    disableThinking: true
  };
}

function isRequiredToolMismatch(error: unknown, requiredToolName: string): boolean {
  return error instanceof Error && error.message === `required_tool_call_mismatch:${requiredToolName}`;
}

function requiredToolDefinition(request: GenerateRequest): ModelToolDefinition | null {
  const name = request.requiredToolName?.trim();
  if (!name) return null;
  return request.tools?.find((tool) => tool.name === name) ?? null;
}

function isSingletonPropertySchema(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const property = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(property, "const")) return true;
  return Array.isArray(property.enum) && property.enum.length === 1;
}

function latestAuthoritativeToolResult(request: GenerateRequest): Record<string, unknown> | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "tool") continue;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the only schema-grammar fallback we permit after llama.cpp/Qwen ignored
 * an explicit required tool twice.
 *
 * The fallback stays fail-closed:
 * - every top-level argument is required and additional properties are forbidden;
 * - already-singleton arguments keep their existing deterministic constraint;
 * - a free string argument is allowed only when the most recent runtime tool
 *   result contains the same field name with an exact string value;
 * - that authoritative value is converted into a one-value enum before the
 *   grammar request is sent, so the model cannot invent or transform evidence.
 *
 * This supports exact tool-result continuation without turning arbitrary user,
 * web, repository, or model text into executable tool arguments.
 */
function deterministicSchemaFallbackRequest(request: GenerateRequest): GenerateRequest | null {
  const tool = requiredToolDefinition(request);
  if (!tool) return null;
  const schema = tool.inputSchema as Record<string, unknown>;
  if (schema.type !== "object" || schema.additionalProperties !== false) return null;
  if (!Array.isArray(schema.required) || !schema.required.length) return null;
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return null;

  const required = schema.required.filter((value): value is string => typeof value === "string");
  if (required.length !== schema.required.length) return null;
  const properties = schema.properties as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length !== required.length) return null;
  if (keys.some((key) => !required.includes(key))) return null;

  const authoritative = latestAuthoritativeToolResult(request);
  const constrainedProperties: Record<string, unknown> = {};
  let copiedFromToolResult = false;

  for (const key of required) {
    const rawProperty = properties[key];
    if (!rawProperty || typeof rawProperty !== "object" || Array.isArray(rawProperty)) return null;
    const property = rawProperty as Record<string, unknown>;

    if (isSingletonPropertySchema(property)) {
      constrainedProperties[key] = property;
      continue;
    }

    if (property.type !== "string" || !authoritative) return null;
    const authoritativeValue = authoritative[key];
    if (typeof authoritativeValue !== "string") return null;
    if (Array.isArray(property.enum) && !property.enum.includes(authoritativeValue)) return null;

    constrainedProperties[key] = { ...property, enum: [authoritativeValue] };
    copiedFromToolResult = true;
  }

  if (!required.every((key) => isSingletonPropertySchema(constrainedProperties[key]))) return null;

  const constrainedTool: ModelToolDefinition = {
    ...tool,
    inputSchema: {
      ...schema,
      properties: constrainedProperties
    }
  };

  // Pure singleton contracts are already deterministic. Evidence-copy contracts
  // are deterministic only because copied fields were bound to the runtime result.
  if (!copiedFromToolResult && required.some((key) => !isSingletonPropertySchema(properties[key]))) return null;

  return {
    ...request,
    tools: [constrainedTool]
  };
}

/**
 * Keeps the hardened Qwen Strict/Execution/Security stack for ordinary traffic,
 * while explicit portable requiredToolName requests use llama.cpp's native
 * OpenAI-compatible tool protocol. Native mode preserves assistant tool_calls
 * and role=tool history, which is required for grounded multi-turn tool
 * continuation.
 *
 * Some llama.cpp/Qwen chat-template combinations accept tool_choice=required but
 * do not enforce it. Required-tool traffic therefore tries native no-thinking,
 * then one native thinking-enabled retry. If both are ignored, only arguments
 * that are already deterministic (singleton schema values or exact same-key
 * strings from the latest runtime tool result) may use the Qwen json_schema
 * grammar path. Everything else remains fail-closed.
 */
export class QwenRequiredToolRoutingAdapter implements ModelAdapter {
  private readonly strict: StrictToolProtocolOpenAiCompatibleAdapter;
  private readonly requiredNative: GenericOpenAiCompatibleAdapter;
  private readonly requiredNativeThinkingFallback: GenericOpenAiCompatibleAdapter;
  private readonly requiredSchemaFallback: OpenAiCompatibleAdapter;

  constructor(
    baseUrl: string,
    apiKey: string,
    profile: ModelProtocolProfile,
    fetcher: Fetch = fetch,
    admission?: AdmissionController
  ) {
    this.strict = new StrictToolProtocolOpenAiCompatibleAdapter(baseUrl, apiKey, fetcher, admission);
    const nativeProfile = {
      runtimeModel: profile.runtimeModel,
      modelVersionId: profile.modelVersionId,
      capabilities: profile.capabilities
    };
    this.requiredNative = new GenericOpenAiCompatibleAdapter(
      baseUrl,
      apiKey,
      nativeProfile,
      qwenNativeRequiredToolFetcher(fetcher, "disabled"),
      admission
    );
    this.requiredNativeThinkingFallback = new GenericOpenAiCompatibleAdapter(
      baseUrl,
      apiKey,
      nativeProfile,
      qwenNativeRequiredToolFetcher(fetcher, "enabled"),
      admission
    );
    this.requiredSchemaFallback = new OpenAiCompatibleAdapter(baseUrl, apiKey, fetcher, admission);
  }

  getCapabilities(): ReadonlySet<ModelCapability> {
    return this.strict.getCapabilities();
  }

  estimateTokens(text: string): Promise<number> {
    return this.strict.estimateTokens(text);
  }

  healthCheck(): Promise<ModelHealth> {
    return this.strict.healthCheck();
  }

  private async generateRequired(nativeRequest: GenerateRequest): Promise<GenerateResult> {
    const requiredToolName = nativeRequest.requiredToolName?.trim();
    if (!requiredToolName) return this.requiredNative.generate(nativeRequest);
    try {
      return await this.requiredNative.generate(nativeRequest);
    } catch (error) {
      if (!isRequiredToolMismatch(error, requiredToolName)) throw error;
      try {
        return await this.requiredNativeThinkingFallback.generate(nativeRequest);
      } catch (retryError) {
        if (!isRequiredToolMismatch(retryError, requiredToolName)) throw retryError;
        const fallbackRequest = deterministicSchemaFallbackRequest(nativeRequest);
        if (!fallbackRequest) throw retryError;
        return this.requiredSchemaFallback.generate(fallbackRequest);
      }
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const nativeRequest = requiredToolRequest(request);
    return nativeRequest ? this.generateRequired(nativeRequest) : this.strict.generate(request);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    const nativeRequest = requiredToolRequest(request);
    if (!nativeRequest) return this.strict.generateStreamed(request, onDelta);
    const result = await this.generateRequired(nativeRequest);
    if (result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const nativeRequest = requiredToolRequest(request);
    if (!nativeRequest) {
      yield* this.strict.stream(request);
      return;
    }
    const result = await this.generateRequired(nativeRequest);
    if (result.content) yield result.content;
  }
}
