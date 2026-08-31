import type { GenerateRequest, GenerateResult, ModelToolCall } from "@div3rsa/model-sdk";
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

interface ExecutedSecurityCall {
  operation: SecurityOperation;
  target: string;
  result: string;
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function securityDefinitionDescription(request: GenerateRequest): string {
  return request.tools?.find((tool) => tool.name === "security_scan")?.description ?? "";
}

function hasSecurityTool(request: GenerateRequest): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "security_scan"));
}

function plannedSecurityOperations(request: GenerateRequest): SecurityOperation[] {
  const description = securityDefinitionDescription(request);
  const line = /Executable security plan:\s*([^\n.]+)/i.exec(description)?.[1] ?? "";
  const operations: SecurityOperation[] = [];
  for (const match of line.matchAll(/\d+:([a-z_]+)/gi)) {
    const operation = match[1] as SecurityOperation;
    if (SECURITY_OPERATIONS.has(operation) && !operations.includes(operation)) operations.push(operation);
  }
  return operations;
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
      calls.push({ operation, target, result: toolResults.get(call.id) ?? "" });
    }
  }
  return calls;
}

function nextPlannedOperation(request: GenerateRequest): SecurityOperation | null {
  const plan = plannedSecurityOperations(request);
  if (!plan.length) return null;
  const executed = new Set(executedSecurityCalls(request).map((item) => item.operation));
  return plan.find((operation) => !executed.has(operation)) ?? null;
}

function requestsSecurityExecution(request: GenerateRequest): boolean {
  if (!hasSecurityTool(request)) return false;
  const text = latestUserContent(request)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/gi, " ");
  return /\b(?:säkerhetsgranska|granska|testa|kontrollera|kör|börja|utför|pentest|penetrationstest|scan|scanner|assess|audit|test|review|check|execute|run)\b/i.test(text);
}

function requestsCapabilityLimitedSecurityClass(request: GenerateRequest): boolean {
  const text = latestUserContent(request).replace(/https?:\/\/\S+/gi, " ");
  return /\b(?:BOLA|IDOR|JWT|session|token|authenticated|autentiserad|identity[- ]bound|identitetsbunden|business logic|affärslogik|checkout|price manipulation|prismanipulation|discount manipulation|rabattmanipulation)\b/i.test(text);
}

function hasMalformedToolMarkup(content: string): boolean {
  return /<\/?tool_call\b|<function=|<\/?parameter=/i.test(content);
}

function hasUnknownNativeToolCall(request: GenerateRequest, result: GenerateResult): boolean {
  if (result.finishReason !== "tool_call" || !result.toolCalls?.length) return false;
  const exposed = new Set((request.tools ?? []).map((tool) => tool.name));
  return result.toolCalls.some((call) => !exposed.has(call.name));
}

function targetFromPrompt(request: GenerateRequest): string {
  const prompt = latestUserContent(request);
  const url = prompt.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "");
  if (url) return url;
  return prompt.match(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/i)?.[0] ?? "";
}

function plannedTarget(request: GenerateRequest): string {
  return executedSecurityCalls(request).at(-1)?.target ?? targetFromPrompt(request);
}

function deterministicPlannedCall(request: GenerateRequest, previous: GenerateResult): GenerateResult | null {
  if (!hasSecurityTool(request) || requestsCapabilityLimitedSecurityClass(request)) return null;
  const next = nextPlannedOperation(request);
  if (!next) return null;
  const target = plannedTarget(request);
  if (!target) return null;
  const call: ModelToolCall = {
    id: `security-grounded-plan-${executedSecurityCalls(request).length + 1}`,
    name: "security_scan",
    input: { tool: next, target, options: {} }
  };
  return { ...previous, content: "", finishReason: "tool_call", toolCalls: [call] };
}

function explicitAuthorizedHosts(request: GenerateRequest): string[] {
  const hosts = new Set<string>();
  const systemText = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const markers = [
    /(?:the\s+only\s+in-scope\s+hosts\s+are|in-scope\s+hosts|authorized\s+hosts|authorised\s+hosts)\s*:\s*([^\n]+)/gi,
    /(?:enda\s+hosts?\s+i\s+scope|auktoriserade\s+hosts?|tillåtna\s+hosts?)\s*:\s*([^\n]+)/gi
  ];
  for (const marker of markers) {
    for (const match of systemText.matchAll(marker)) {
      for (const hostMatch of match[1].matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)) hosts.add(hostMatch[0].toLowerCase().replace(/\.$/, ""));
    }
  }

  if (!hosts.size && /\b(?:endast|bara|only)\b/i.test(latestUserContent(request))) {
    for (const match of latestUserContent(request).matchAll(/https?:\/\/([^\s/:?#]+)/gi)) hosts.add(match[1].toLowerCase().replace(/\.$/, ""));
  }
  return [...hosts];
}

function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

function observedOutOfScopeRedirect(request: GenerateRequest): string | null {
  const allowedHosts = explicitAuthorizedHosts(request);
  if (!allowedHosts.length) return null;
  for (const item of executedSecurityCalls(request)) {
    if (item.operation !== "http_probe") continue;
    for (const match of item.result.matchAll(/location[^\r\n]{0,160}?(https?:\/\/[^\s"'\\]+)/gi)) {
      try {
        const host = new URL(match[1]).hostname.toLowerCase().replace(/\.$/, "");
        if (host && !hostAllowed(host, allowedHosts)) return host;
      } catch {
        // Ignore malformed evidence URLs; executor evidence remains authoritative.
      }
    }
  }
  return null;
}

function hasScopeBoundaryLanguage(content: string): boolean {
  return /(?:utanför\s+scope|outside\s+scope|inte\s+auktoriserad|not\s+authorized|separat.{0,30}behörighet|separate.{0,30}authorization)/i.test(content);
}

function scannerContradiction(request: GenerateRequest): string | null {
  const executed = executedSecurityCalls(request);
  const scannerFinding = executed.find((item) => item.operation === "template_scan" && /(?:missing[-_ ]?hsts|strict transport security missing)/i.test(item.result));
  if (!scannerFinding) return null;
  const httpEvidence = executed.find((item) => item.operation === "http_probe" && /strict-transport-security/i.test(item.result));
  if (!httpEvidence) return null;
  return "Scannerträffen om saknad HSTS är inte bekräftad och klassas som falsk positiv eftersom den körda HTTP-evidensen visar Strict-Transport-Security.";
}

function hasFalsePositiveLanguage(content: string): boolean {
  return /(?:false\s+positive|falsk\s+positiv|ej\s+verifierad|not\s+confirmed|falsifier)/i.test(content);
}

/**
 * Final fail-closed guard above the Qwen compatibility adapter.
 * It never expands capability: it may only select the next security operation already present in
 * the authoritative capability plan, and it may only add conclusions directly derivable from
 * executor-backed observations already present in the request trace.
 */
export class ExecutionGroundedOpenAiCompatibleAdapter extends SecurityAwareOpenAiCompatibleAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    const result = await super.generate(request);

    if (hasUnknownNativeToolCall(request, result)) {
      const grounded = deterministicPlannedCall(request, result);
      if (grounded) return grounded;
      return { ...result, content: "Tillgänglig runtime kan inte utföra det begärda okända verktyget; ingen sådan handling räknas som utförd.", finishReason: "stop", toolCalls: undefined };
    }

    if (result.finishReason !== "tool_call") {
      const shouldRecoverInitialExecution = requestsSecurityExecution(request) && executedSecurityCalls(request).length === 0;
      if ((hasMalformedToolMarkup(result.content ?? "") || shouldRecoverInitialExecution)) {
        const grounded = deterministicPlannedCall(request, result);
        if (grounded) return grounded;
      }
    }

    if (result.finishReason === "tool_call") return result;

    let content = result.content ?? "";
    const externalRedirectHost = observedOutOfScopeRedirect(request);
    if (externalRedirectHost && !hasScopeBoundaryLanguage(content)) {
      const boundary = `Redirecten pekar på ${externalRedirectHost}, som ligger utanför den uttryckligen auktoriserade scopet och inte har testats. Separat uttrycklig behörighet krävs innan någon kontroll av den hosten.`;
      content = `${content.trim()}\n\n${boundary}`.trim();
    }

    const contradiction = scannerContradiction(request);
    if (contradiction && !hasFalsePositiveLanguage(content)) content = `${content.trim()}\n\n${contradiction}`.trim();

    return content === result.content ? result : { ...result, content };
  }
}
