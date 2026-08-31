import type {
  GenerateRequest,
  GenerateResult,
  ModelStreamDeltaHandler,
  ModelToolDefinition
} from "@div3rsa/model-sdk";
import { ExecutionGroundedOpenAiCompatibleAdapter } from "./execution-grounded-openai-compatible-adapter";
import { isDeterministicSecurityReadiness } from "./security-readiness-protocol";

type SecurityOperation = "dns_lookup" | "http_probe" | "tls_probe" | "port_scan" | "template_scan" | "content_discovery";

const SECURITY_OPERATIONS = new Set<SecurityOperation>([
  "dns_lookup",
  "http_probe",
  "tls_probe",
  "port_scan",
  "template_scan",
  "content_discovery"
]);
const PSEUDO_TOOL_PROTOCOL = /<\/?tool_call\b|<function=|<\/function>|<\/?parameter=/i;

function hasAnyTool(request: GenerateRequest): boolean {
  return Boolean(request.tools?.length);
}

function securityDefinition(request: GenerateRequest): ModelToolDefinition | undefined {
  return request.tools?.find((tool) => tool.name === "security_scan");
}

function hasSecurityToolResult(request: GenerateRequest): boolean {
  return request.messages.some((message) => message.role === "tool" && message.name === "security_scan");
}

function latestUserContent(request: GenerateRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function requestsSecurityExecution(request: GenerateRequest): boolean {
  if (!securityDefinition(request)) return false;
  const text = latestUserContent(request)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:test|com|net|org|se|io|dev)\b/gi, " ");
  return /\b(?:säkerhetsgranska|granska|testa|kontrollera|kör|börja|utför|pentest|penetration(?:stest)?|scan|assess|audit|test|review|check|execute|run)\b/i.test(text);
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
  const values = (properties as Record<string, Record<string, unknown>>).tool?.enum;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is SecurityOperation => typeof value === "string" && SECURITY_OPERATIONS.has(value as SecurityOperation)));
}

function normalizedUrlCandidate(raw: string): { target: string; host: string } | null {
  const cleaned = raw.replace(/[),.;!?]+$/g, "");
  try {
    const url = new URL(cleaned);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return null;
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

function malformedToolProtocol(result: GenerateResult): boolean {
  if (result.finishReason === "tool_call" && !result.toolCalls?.length) return true;
  return Boolean(result.content && PSEUDO_TOOL_PROTOCOL.test(result.content));
}

function deterministicSecurityRecovery(request: GenerateRequest, result: GenerateResult): GenerateResult | null {
  if (!malformedToolProtocol(result) || !requestsSecurityExecution(request) || hasSecurityToolResult(request)) return null;
  const operation = plannedSecurityOperations(request)[0];
  const target = explicitSecurityTarget(request);
  const allowed = schemaOperations(request);
  if (!operation || !allowed.has(operation) || !target) return null;
  return {
    ...result,
    content: "",
    finishReason: "tool_call",
    toolCalls: [{
      id: `strict-tool-security-${request.requestId}`,
      name: "security_scan",
      input: { tool: operation, target, options: {} }
    }]
  };
}

function toolSchemaSummary(tools: ModelToolDefinition[] | undefined): string {
  return (tools ?? []).map((tool) => {
    const required = Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((value): value is string => typeof value === "string")
      : [];
    const properties = tool.inputSchema.properties && typeof tool.inputSchema.properties === "object" && !Array.isArray(tool.inputSchema.properties)
      ? Object.keys(tool.inputSchema.properties)
      : [];
    return `${tool.name}{required:[${required.join(",")}],fields:[${properties.join(",")}]}`;
  }).join("; ");
}

function repairRequest(request: GenerateRequest, previous: GenerateResult): GenerateRequest {
  return {
    ...request,
    temperature: 0,
    messages: [
      ...request.messages,
      { role: "assistant", content: previous.content ?? "" },
      {
        role: "user",
        content: `Tool-protocol repair: the previous response emitted malformed textual tool markup or an incomplete tool call, so nothing in it was executed. Do not print <tool_call>, <function> or <parameter> markup. Either invoke exactly one currently exposed native function now with every required schema field, or give a normal final answer if no tool is needed. In Lab security execution, security_scan is the execution tool; web_search is research only and must not substitute for an executable security operation. Exposed tool schemas: ${toolSchemaSummary(request.tools)}.`
      }
    ]
  };
}

function mergeUsage(first: GenerateResult["usage"], second: GenerateResult["usage"]): GenerateResult["usage"] {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens
  };
}

/**
 * Final fail-closed boundary for llama.cpp/Qwen tool serialization.
 * Text that looks like tool protocol is never user-visible execution evidence. It must become a
 * validated native call, a deterministic already-planned Lab security call, or an explicit error.
 *
 * The sole exception is the reserved internal production-readiness protocol. Its harness owns a
 * deterministic bridge from raw Qwen serialization to the exact schema-narrowed readiness call,
 * so this outer user-facing guard must not intercept that protocol.
 */
export class StrictToolProtocolOpenAiCompatibleAdapter extends ExecutionGroundedOpenAiCompatibleAdapter {
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (isDeterministicSecurityReadiness(request)) return super.generate(request);

    const first = await super.generate(request);
    if (!malformedToolProtocol(first)) return first;

    const deterministic = deterministicSecurityRecovery(request, first);
    if (deterministic) return deterministic;

    const second = await super.generate(repairRequest(request, first));
    if (malformedToolProtocol(second)) throw new Error("model_invalid_tool_protocol_after_repair");
    return { ...second, usage: mergeUsage(first.usage, second.usage) };
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    if (isDeterministicSecurityReadiness(request)) return super.generateStreamed(request, onDelta);
    if (!hasAnyTool(request)) return super.generateStreamed(request, onDelta);
    const result = await this.generate(request);
    if (result.finishReason !== "tool_call" && result.content) await onDelta(result.content);
    return result;
  }
}
