import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelMessage,
  ModelStreamDeltaHandler,
  ModelToolCall
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { OpenAiCompatibleAdapter as RawOpenAiCompatibleAdapter, type InferenceWatchdogOptions } from "./openai-compatible-adapter";
import { normalizeTextualToolResult, securityToolContract } from "./textual-tool-call-normalizer";

type Fetch = typeof fetch;

function hasAnyTool(request: GenerateRequest): boolean {
  return Boolean(request.tools?.length);
}

function hasSecurityTool(request: GenerateRequest): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "security_scan"));
}

function hasSecurityToolResult(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "tool" && message.name === "security_scan");
}

function isDeterministicSecurityReadiness(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "system" && message.content.includes("SECURITY READINESS REQUIRED"));
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function requestsSecurityExecution(request: GenerateRequest): boolean {
  if (!hasSecurityTool(request)) return false;
  const text = latestUserContent(request)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/gi, " ");
  return /\b(?:säkerhetsgranska|granska|testa|kontrollera|kör|börja|utför|pentest|penetrationstest|scan|assess|audit|test|review|check|execute|run)\b/i.test(text);
}

function requestsCapabilityLimitedSecurityClass(request: GenerateRequest): boolean {
  if (!hasSecurityTool(request)) return false;
  const text = latestUserContent(request).replace(/https?:\/\/\S+/gi, " ");
  return /\b(?:BOLA|IDOR|JWT|session|token|authenticated|autentiserad|identity[- ]bound|identitetsbunden|business logic|affärslogik|checkout|price manipulation|prismanipulation|discount manipulation|rabattmanipulation)\b/i.test(text);
}

function hasCapabilityStopLanguage(content: string): boolean {
  return /(?:kan\s+inte\s+verifiera|cannot\s+verify|inte\s+verifiera|saknar.{0,40}(?:auth|credential|identitet|session|token|workflow)|missing.{0,40}(?:auth|credential|identity|session|token|workflow)|stateful|förmågegap|capability\s+gap)/i.test(content);
}

function signalsDeferredToolAction(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const commitment = /(?:\bjag\s+(?:börjar|påbörjar|startar|ska|kommer|behöver|tänker|fortsätter|byter|växlar|anpassar)\b|\bjag\s+går\s+vidare\b|\blåt\s+mig\b|\bi(?:'ll|\s+will|\s+need\s+to|\s+am\s+going\s+to|\s+continue|\s+switch|\s+adapt|\s+proceed|\s+start)\b|\blet\s+me\b)/i.test(text);
  const toolAction = /(?:undersök|inspekter|kontroller|kolla|sök|leta|läs|öppna|hämta|granska|arbetsmilj|verktyg|inspect|examine|check|search|look|read|open|fetch|review|environment|tool|\bdns\b|\btls\b|\bhttp\b|probe|scan|port)/i.test(text);
  return commitment && toolAction;
}

function withSecurityContract(request: GenerateRequest): GenerateRequest {
  const contract = securityToolContract(request.tools);
  if (!contract || request.messages.some((message) => message.role === "system" && message.content.includes("SECURITY TOOL CONTRACT V1"))) return request;
  const messages: ModelMessage[] = [{ role: "system", content: contract }, ...request.messages];
  return { ...request, messages };
}

function mergeUsage(first: GenerateResult["usage"], second: GenerateResult["usage"]): GenerateResult["usage"] {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens
  };
}

function normalizeTarget(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, stableObject(nested)]));
}

function securityCallKey(call: ModelToolCall): string | null {
  if (call.name !== "security_scan") return null;
  const tool = typeof call.input.tool === "string" ? call.input.tool.trim() : "";
  const target = normalizeTarget(call.input.target);
  if (!tool || !target) return null;
  const options = call.input.options && typeof call.input.options === "object" && !Array.isArray(call.input.options) ? call.input.options : {};
  return JSON.stringify([tool, target, stableObject(options)]);
}

function priorSecurityCallKeys(request: GenerateRequest): Set<string> {
  const keys = new Set<string>();
  for (const message of request.messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      const key = securityCallKey(call);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function duplicateSecurityCall(request: GenerateRequest, result: GenerateResult): boolean {
  if (result.finishReason !== "tool_call" || !result.toolCalls?.length) return false;
  const prior = priorSecurityCallKeys(request);
  return result.toolCalls.some((call) => {
    const key = securityCallKey(call);
    return key ? prior.has(key) : false;
  });
}

function initialRepairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: "Execution repair: you stated or implied that you would perform the authorized security assessment, but no executable function call was produced. Invoke exactly one exposed security_scan function now using the SECURITY TOOL CONTRACT V1 JSON shape. Choose the least-disruptive useful supported subtool for the current step. Do not print XML/tool markup and do not invent unsupported parameters."
      }
    ]
  };
}

function genericToolRepairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  const exposedTools = (request.tools ?? []).map((tool) => tool.name).join(", ");
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: `Execution repair: your previous response deferred action (for example, saying you would inspect the environment, switch to DNS/TLS/HTTP, or continue with another security check) but produced no executable tool call. Do not narrate another future action. Either invoke exactly one currently exposed tool now, using its schema, or give the final answer now and explicitly state any capability limitation. Exposed tools: ${exposedTools}. Do not print XML, JSON pseudo-tool markup, or invent unavailable tools.`
      }
    ]
  };
}

function duplicateRepairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content, toolCalls: previous.toolCalls },
      {
        role: "user",
        content: "Decision repair: that exact security_scan tool + target + options call already ran, so do not repeat it. Use the existing tool observations. Either invoke one materially different supported security_scan check that tests a remaining hypothesis within the same authorized scope, or stop and give a concise evidence-based conclusion. After an HTTP timeout, adapt to another useful dimension such as DNS or TLS rather than retrying the identical HTTP probe. For authenticated BOLA/IDOR, JWT/session bypass, or stateful business-logic questions, after the supported passive baseline explicitly state that the current tools cannot verify the requested class and identify the missing authenticated/session/workflow capability. Do not print pseudo-tool markup."
      }
    ]
  };
}

function capabilityStopRepairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: "Capability-stop repair: the requested security class requires authenticated identity/session/token manipulation or a stateful business workflow that the currently exposed security tools cannot perform. Use the observations already collected. Give the final answer now, explicitly say that the requested class cannot be verified with the current runtime, name the missing authenticated/session/token/workflow capability, and do not claim a vulnerability. Do not invoke web research as a substitute and do not narrate another future tool action."
      }
    ]
  };
}

/**
 * Compatibility boundary for Qwen/llama.cpp deployments that occasionally serialize a function call
 * as textual <tool_call> markup instead of OpenAI tool_calls. The bridge only accepts currently
 * exposed function names, repairs security_scan to its bounded schema, and still routes every call
 * through the normal worker authorization/runtime gates.
 */
export class SecurityAwareOpenAiCompatibleAdapter implements ModelAdapter {
  private readonly raw: RawOpenAiCompatibleAdapter;

  constructor(
    baseUrl: string,
    apiKey: string,
    fetcher: Fetch = fetch,
    admission?: AdmissionController,
    watchdog: InferenceWatchdogOptions = {}
  ) {
    this.raw = new RawOpenAiCompatibleAdapter(baseUrl, apiKey, fetcher, admission, watchdog);
  }

  getCapabilities(): ReadonlySet<ModelCapability> { return this.raw.getCapabilities(); }
  estimateTokens(text: string): Promise<number> { return this.raw.estimateTokens(text); }
  healthCheck(): Promise<ModelHealth> { return this.raw.healthCheck(); }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (isDeterministicSecurityReadiness(request)) return this.raw.generate(request);

    const prepared = withSecurityContract(request);
    const first = await this.raw.generate(prepared);
    const normalizedFirst = normalizeTextualToolResult(first, prepared.tools).result;

    if (duplicateSecurityCall(prepared, normalizedFirst)) {
      const repaired = await this.raw.generate(duplicateRepairRequest(prepared, normalizedFirst));
      const normalizedRepair = normalizeTextualToolResult(repaired, prepared.tools).result;
      return { ...normalizedRepair, usage: mergeUsage(normalizedFirst.usage, normalizedRepair.usage) };
    }

    if (normalizedFirst.finishReason === "tool_call") return normalizedFirst;

    if (requestsSecurityExecution(prepared) && !hasSecurityToolResult(prepared)) {
      const second = await this.raw.generate(initialRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = normalizeTextualToolResult(second, prepared.tools).result;
      return { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
    }

    if (hasSecurityToolResult(prepared) && requestsCapabilityLimitedSecurityClass(prepared) && !hasCapabilityStopLanguage(normalizedFirst.content)) {
      const second = await this.raw.generate(capabilityStopRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = normalizeTextualToolResult(second, prepared.tools).result;
      return { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
    }

    if (hasAnyTool(prepared) && signalsDeferredToolAction(normalizedFirst.content)) {
      const second = await this.raw.generate(genericToolRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = normalizeTextualToolResult(second, prepared.tools).result;
      if (normalizedSecond.finishReason !== "tool_call" && signalsDeferredToolAction(normalizedSecond.content)) {
        throw new Error("model_no_progress_after_tool_repair");
      }
      return { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
    }

    return normalizedFirst;
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    if (isDeterministicSecurityReadiness(request)) {
      if (this.raw.generateStreamed) return this.raw.generateStreamed(request, onDelta);
      const result = await this.raw.generate(request);
      if (result.content) await onDelta(result.content);
      return result;
    }
    if (!hasAnyTool(request)) {
      if (this.raw.generateStreamed) return this.raw.generateStreamed(request, onDelta);
      const result = await this.raw.generate(request);
      if (result.content) await onDelta(result.content);
      return result;
    }

    const result = await this.generate(request);
    if (result.finishReason !== "tool_call" && result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    if (isDeterministicSecurityReadiness(request) || !hasAnyTool(request)) {
      yield* this.raw.stream(request);
      return;
    }
    const result = await this.generate(request);
    if (result.content) yield result.content;
  }
}
