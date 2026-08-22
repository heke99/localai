export type ModelCapability = "general" | "reasoning" | "coding" | "security" | "research" | "long_context" | "tool_use" | "verification";
export type ModelAlias = "general-prod" | "code-prod" | "lab-prod" | "reasoner-prod" | "research-prod" | "verifier-prod";

export interface GenerateRequest {
  requestId: string;
  alias: ModelAlias;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  maxOutputTokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface GenerateResult {
  modelVersionId: string;
  content: string;
  finishReason: "stop" | "length" | "tool_call" | "error";
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
