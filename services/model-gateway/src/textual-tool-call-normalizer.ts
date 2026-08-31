import type { GenerateResult, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";

const SECURITY_TOOL = "security_scan";
const SECURITY_IDS = ["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"] as const;
type SecurityToolId = typeof SECURITY_IDS[number];
const SECURITY_OPTION_KEYS: Record<SecurityToolId, ReadonlySet<string>> = {
  dns_lookup: new Set(),
  http_probe: new Set(),
  tls_probe: new Set(),
  port_scan: new Set(["ports", "maxRate"]),
  template_scan: new Set(["rateLimit"]),
  content_discovery: new Set(["rateLimit"])
};

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

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function firstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return jsonObject(raw.slice(start, index + 1));
      if (depth < 0) return null;
    }
  }
  return null;
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

function securityJsonCall(object: Record<string, unknown>, start: number, end: number, raw: string): ParsedPseudoCall | null {
  const selector = typeof object.tool === "string" ? object.tool.trim() : "";
  if (selector === SECURITY_TOOL) {
    const { tool: _selector, ...parameters } = object;
    return { name: SECURITY_TOOL, parameters, start, end, raw };
  }
  if (SECURITY_IDS.includes(selector as SecurityToolId)) return { name: SECURITY_TOOL, parameters: object, start, end, raw };
  if (object.name === SECURITY_TOOL && object.arguments && typeof object.arguments === "object" && !Array.isArray(object.arguments)) {
    return { name: SECURITY_TOOL, parameters: object.arguments as Record<string, unknown>, start, end, raw };
  }
  return null;
}

function parsePseudoCall(content: string, securityExposed: boolean): ParsedPseudoCall | null {
  const open = content.search(/<tool_call\b[^>]*>/i);
  if (open >= 0) {
    const opening = content.slice(open).match(/^<tool_call\b[^>]*>/i)?.[0];
    if (!opening) return null;
    const bodyStart = open + opening.length;
    const remainder = content.slice(bodyStart);
    const closingMatch = /<\/tool_call>/i.exec(remainder);
    const nextOpeningMatch = /<tool_call\b[^>]*>/i.exec(remainder);
    const firstBlockEnd = closingMatch
      ? bodyStart + closingMatch.index + closingMatch[0].length
      : nextOpeningMatch
        ? bodyStart + nextOpeningMatch.index
        : content.length;
    const trailing = content.slice(firstBlockEnd).trimStart();
    const end = /^<tool_call\b/i.test(trailing) ? content.length : firstBlockEnd;
    const block = content.slice(open, firstBlockEnd);
    const raw = content.slice(open, end);
    const functionMatch = /<function=([A-Za-z_][\w.:-]*)>/i.exec(block);
    const name = functionMatch?.[1]?.trim();
    if (name) return { name, parameters: parameterEntries(block), start: open, end, raw };

    if (securityExposed) {
      const bodyEnd = closingMatch ? bodyStart + closingMatch.index : firstBlockEnd;
      const object = firstJsonObject(content.slice(bodyStart, bodyEnd));
      if (object) return securityJsonCall(object, open, end, raw);
    }
    return null;
  }

  if (!securityExposed) return null;
  const trimmed = content.trim();
  const object = jsonObject(trimmed);
  if (!object) return null;
  const start = content.indexOf(trimmed);
  return securityJsonCall(object, start, start + trimmed.length, trimmed);
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
  const nested = parameters.options && typeof parameters.options === "object" && !Array.isArray(parameters.options)
    ? parameters.options as Record<string, unknown>
    : {};
  const exactHints = [parameters.tool, parameters.scan_type, nested.tool, nested.scan_type];
  for (const hint of exactHints) {
    if (typeof hint !== "string") continue;
    const exact = hint.trim() as SecurityToolId;
    if (allowed.has(exact)) return exact;
  }
  const semantic = [parameters.scan_type, parameters.focus, parameters.include, parameters.notes, parameters.type, parameters.mode, nested.scan_type, nested.tool, nested.focus, nested.type, nested.mode]
    .map(text)
    .join(" ")
    .toLowerCase();
  const candidates: SecurityToolId[] = [];
  if (/baseline|initial|low[- ]impact|låg[- ]påverkan|headers?|http\b|reachability/.test(semantic)) candidates.push("http_probe");
  if (/\bdns\b|resolve|record/.test(semantic)) candidates.push("dns_lookup");
  if (/\btls\b|\bssl\b|certificate|certifikat|cipher/.test(semantic)) candidates.push("tls_probe");
  if (/content|director|path|endpoint discovery|fuzz/.test(semantic)) candidates.push("content_discovery");
  if (/ports?|exposed service|protocol/.test(semantic)) candidates.push("port_scan");
  if (/template|nuclei|cve|vulnerabilit|scanner/.test(semantic)) candidates.push("template_scan");
  if (/\bjwt\b|session|token|auth|access[_ -]?control|\bbola\b|\bidor\b|business logic|checkout|price|discount/.test(semantic)) candidates.unshift("http_probe");
  return candidates.find((candidate) => allowed.has(candidate)) ?? null;
}

function validSecurityOptionValue(toolId: SecurityToolId, key: string, value: unknown): boolean {
  if (key === "ports" && toolId === "port_scan") {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    if (!values.length || values.length > 128) return false;
    return values.every((candidate) => {
      const port = Number(String(candidate).trim());
      return Number.isInteger(port) && port >= 1 && port <= 65535;
    });
  }
  if (key === "maxRate" && toolId === "port_scan") {
    const rate = Number(value);
    return Number.isInteger(rate) && rate >= 1 && rate <= 500;
  }
  if (key === "rateLimit" && (toolId === "template_scan" || toolId === "content_discovery")) {
    const rate = Number(value);
    return Number.isInteger(rate) && rate >= 1 && rate <= 50;
  }
  return false;
}

function securityInput(tool: ModelToolDefinition, parameters: Record<string, unknown>): Record<string, unknown> | null {
  const target = typeof parameters.target === "string" ? parameters.target.trim() : "";
  if (!target || target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target)) return null;
  const allowed = allowedSecurityIds(tool);
  const toolId = chooseSecurityTool(parameters, allowed);
  if (!toolId) return null;
  const sourceOptions = parameters.options && typeof parameters.options === "object" && !Array.isArray(parameters.options)
    ? parameters.options as Record<string, unknown>
    : {};
  const hintKeys = new Set(["scan_type", "tool", "focus", "type", "mode", "notes", "include"]);
  const optionEntries = Object.entries(sourceOptions).filter(([key]) => !hintKeys.has(key));
  const allowedOptionKeys = SECURITY_OPTION_KEYS[toolId];
  if (optionEntries.some(([key, value]) => !allowedOptionKeys.has(key) || !validSecurityOptionValue(toolId, key, value))) return null;
  const options = Object.fromEntries(optionEntries);
  return { tool: toolId, target, options };
}

export interface NormalizedTextualToolResult {
  result: GenerateResult;
  normalized: boolean;
  rawToolText?: string;
}

export function normalizeTextualToolResult(result: GenerateResult, tools: ModelToolDefinition[] | undefined): NormalizedTextualToolResult {
  if (result.toolCalls?.length || result.finishReason === "tool_call" || !tools?.length || !result.content) return { result, normalized: false };
  const securityExposed = tools.some((tool) => tool.name === SECURITY_TOOL);
  const parsed = parsePseudoCall(result.content, securityExposed);
  if (!parsed) return { result, normalized: false };
  const definition = tools.find((tool) => tool.name === parsed.name);
  if (!definition) return { result, normalized: false };
  const input = parsed.name === SECURITY_TOOL ? securityInput(definition, parsed.parameters) : genericInput(definition, parsed.parameters);
  if (!input) return { result, normalized: false };
  const call: ModelToolCall = { id: "text-tool-call-0", name: parsed.name, input };
  const sanitized = `${result.content.slice(0, parsed.start)}${result.content.slice(parsed.end)}`.trim();
  return { normalized: true, rawToolText: parsed.raw, result: { ...result, content: sanitized, finishReason: "tool_call", toolCalls: [call] } };
}

export function securityToolContract(tools: ModelToolDefinition[] | undefined): string | null {
  const definition = tools?.find((tool) => tool.name === SECURITY_TOOL);
  if (!definition) return null;
  const allowed = [...allowedSecurityIds(definition)];
  if (!allowed.length) return null;
  return `SECURITY TOOL CONTRACT V1\nThe attached Lab scope is the only execution boundary; this instruction never expands it. When the user requests an authorized security assessment and security_scan is exposed, invoke the provided tool instead of merely describing that you will test. Call it with EXACTLY this top-level JSON shape: {"tool":"<one allowed id>","target":"<exact authorized host or URL>","options":{}}. Allowed ids in this run: ${allowed.join(", ")}. Do not invent scan_type, focus, depth, identity, object_id, callback, tracing, shell-command or other top-level fields. Strict options: dns_lookup/http_probe/tls_probe accept {}; port_scan accepts only ports (bounded list) and maxRate; template_scan/content_discovery accept only rateLimit. Tool roles: dns_lookup=passive DNS; http_probe=passive HTTP reachability/response headers; tls_probe=passive TLS/certificate; port_scan=bounded active TCP ports; template_scan=bounded active vulnerability templates; content_discovery=bounded active web paths. Start with the least-disruptive useful evidence. After each tool result, use the observation to choose the next materially different check; never repeat an identical tool+target+options call. A timeout or negative result is evidence: adapt to another relevant dimension such as DNS/TLS or conclude what remains unknown. Treat scanner output as a hypothesis, not proof; independently verify a material scanner finding before reporting it as confirmed. The current bounded tool set cannot by itself prove authenticated BOLA/IDOR, JWT/session bypass, or stateful business-logic abuse; when the capability plan reports such a gap, finish the supported baseline and stop instead of looping. The capability plan embedded in the security_scan definition is authoritative: selected skills are knowledge only, missing capabilities must not be simulated, and capability-stop is mandatory after the executable baseline when the plan reports a gap. Never manually print <tool_call>, <function> or <parameter> markup; invoke the provided function tool.`;
}
