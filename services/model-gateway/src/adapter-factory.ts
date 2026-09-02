import type { ModelAdapter, ModelCapability, ModelInferenceProtocol, ModelProtocolProfile } from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { GenericOpenAiCompatibleAdapter } from "./generic-openai-compatible-adapter";
import { QwenRequiredToolRoutingAdapter } from "./qwen-required-tool-routing-adapter";
import { QWEN_Q8, QWEN_RUNTIME_MODEL } from "./registry";
import { ToolCallRecoveryAdapter } from "./tool-call-recovery-adapter";

type Fetch = typeof fetch;
type Environment = Record<string, string | undefined>;

const CAPABILITIES = new Set<ModelCapability>([
  "general",
  "reasoning",
  "coding",
  "security",
  "research",
  "long_context",
  "tool_use",
  "verification"
]);

export interface InferenceAdapterFactoryOptions {
  baseUrl: string;
  apiKey: string;
  profile: ModelProtocolProfile;
  fetcher?: Fetch;
  admission?: AdmissionController;
}

function protocol(value: string | undefined): ModelInferenceProtocol {
  const normalized = value?.trim().toLowerCase() || "qwen-llamacpp";
  if (normalized === "qwen-llamacpp" || normalized === "generic-openai") return normalized;
  throw new Error(`unsupported_inference_protocol:${normalized}`);
}

function modelCapabilities(value: string | undefined, fallback: readonly ModelCapability[]): ModelCapability[] {
  if (!value?.trim()) return [...fallback];
  const result = [...new Set(value.split(",").map((item) => item.trim()).filter((item): item is ModelCapability => CAPABILITIES.has(item as ModelCapability)))];
  if (!result.length) throw new Error("inference_model_capabilities_required");
  return result;
}

export function modelProtocolProfileFromEnvironment(env: Environment = process.env): ModelProtocolProfile {
  const selected = protocol(env.DIV3RSA_INFERENCE_PROTOCOL);
  const runtimeModel = env.DIV3RSA_INFERENCE_MODEL_NAME?.trim()
    || env.DIV3RSA_MODEL_RUNTIME_ALIAS?.trim()
    || QWEN_RUNTIME_MODEL;
  const modelVersionId = env.DIV3RSA_INFERENCE_MODEL_VERSION_ID?.trim()
    || (selected === "qwen-llamacpp" ? QWEN_Q8.id : runtimeModel);
  const capabilities = modelCapabilities(
    env.DIV3RSA_INFERENCE_MODEL_CAPABILITIES,
    selected === "qwen-llamacpp" ? QWEN_Q8.capabilities : ["general"]
  );

  return {
    contractVersion: 1,
    protocol: selected,
    runtimeModel,
    modelVersionId,
    capabilities,
    protocolCapabilities: selected === "qwen-llamacpp"
      ? ["text_generation", "streaming", "native_tool_calls", "tool_result_continuation", "structured_json", "reasoning_control"]
      : ["text_generation", "native_tool_calls", "tool_result_continuation"]
  };
}

export function createInferenceAdapter(options: InferenceAdapterFactoryOptions): ModelAdapter {
  const fetcher = options.fetcher ?? fetch;
  const inner = options.profile.protocol === "generic-openai"
    ? new GenericOpenAiCompatibleAdapter(
        options.baseUrl,
        options.apiKey,
        {
          runtimeModel: options.profile.runtimeModel,
          modelVersionId: options.profile.modelVersionId,
          capabilities: options.profile.capabilities
        },
        fetcher,
        options.admission
      )
    : new QwenRequiredToolRoutingAdapter(
        options.baseUrl,
        options.apiKey,
        options.profile,
        fetcher,
        options.admission
      );

  // Apply the same bounded native-tool recovery regardless of direct/registry
  // routing and regardless of the underlying OpenAI-compatible model profile.
  return new ToolCallRecoveryAdapter(inner);
}
