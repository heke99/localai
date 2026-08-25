import type { ModelAlias, RegisteredModelVersion } from "@div3rsa/model-sdk";

export const QWEN_RUNTIME_MODEL = "localai-qwen38-v3-q8";

export const QWEN_Q8: RegisteredModelVersion = {
  id: "qwen38-27b-obliterated-v3-q8-0",
  provider: "huggingface",
  repository: "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
  revision: "768dd4ca58e1af3593605d93abef2c1c45647a07",
  artifact: "Qwen3.8-27B-OBLITERATED-Q8_0.gguf",
  artifactSha256: "afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221",
  artifactBytes: 29047075872,
  quantization: "Q8_0",
  // The monolithic V3 GGUF is checksum-verified. These source-level hashes are
  // intentionally left unset until the exact tokenizer/template bytes for this
  // immutable V3 revision are verified independently.
  tokenizerSha256: null,
  chatTemplateSha256: null,
  license: "apache-2.0",
  contextWindow: 262144,
  capabilities: ["general", "reasoning", "coding", "security", "research", "long_context", "tool_use", "verification"],
  runtime: { adapter: "llama.cpp-openai", containerDigest: null, cudaVersion: null },
  lifecycle: "verified"
};

export const MODEL_ALIASES: Record<ModelAlias, string> = {
  "general-prod": QWEN_Q8.id,
  "code-prod": QWEN_Q8.id,
  "lab-prod": QWEN_Q8.id,
  "reasoner-prod": QWEN_Q8.id,
  "research-prod": QWEN_Q8.id,
  "verifier-prod": QWEN_Q8.id
};

const REGISTERED_MODELS = new Map<string, RegisteredModelVersion>([[QWEN_Q8.id, QWEN_Q8]]);

export function resolveModel(alias: ModelAlias): RegisteredModelVersion {
  const id = MODEL_ALIASES[alias];
  const model = REGISTERED_MODELS.get(id);
  if (!model) throw new Error(`Unregistered model version: ${id}`);
  return model;
}

export function registerModel(model: RegisteredModelVersion): void {
  if (REGISTERED_MODELS.has(model.id)) throw new Error(`Duplicate model version: ${model.id}`);
  REGISTERED_MODELS.set(model.id, model);
}

export function assignAlias(alias: ModelAlias, modelVersionId: string): void {
  if (!REGISTERED_MODELS.has(modelVersionId)) throw new Error(`Unregistered model version: ${modelVersionId}`);
  MODEL_ALIASES[alias] = modelVersionId;
}
