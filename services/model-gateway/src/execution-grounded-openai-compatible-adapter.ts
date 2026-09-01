import type {
  GenerateRequest,
  GenerateResult,
  ModelStreamDeltaHandler,
  ModelToolCall,
  ModelToolDefinition
} from "@div3rsa/model-sdk";
import { SecurityAwareOpenAiCompatibleAdapter } from "./security-aware-openai-compatible-adapter";

type SecurityOperation = "dns_lookup" | "http_probe" | "tls_probe" | "port_scan" | "template_scan" | "content_discovery";

const SECURITY_OPERATIONS = new Set<SecurityOperation>([
  "dns_lookup",
  "http_probe",
  "tls_probe",
  "port_scan",
  "template_scan",
  "content_discovery"
]);

function securityDefinition(request: GenerateRequest): ModelToolDefinition | undefined {
  return request.tools?.find((tool) => tool.name === "security_scan");
}

function hasSecurityTool(request: GenerateRequest): boolean {
  return Boolean(securityDefinition(request));
}

function hasSecurityToolResult(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "tool" && message.name === "security_scan");
}

function systemInstructions(request: GenerateRequest): string {
  return request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

function hasOpenedCurrentEvidence(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "tool" && message.name === "web_fetch");
}

function boundedCurrentEvidenceRequest(request: GenerateRequest): GenerateRequest {
  if (!systemInstructions(request).includes("CURRENT INFORMATION REQUIRED") || !hasOpenedCurrentEvidence(request)) return request;
  return {
    ...request,
    temperature: 0,
    maxOutputTokens: Math.min(request.maxOutputTokens ?? 800, 800),
    disableThinking: true
  };
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

function schemaOperations(request: GenerateRequest): Set<SecurityOperation> {
  const properties = securityDefinition(request)?.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return new Set();
  const tool = (properties as Record<string, Record<string, unknown>>).tool;
  const values = tool?.enum;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is SecurityOperation => typeof value === "string" && SECURITY_OPERATIONS.has(value as SecurityOperation)));
}

function normalizedUrlCandidate(raw: string): { target: string; host: string } | null {
  const cleaned = raw.replace(/[),.;!?]+$/g, "");
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return { target: url.origin, host: url.hostname.toLowerCase().replace(/\.$/, "") };
  } catch {
    return null;
  }
}

function explicitSecurityTarget(request: GenerateRequest): string | null {
  const text = latestUserContent(request);
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)]
    .map((match) => normalizedUrlCandidate(match[0]))
    .filter((value): value is { target: string; host: string } => Boolean(value));
  const urlHosts = new Set(urls.map((value) => value.host));
  if (urlHosts.size === 1 && urls[0]) return urls[0].target;
  if (urlHosts.size > 1) return null;

  const hosts = [...text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/gi)]
    .map((match) => match[0].toLowerCase().replace(/\.$/, ""));
  const unique = [...new Set(hosts)];
  return unique.length === 1 ? unique[0] : null;
}

function validSecurityToolCall(result: GenerateResult): ModelToolCall | null {
  if (result.finishReason !== "tool_call" || !result.toolCalls?.length) return null;
  return result.toolCalls.find((call) => call.name === "security_scan") ?? null;
}

function deterministicInitialContinuation(request: GenerateRequest, result: GenerateResult): GenerateResult {
  if (!hasSecurityTool(request) || hasSecurityToolResult(request) || !requestsSecurityExecution(request)) return result;
  if (validSecurityToolCall(result)) return result;

  const operation = plannedSecurityOperations(request)[0];
  const allowed = schemaOperations(request);
  const target = explicitSecurityTarget(request);
  if (!operation || !allowed.has(operation) || !target) return result;

  return {
    ...result,
    content: "",
    finishReason: "tool_call",
    toolCalls: [{
      id: `security-grounded-initial-${request.requestId}`,
      name: "security_scan",
      input: { tool: operation, target, options: {} }
    }]
  };
}

interface ExecutedSecurityEvidence {
  target: string;
  result: string;
}

function executedSecurityEvidence(request: GenerateRequest): ExecutedSecurityEvidence[] {
  const results = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === "tool" && message.name === "security_scan" && message.toolCallId) {
      results.set(message.toolCallId, message.content ?? "");
    }
  }

  const evidence: ExecutedSecurityEvidence[] = [];
  for (const message of request.messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      if (call.name !== "security_scan" || !results.has(call.id)) continue;
      const target = typeof call.input.target === "string" ? call.input.target.trim() : "";
      if (target) evidence.push({ target, result: results.get(call.id) ?? "" });
    }
  }
  return evidence;
}

function targetHost(target: string): string | null {
  const candidate = /^https?:\/\//i.test(target) ? normalizedUrlCandidate(target) : null;
  if (candidate) return candidate.host;
  const host = target.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return host || null;
}

function externalEvidenceHosts(request: GenerateRequest): string[] {
  const hosts = new Set<string>();
  for (const evidence of executedSecurityEvidence(request)) {
    const authorizedHost = targetHost(evidence.target);
    if (!authorizedHost) continue;
    for (const match of evidence.result.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
      const candidate = normalizedUrlCandidate(match[0]);
      if (!candidate) continue;
      if (candidate.host !== authorizedHost && !candidate.host.endsWith(`.${authorizedHost}`)) hosts.add(candidate.host);
    }
  }
  return [...hosts];
}

function requestsStrictScopeBoundary(request: GenerateRequest): boolean {
  const text = latestUserContent(request);
  return /(?:expandera aldrig scope|utöka aldrig scope|endast\s+https?:\/\/|only\s+https?:\/\/|externa leverantörer utan separat|outside scope|separate explicit authorization)/i.test(text);
}

function hasScopeBoundaryLanguage(content: string): boolean {
  return /(?:utanför scope|outside scope|inte auktoriserad|not authorized|separat.{0,30}behörighet|separate.{0,30}authorization)/i.test(content);
}

function groundScopeBoundaryFinal(request: GenerateRequest, result: GenerateResult): GenerateResult {
  if (result.finishReason === "tool_call" || !requestsStrictScopeBoundary(request) || hasScopeBoundaryLanguage(result.content ?? "")) return result;
  const externalHosts = externalEvidenceHosts(request);
  if (!externalHosts.length) return result;
  const current = (result.content ?? "").trim();
  const hosts = externalHosts.map((host) => `\`${host}\``).join(", ");
  const scopeNote = `Scope: ${hosts} förekommer bara i executor-evidensen som extern referens/redirect. ${externalHosts.length === 1 ? "Hosten ligger" : "Hostarna ligger"} utanför scope och har inte testats; separat uttrycklig behörighet krävs.`;
  return { ...result, content: current ? `${current}\n\n${scopeNote}` : scopeNote };
}

/**
 * Final production boundary on top of the Qwen compatibility adapter.
 * It deterministically reconstructs only the first already-planned security call when Qwen's
 * repair still fails to emit an exposed native call, and it grounds strict scope-boundary finals
 * in executor evidence. Runtime scope enforcement remains authoritative for every execution.
 */
export class ExecutionGroundedOpenAiCompatibleAdapter extends SecurityAwareOpenAiCompatibleAdapter {
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const boundedRequest = boundedCurrentEvidenceRequest(request);
    const generated = await super.generate(boundedRequest);
    const continued = deterministicInitialContinuation(boundedRequest, generated);
    return groundScopeBoundaryFinal(boundedRequest, continued);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    if (!hasSecurityTool(request)) return super.generateStreamed(request, onDelta);
    const result = await this.generate(request);
    if (result.content) await onDelta(result.content);
    return result;
  }
}
