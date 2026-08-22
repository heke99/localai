import type { ModelAlias, RegisteredModelVersion } from "@div3rsa/model-sdk";

export const QWEN_Q8: RegisteredModelVersion = {
  id: "qwen38-27b-obliterated-v2-q8-0",
  provider: "huggingface",
  repository: "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
  revision: "e335d239dbdfae590687e24b800e81a18d070ebe",
  artifact: "Qwen3.8-27B-OBLITERATED-Q8_0.gguf",
  artifactSha256: "4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c",
  artifactBytes: 29047084320,
  quantization: "Q8_0",
  tokenizerSha256: "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
  chatTemplateSha256: "1bffd744ab18e11623af60636410ca4a1f3e544c9fc52d3ddee6bf3da341419f",
  license: "apache-2.0",
  contextWindow: 262144,
  capabilities: ["general", "reasoning", "coding", "security", "research", "long_context", "tool_use", "verification"],
  runtime: { adapter: "llama.cpp-openai", containerDigest: null, cudaVersion: null },
  lifecycle: "registered"
};

export const MODEL_ALIASES: Record<ModelAlias, string> = {
  "general-prod": QWEN_Q8.id,
  "code-prod": QWEN_Q8.id,
  "lab-prod": QWEN_Q8.id,
  "reasoner-prod": QWEN_Q8.id,
  "research-prod": QWEN_Q8.id,
  "verifier-prod": QWEN_Q8.id
};

export function resolveModel(alias: ModelAlias): RegisteredModelVersion {
  const id = MODEL_ALIASES[alias];
  if (id !== QWEN_Q8.id) throw new Error(`Unregistered model version: ${id}`);
  return QWEN_Q8;
}
