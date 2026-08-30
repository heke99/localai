import type { GenerateResult, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";

const SECURITY_TOOL = "security_scan";
const SECURITY_IDS = ["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"] as const;
type SecurityToolId = typeof SECURITY_IDS[number];

interface ParsedPseudoCall {
  name: string;
  parameters: Record<string, unknown>;
  start: number;
  end: number;
  raw: string;
}

function schemaProperties(tool: ModelToolDefinition): Record<string, Record<string, unknown>> {
  const properties = tool.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, Record<string, unknown>>;
}

function schemaRequired(tool: ModelToolDefinition): string[] {
  return Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  try { return JSON.parse(value) as unknown; } catch { /* textual value */ }
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parameterEntries(block: string): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const patterns = [
    /<parameter=([A-Za-z_][\w.:-]*)>\s*([\s\S]*?)\s*<\/parameter>/gi,
    /<\/parameter=([A-Za-z_][\w.:-]*)>\s*([\s\S]*?)\s*<\/parameter>/gi
  ];
  for (const pattern of patterns) {
    for (const match of block.matchAll(pattern)) {
      const key = match[1]?.trim();
      if (!key || Object.hasOwn(parameters, key)) continue;
      parameters[key] = parseValue(match[2] ?? "");
    }
  }
  return parameters;
}

function parsePseudoCall(content: string): ParsedPseudoCall | null {
  const open = content.search(/<tool_call\b[^>]*>/i);
  if (open < 0) return null;
  const opening = content.slice(open).match(/^<tool_call\b[^>]*>/i)?.[0];
  if (!opening) return null;
  const bodyStart = open + opening.length;
  const remainder = content.slice(bodyStart);
  const closingMatch = /<\/tool_call>/i.exec(remainder);
  const end = closingMatch ? bodyStart + closingMatch.index + closingMatch[0].length : content.length;
  const raw = content.slice(open, end);
  const functionMatch = /<function=([A-Za-z_][\w.:-]*)>/i.exec(raw);
  const name = functionMatch?.[1]?.trim();
  if (!name) return null;
  return { name, parameters: parameterEntries(raw), start: open, end, raw };
}

function validateSimpleSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
  if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) return false;
  const type = typeof schema.type === "string" ? schema.type : null;
  if (!type) return true;
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function genericInput(tool: ModelToolDefinition, parameters: Record<string, unknown>): Record<string, unknown> | null {
  const properties = schemaProperties(tool);
  const allowedKeys = new Set(Object.keys(properties));
  const additionalProperties = tool.inputSchema.additionalProperties !== false;
  if (!additionalProperties && Object.keys(parameters).some((key) => !allowedKeys.has(key))) return null;
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!allowedKeys.has(key) && !additionalProperties) continue;
    const property = properties[key];
    if (property && !validateSimpleSchema(value, property)) return null;
    input[key] = value;
  }
  if (schemaRequired(tool).some((key) => !Object.hasOwn(input, key))) return null;
  return input;
}

function allowedSecurityIds(tool: ModelToolDefinition): Set<SecurityToolId> {
  const values = schemaProperties(tool).tool?.enum;
  const configured = Array.isArray(values) ? values.filter((value): value is SecurityToolId => typeof value === "string" && SECURITY_IDS.includes(value as SecurityToolId)) : [];
  return new Set(configured);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return ""; }
}

function chooseSecurityTool(parameters: Record<string, unknown>, allowed: Set<SecurityToolId>): SecurityToolId | null {
  const exact = typeof parameters.tool === "string" ? parameters.tool.trim() as SecurityToolId : null;
  if (exact && allowed.has(exact)) return exact;

  const semantic = [parameters.scan_type, parameters.focus, parameters.include, parameters.notes, parameters.type, parameters.mode]
    .map(text)
    .join(" ")
    .toLowerCase();

  const candidates: SecurityToolId[] = [];
  // Prefer the least-disruptive interpretation whenever the model says this is a baseline/initial check.
  if (/baseline|initial|low[- ]impact|låg[- ]påverkan|headers?|http\b|reachability/.test(semantic)) candidates.push("http_probe");
  if (/\bdns\b|resolve|record/.test(semantic)) candidates.push("dns_lookup");
  if (/\btls\b|\bssl\b|certificate|certifikat|cipher/.test(semantic)) candidates.push("tls_probe");
  if (/content|director|path|endpoint discovery|fuzz/.test(semantic)) candidates.push("content_discovery");
  if (/ports?|exposed service|protocol/.test(semantic)) candidates.push("port_scan");
  if (/template|nuclei|cve|vulnerabilit|scanner/.test(semantic)) candidates.push("template_scan");
  // Current runtime cannot prove authenticated authorization/session/business-logic issues. A passive baseline is the only safe repair.
  if (/\bjwt\b|session|token|auth|access[_ -]?control|\bbola\b|\bidor\b|business logic|checkout|price|discount/.test(semantic)) candidates.unshift("http_probe");
  return candidates.find((candidate) => allowed.has(candidate)) ?? null;
}

function securityInput(tool: ModelToolDefinition, parameters: Record<string, unknown>): Record<string, unknown> | null {
  const target = typeof parameters.target === "string" ? parameters.target.trim() : "";
  if (!target || target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target)) return null;
  const allowed = allowedSecurityIds(tool);
  const toolId = chooseSecurityTool(parameters, allowed);
  if (!toolId) return null;
  const options = parameters.options && typeof parameters.options === "object" && !Array.isArray(parameters.options)
    ? parameters.options as Record<string, unknown>
    : {};
  return { tool: toolId, target, options };
}

export interface NormalizedTextualToolResult {
  result: GenerateResult;
  normalized: boolean;
  rawToolText?: string;
}

export function normalizeTextualToolResult(result: GenerateResult, tools: ModelToolDefinition[] | undefined): NormalizedTextualToolResult {
  if (result.toolCalls?.length || result.finishReason === "tool_call" || !tools?.length || !result.content) return { result, normalized: false };
  const parsed = parsePseudoCall(result.content);
  if (!parsed) return { result, normalized: false };
  const definition = tools.find((tool) => tool.name === parsed.name);
  if (!definition) return { result, normalized: false };

  const input = parsed.name === SECURITY_TOOL
    ? securityInput(definition, parsed.parameters)
    : genericInput(definition, parsed.parameters);
  if (!input) return { result, normalized: false };

  const call: ModelToolCall = { id: "text-tool-call-0", name: parsed.name, input };
  const sanitized = `${result.content.slice(0, parsed.start)}${result.content.slice(parsed.end)}`.trim();
  return {
    normalized: true,
    rawToolText: parsed.raw,
    result: { ...result, content: sanitized, finishReason: "tool_call", toolCalls: [call] }
  };
}

export function securityToolContract(tools: ModelToolDefinition[] | undefined): string | null {
  const definition = tools?.find((tool) => tool.name === SECURITY_TOOL);
  if (!definition) return null;
  const allowed = [...allowedSecurityIds(definition)];
  if (!allowed.length) return null;
  return `SECURITY TOOL CONTRACT V1\nThe attached Lab scope is the only execution boundary; this instruction never expands it. When the user requests an authorized security assessment and security_scan is exposed, invoke the provided tool instead of merely describing that you will test. Call it with EXACTLY this top-level JSON shape: {"tool":"<one allowed id>","target":"<exact authorized host or URL>","options":{}}. Allowed ids in this run: ${allowed.join(", ")}. Do not invent scan_type, focus, depth, identity, object_id, callback, tracing, shell-command or other top-level fields. Tool roles: dns_lookup=passive DNS; http_probe=passive HTTP reachability/response headers; tls_probe=passive TLS/certificate; port_scan=bounded active TCP ports; template_scan=bounded active vulnerability templates; content_discovery=bounded active web paths. Start with the least-disruptive useful evidence. Use active checks only when needed and authorized. Treat scanner output as a hypothesis, not proof; independently verify a material scanner finding before reporting it as confirmed. The current tool set cannot by itself prove authenticated BOLA/IDOR, JWT/session bypass, or stateful business-logic abuse; for those, gather only the baseline evidence these tools support and explicitly state the remaining capability gap. Never manually print <tool_call>, <function> or <parameter> markup; invoke the provided function tool.`;
}
