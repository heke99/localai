import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelCapability,
  ModelHealth,
  ModelMessage,
  ModelStreamDeltaHandler,
  ModelToolCall,
  ModelToolDefinition
} from "@div3rsa/model-sdk";
import type { AdmissionController } from "./admission-control";
import { OpenAiCompatibleAdapter as RawOpenAiCompatibleAdapter, type InferenceWatchdogOptions } from "./openai-compatible-adapter";
import { normalizeTextualToolResult, securityToolContract } from "./textual-tool-call-normalizer";

type Fetch = typeof fetch;
type SecurityOperation = "dns_lookup" | "http_probe" | "tls_probe" | "port_scan" | "template_scan" | "content_discovery";

const SECURITY_OPERATIONS = new Set<SecurityOperation>(["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"]);

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

function hasMalformedToolMarkup(content: string): boolean {
  return /<\/?tool_call\b|<function=|<\/?parameter=/i.test(content);
}

function securityDefinition(request: GenerateRequest): ModelToolDefinition | undefined {
  return request.tools?.find((tool) => tool.name === "security_scan");
}

function plannedSecurityOperations(request: GenerateRequest): SecurityOperation[] {
  const description = securityDefinition(request)?.description ?? "";
  const line = /Executable security plan:\s*([^\n.]+)/i.exec(description)?.[1] ?? "";
  const operations: SecurityOperation[] = [];
  for (const match of line.matchAll(/\d+:([a-z_]+)/gi)) {
    const operation = match[1] as SecurityOperation;
    if (SECURITY_OPERATIONS.has(operation) && !operations.includes(operation)) operations.push(operation);
  }
  return operations;
}

interface ExecutedSecurityCall {
  call: ModelToolCall;
  operation: SecurityOperation;
  target: string;
  result: string;
}

function executedSecurityCalls(request: GenerateRequest): ExecutedSecurityCall[] {
  const toolResults = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === "tool" && message.name === "security_scan" && message.toolCallId) {
      toolResults.set(message.toolCallId, message.content ?? "");
    }
  }
  const calls: ExecutedSecurityCall[] = [];
  for (const message of request.messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      if (call.name !== "security_scan" || !toolResults.has(call.id)) continue;
      const operation = typeof call.input.tool === "string" ? call.input.tool as SecurityOperation : null;
      const target = typeof call.input.target === "string" ? call.input.target.trim() : "";
      if (!operation || !SECURITY_OPERATIONS.has(operation) || !target) continue;
      calls.push({ call, operation, target, result: toolResults.get(call.id) ?? "" });
    }
  }
  return calls;
}

function executionStateInstruction(request: GenerateRequest): string | null {
  const executed = executedSecurityCalls(request);
  if (!executed.length) return null;
  const plan = plannedSecurityOperations(request);
  const executedSet = new Set(executed.map((item) => item.operation));
  const remaining = plan.filter((operation) => !executedSet.has(operation));
  const evidence = executed.map((item, index) => {
    const compact = item.result.replace(/\s+/g, " ").trim().slice(0, 1200) || "<empty tool result>";
    return `${index + 1}. ${item.operation} target=${item.target} result=${compact}`;
  }).join("\n");
  return [
    "SECURITY EXECUTION STATE V1",
    `Executed operations backed by tool results: ${[...executedSet].join(", ")}.`,
    `Authoritative remaining executable plan: ${remaining.join(" -> ") || "none"}.`,
    "Only operations listed as executed above may be described as having produced evidence. Never invent status codes, ports, certificates, paths, scanner results, or completed checks for an operation that is not in the executed set.",
    remaining.length
      ? "If the assessment is not capability-limited, continue with the next remaining planned operation before giving a completion claim."
      : "The executable plan is complete; give a concise evidence-grounded conclusion and do not narrate another future tool action.",
    "Observed tool evidence:",
    evidence
  ].join("\n");
}

function withSecurityContract(request: GenerateRequest): GenerateRequest {
  const additions: ModelMessage[] = [];
  const contract = securityToolContract(request.tools);
  if (contract && !request.messages.some((message) => message.role === "system" && message.content.includes("SECURITY TOOL CONTRACT V1"))) {
    additions.push({ role: "system", content: contract });
  }
  const state = executionStateInstruction(request);
  if (state && !request.messages.some((message) => message.role === "system" && message.content.includes("SECURITY EXECUTION STATE V1"))) {
    additions.push({ role: "system", content: state });
  }
  return additions.length ? { ...request, messages: [...additions, ...request.messages] } : request;
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

function nextPlannedOperation(request: GenerateRequest): SecurityOperation | null {
  const plan = plannedSecurityOperations(request);
  if (!plan.length) return null;
  const executed = new Set(executedSecurityCalls(request).map((item) => item.operation));
  return plan.find((operation) => !executed.has(operation)) ?? null;
}

function alignToolCallToPlan(request: GenerateRequest, result: GenerateResult): GenerateResult {
  if (result.finishReason !== "tool_call" || !result.toolCalls?.length) return result;
  const next = nextPlannedOperation(request);
  if (!next) return result;
  const securityCall = result.toolCalls.find((call) => call.name === "security_scan");
  if (!securityCall) return result;
  const target = typeof securityCall.input.target === "string" ? securityCall.input.target.trim() : "";
  const selected = typeof securityCall.input.tool === "string" ? securityCall.input.tool : "";
  if (!target || selected === next) return result;
  return {
    ...result,
    content: "",
    toolCalls: [{
      id: securityCall.id || `security-plan-${next}`,
      name: "security_scan",
      input: { tool: next, target, options: {} }
    }]
  };
}

function plannedContinuation(request: GenerateRequest, previous: GenerateResult): GenerateResult | null {
  if (!hasSecurityToolResult(request) || requestsCapabilityLimitedSecurityClass(request)) return null;
  const next = nextPlannedOperation(request);
  if (!next) return null;
  const executed = executedSecurityCalls(request);
  const target = executed.at(-1)?.target ?? "";
  if (!target) return null;
  return {
    ...previous,
    content: "",
    finishReason: "tool_call",
    toolCalls: [{ id: `security-plan-continuation-${executed.length + 1}`, name: "security_scan", input: { tool: next, target, options: {} } }]
  };
}

function ungroundedExecutionClaim(request: GenerateRequest, content: string): boolean {
  const executed = new Set(executedSecurityCalls(request).map((item) => item.operation));
  if (!executed.size || !content.trim()) return false;
  const plan = plannedSecurityOperations(request);
  const broadCompletion = /(?:alla\s+(?:passiva\s+och\s+aktiva\s+)?kontroller\s+(?:är\s+)?avklarade|all\s+(?:passive\s+and\s+active\s+)?checks\s+(?:are\s+)?complete)/i.test(content);
  if (broadCompletion && plan.some((operation) => !executed.has(operation))) return true;
  const claims: Array<[SecurityOperation, RegExp]> = [
    ["dns_lookup", /\bDNS\b\s*(?:resultat|result|[:=-])/i],
    ["http_probe", /\bHTTP\b\s*(?:probe|prov)?\s*[:=-]|\bHTTP\b.{0,40}\b(?:status|gav|returned)\b/i],
    ["tls_probe", /\bTLS\b\s*[:=-]|\bcertifikat\b.{0,50}(?:CN=|självsign|verification|verified)/i],
    ["port_scan", /\b(?:portar|ports?)\b\s*[:=-]\s*\d/i],
    ["template_scan", /\b(?:template[- ]?scan|nuclei)\b\s*[:=-]/i],
    ["content_discovery", /\bcontent[- ]?discovery\b\s*[:=-]|\bsökvägar\b.{0,40}\b(?:200|403|404)\b/i]
  ];
  return claims.some(([operation, pattern]) => !executed.has(operation) && pattern.test(content));
}

function needsGroundedRepair(request: GenerateRequest, result: GenerateResult): boolean {
  if (result.finishReason === "tool_call") return false;
  const content = result.content ?? "";
  return !content.trim() || hasMalformedToolMarkup(content) || signalsDeferredToolAction(content) || ungroundedExecutionClaim(request, content);
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
        content: "Execution repair: you stated or implied that you would perform the authorized security assessment, but no executable function call was produced. Invoke exactly one exposed security_scan function now using the SECURITY TOOL CONTRACT V1 JSON shape. Choose the first still-unexecuted operation in the authoritative PENTEST CAPABILITY PLAN when one exists. Do not print XML/tool markup and do not invent unsupported parameters."
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
  const state = executionStateInstruction(request) ?? "SECURITY EXECUTION STATE V1 unavailable";
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: `Capability-stop repair. ${state}\nThe requested security class requires authenticated identity/session/token manipulation or a stateful business workflow that the currently exposed security tools cannot perform. Give the final answer now. Explicitly say that the requested class cannot be verified with the current runtime, name the missing authenticated/session/token/workflow capability, and do not claim a vulnerability. Mention only evidence from operations that actually executed. Do not invoke web research as a substitute, do not narrate another future tool action, and do not print tool markup.`
      }
    ]
  };
}

function groundedFinalRepairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  const state = executionStateInstruction(request) ?? "SECURITY EXECUTION STATE V1 unavailable";
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content },
      {
        role: "user",
        content: `Evidence-grounding repair. ${state}\nReturn a final answer now using only the recorded tool evidence. Do not claim that an unexecuted operation ran. If an observed redirect points outside the authorized host, explicitly state that it is outside scope and needs separate authorization. If a scanner finding was followed by contradictory independent evidence, label it false positive / not confirmed rather than confirmed. If a probe timed out and an independent follow-up succeeded, report both facts without claiming the target is definitively down. Do not narrate future actions and do not print <tool_call> or other pseudo-tool markup.`
      }
    ]
  };
}

function capabilityStopFallback(request: GenerateRequest, previous: GenerateResult): GenerateResult {
  const prompt = latestUserContent(request);
  let content: string;
  if (/\b(?:BOLA|IDOR)\b/i.test(prompt)) {
    content = "Den körda passiva baslinjen är den enda verifierade evidensen. Nuvarande runtime kan inte verifiera BOLA/IDOR eftersom autentiserad identitets- och sessionsväxling mellan användare saknas. Ingen BOLA/IDOR-sårbarhet påstås vara verifierad.";
  } else if (/\b(?:JWT|session|token)\b/i.test(prompt)) {
    content = "Den körda passiva baslinjen är verifierad. Nuvarande runtime kan inte verifiera JWT- eller session-bypass eftersom autentiserad sessionsstate samt tokenmutation och replay saknas. Ingen bypass påstås vara verifierad.";
  } else {
    content = "Den körda passiva baslinjen är verifierad. Nuvarande runtime kan inte verifiera den efterfrågade stateful affärslogiken eftersom autentiserad multi-step workflow- och multi-actor-kapacitet saknas. Ingen affärslogiksårbarhet påstås vara verifierad.";
  }
  return { ...previous, content, finishReason: "stop", toolCalls: undefined };
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
    const firstNormalized = normalizeTextualToolResult(first, prepared.tools).result;
    const normalizedFirst = alignToolCallToPlan(prepared, firstNormalized);

    if (duplicateSecurityCall(prepared, normalizedFirst)) {
      const repaired = await this.raw.generate(duplicateRepairRequest(prepared, normalizedFirst));
      const normalizedRepair = alignToolCallToPlan(prepared, normalizeTextualToolResult(repaired, prepared.tools).result);
      return { ...normalizedRepair, usage: mergeUsage(normalizedFirst.usage, normalizedRepair.usage) };
    }

    if (normalizedFirst.finishReason === "tool_call") return normalizedFirst;

    if (requestsSecurityExecution(prepared) && !hasSecurityToolResult(prepared)) {
      const second = await this.raw.generate(initialRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = alignToolCallToPlan(prepared, normalizeTextualToolResult(second, prepared.tools).result);
      return { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
    }

    if (hasSecurityToolResult(prepared) && requestsCapabilityLimitedSecurityClass(prepared) && !hasCapabilityStopLanguage(normalizedFirst.content)) {
      const second = await this.raw.generate(capabilityStopRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = normalizeTextualToolResult(second, prepared.tools).result;
      const combined = { ...normalizedSecond, usage: mergeUsage(normalizedFirst.usage, normalizedSecond.usage) };
      if (normalizedSecond.finishReason === "tool_call") return alignToolCallToPlan(prepared, combined);
      if (hasCapabilityStopLanguage(normalizedSecond.content) && !needsGroundedRepair(prepared, normalizedSecond)) return combined;
      return capabilityStopFallback(prepared, combined);
    }

    const continuation = plannedContinuation(prepared, normalizedFirst);
    if (continuation) return continuation;

    if (hasSecurityToolResult(prepared) && needsGroundedRepair(prepared, normalizedFirst)) {
      const second = await this.raw.generate(groundedFinalRepairRequest(prepared, normalizedFirst));
      const normalizedSecond = alignToolCallToPlan(prepared, normalizeTextualToolResult(second, prepared.tools).result);
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
