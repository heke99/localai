export type ModelCapability = "general" | "reasoning" | "coding" | "security" | "research" | "long_context" | "tool_use" | "verification";
export type ModelAlias = "general-prod" | "code-prod" | "lab-prod" | "reasoner-prod" | "research-prod" | "verifier-prod";

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
}

export interface GenerateResult {
  modelVersionId: string;
  content: string;
  finishReason: "stop" | "length" | "tool_call" | "error";
  toolCalls?: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export interface ModelHealth { ok: boolean; latencyMs: number; detail?: string }

export interface ModelAdapter {
  generate(request: GenerateRequest): Promise<GenerateResult>;
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
  quantization: "Q8_0";
  tokenizerSha256: string;
  chatTemplateSha256: string;
  license: string;
  contextWindow: number;
  capabilities: ModelCapability[];
  runtime: { adapter: "llama.cpp-openai"; containerDigest: string | null; cudaVersion: string | null };
  lifecycle: "registered" | "verified" | "canary" | "production" | "retired";
}
