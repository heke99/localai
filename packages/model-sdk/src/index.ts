export type ModelCapability = "general" | "reasoning" | "coding" | "security" | "research" | "long_context" | "tool_use" | "verification";
export type ModelAlias = "general-prod" | "code-prod" | "lab-prod" | "reasoner-prod" | "research-prod" | "verifier-prod";

/**
 * Wire-level model protocol. Agent/task code must depend on ModelAdapter, never on
 * a protocol implementation or a concrete model family.
 */
export type ModelInferenceProtocol = "qwen-llamacpp" | "generic-openai";
export type ModelProtocolCapability =
  | "text_generation"
  | "streaming"
  | "native_tool_calls"
  | "tool_result_continuation"
  | "structured_json"
  | "reasoning_control";

export interface ModelProtocolProfile {
  contractVersion: 1;
  protocol: ModelInferenceProtocol;
  runtimeModel: string;
  modelVersionId: string;
  capabilities: ModelCapability[];
  protocolCapabilities: ModelProtocolCapability[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ModelToolCall[];
}

export interface GenerateRequest {
  requestId: string;
  alias: ModelAlias;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  tools?: ModelToolDefinition[];
  /**
   * Require exactly this currently exposed tool on this generation turn.
   * Adapters must fail closed when the named tool is not present in `tools`.
   * Tool selection policy remains outside concrete model families while each
   * protocol adapter owns the wire-level mechanism used to enforce the call.
   */
  requiredToolName?: string;
  signal?: AbortSignal;
  /** Disable hidden model thinking for short machine-readable/internal calls only. */
  disableThinking?: boolean;
}

export interface GenerateResult {
  modelVersionId: string;
  content: string;
  finishReason: "stop" | "length" | "tool_call" | "error";
  toolCalls?: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export type ModelStreamDeltaHandler = (delta: string) => void | Promise<void>;

export interface ModelHealth { ok: boolean; latencyMs: number; detail?: string }

export interface ModelAdapter {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  generateStreamed?(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<string>;
  estimateTokens(text: string): Promise<number>;
  getCapabilities(): ReadonlySet<ModelCapability>;
  healthCheck(): Promise<ModelHealth>;
}

export interface StructuredOutputRequest extends GenerateRequest {
  schema: Record<string, unknown>;
}

export interface ModelProviderCapabilities {
  modelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ReadonlySet<ModelCapability>;
  toolCallSupport: boolean;
  structuredOutputSupport: boolean;
  reasoningSupport: boolean;
}

export interface ModelProvider {
  readonly key: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<string>;
  toolCall(request: GenerateRequest): Promise<GenerateResult>;
  structuredOutput<T>(request: StructuredOutputRequest): Promise<{ value: T; raw: GenerateResult }>;
  reason(request: GenerateRequest): Promise<GenerateResult>;
  capabilities(): Promise<ModelProviderCapabilities>;
  health(): Promise<ModelHealth>;
}

export function modelProviderFromAdapter(key: string, modelId: string, adapter: ModelAdapter): ModelProvider {
  return {
    key,
    generate: (request) => adapter.generate(request),
    stream: (request) => adapter.stream(request),
    toolCall: (request) => adapter.generate(request),
    async structuredOutput<T>(request: StructuredOutputRequest) {
      const raw = await adapter.generate(request);
      try { return { value: JSON.parse(raw.content) as T, raw }; }
      catch { throw new Error("structured_output_parse_failed"); }
    },
    reason: (request) => adapter.generate(request),
    async capabilities() {
      const capabilities = adapter.getCapabilities();
      return {
        modelId,
        capabilities,
        toolCallSupport: capabilities.has("tool_use"),
        structuredOutputSupport: capabilities.has("tool_use") || capabilities.has("reasoning"),
        reasoningSupport: capabilities.has("reasoning")
      };
    },
    health: () => adapter.healthCheck()
  };
}

export interface RegisteredModelVersion {
  id: string;
  provider: string;
  repository: string;
  revision: string;
  artifact: string;
  artifactSha256: string;
  artifactBytes: number;
  /** Runtime-native quantization or precision label, e.g. Q8_0, Q6_K, BF16. */
  quantization: string;
  tokenizerSha256: string | null;
  chatTemplateSha256: string | null;
  license: string;
  contextWindow: number;
  capabilities: ModelCapability[];
  runtime: { adapter: "llama.cpp-openai" | "openai-compatible"; containerDigest: string | null; cudaVersion: string | null };
  /** Optional portable protocol declaration; legacy registrations remain valid. */
  protocol?: ModelProtocolProfile;
  lifecycle: "registered" | "verified" | "canary" | "production" | "retired";
}
