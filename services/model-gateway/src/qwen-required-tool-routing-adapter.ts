import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelProtocolProfile,
  ModelStreamDeltaHandler
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { GenericOpenAiCompatibleAdapter } from "./generic-openai-compatible-adapter";
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

/**
 * Keeps the hardened Qwen Strict/Execution/Security stack for ordinary traffic,
 * while explicit portable requiredToolName requests use llama.cpp's native
 * OpenAI-compatible tool protocol. Native mode preserves assistant tool_calls
 * and role=tool history, which is required for grounded multi-turn tool
 * continuation.
 *
 * Some llama.cpp Qwen chat-template builds accept tool_choice=required but fail
 * to enforce it when enable_thinking=false. Required-tool traffic therefore gets
 * one bounded retry with thinking enabled only after the provider has returned a
 * structurally invalid/missing required call. The same one-tool exposure and
 * exact response validation remain in force on the retry.
 */
export class QwenRequiredToolRoutingAdapter implements ModelAdapter {
  private readonly strict: StrictToolProtocolOpenAiCompatibleAdapter;
  private readonly requiredNative: GenericOpenAiCompatibleAdapter;
  private readonly requiredNativeThinkingFallback: GenericOpenAiCompatibleAdapter;

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
      return this.requiredNativeThinkingFallback.generate(nativeRequest);
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
