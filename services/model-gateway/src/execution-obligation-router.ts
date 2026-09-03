import type { GenerateRequest, ModelMessage, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";

export type ExecutionObligationKind = "read" | "write" | "verify" | "search" | "open" | "chain" | "exact";

export interface ExecutionObligationRoute {
  requiredToolName: string;
  instruction: string;
  kind: ExecutionObligationKind;
}

type Obligation = { kind: ExecutionObligationKind; toolName: string; position: number };
type JsonRecord = Record<string, unknown>;
type ToolHistoryEntry = { name: string; input: Record<string, unknown>; output: unknown };

const ACTION_PATTERNS: Record<Exclude<ExecutionObligationKind, "exact">, RegExp> = {
  read: /\b(?:read|retrieve|get|load|inspect\s+the\s+(?:current\s+)?(?:value|state|record))\b/i,
  write: /\b(?:set|change|update|write|mutate)\b/i,
  verify: /\b(?:verify|confirm|validate|check)\b/i,
  search: /\b(?:search|find|locate|look\s+up)\b/i,
  open: /\b(?:open|inspect\s+that\s+file|fetch\s+that\s+file)\b/i,
  chain: /\b(?:ordered\s+)?(?:fixture[_ .-]*)?chain[_ .-]*steps?\b|\bchain[_ .-]*step\b/i
};

const IMPERATIVE_EXECUTION = /\b(?:call|use|run|execute|read|retrieve|get|set|change|update|write|mutate|verify|confirm|validate|check|search|find|locate|open|retry|complete|inspect)\b/i;
const EXPLANATORY_ONLY = /^\s*(?:explain|describe|what\s+is|how\s+does|why\s+does|tell\s+me\s+about)\b/i;
const READ_FIRST = /\bread(?:\s+the\s+\w+){0,3}\s+first\b/i;
const READ_ONLY = /\bread[- ]only\b|\bdo\s+not\s+(?:call\s+any\s+)?(?:mutation|write|set|update|change)\b|\bwithout\s+(?:changing|mutating|writing|updating)\b|\bexplicitly\s+forbidden\s+to\s+mutate\b/i;
const IDEMPOTENT = /\bidempoten(?:t|tly|cy)\b|\bonly\s+if\s+(?:needed|necessary|the\s+current\s+value\s+differs|current\s+value\s+differs)\b|\bif\s+already\b[\s\S]{0,80}\bdo\s+not\s+write\b/i;
const WRITE_TOOL_NAME = /(?:^|[._:-])(?:set|write|update|mutate|change)(?:$|[._:-])|_(?:set|write|update|mutate|change)$/i;
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};

function firstUserContent(messages: readonly ModelMessage[]): string {
  return messages.find((message) => message.role === "user")?.content ?? "";
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content) as unknown; }
  catch { return null; }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function toolHistory(messages: readonly ModelMessage[]): ToolHistoryEntry[] {
  const calls = new Map<string, ModelToolCall>();
  const history: ToolHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
      continue;
    }
    if (message.role !== "tool" || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    history.push({ name: call.name, input: call.input, output: parseJson(message.content) });
  }
  return history;
}

function executedToolNames(messages: readonly ModelMessage[]): string[] {
  return toolHistory(messages).map((entry) => entry.name);
}

function latestHistory(messages: readonly ModelMessage[]): ToolHistoryEntry | null {
  const history = toolHistory(messages);
  return history[history.length - 1] ?? null;
}

function latestAuthoritativeValue(messages: readonly ModelMessage[]): string | null {
  const output = asRecord(latestHistory(messages)?.output);
  if (!output) return null;
  const candidates = [output.value, output.currentValue, output.state, output.currentState, output.actual];
  return candidates.find((value): value is string => typeof value === "string") ?? null;
}

function latestRetryableTool(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[]): string | null {
  const latest = latestHistory(messages);
  if (!latest || !tools.some((tool) => tool.name === latest.name)) return null;
  return asRecord(latest.output)?.retryable === true ? latest.name : null;
}

function toolText(tool: ModelToolDefinition): string {
  return `${tool.name} ${tool.description ?? ""}`.toLowerCase();
}

function scoreTool(tool: ModelToolDefinition, kind: Exclude<ExecutionObligationKind, "exact">): number {
  const text = toolText(tool);
  const name = tool.name.toLowerCase();
  const exactNamePatterns: Record<Exclude<ExecutionObligationKind, "exact">, RegExp> = {
    read: /(?:^|[._:-])(?:read|get|retrieve|load)(?:$|[._:-])|_read$|read$/,
    write: /(?:^|[._:-])(?:set|write|update|mutate|change)(?:$|[._:-])|_(?:set|write|update)$/,
    verify: /(?:^|[._:-])(?:verify|check|confirm|validate)(?:$|[._:-])|_(?:verify|check)$/,
    search: /(?:^|[._:-])(?:search|find|lookup)(?:$|[._:-])|_(?:search|find)$/,
    open: /(?:^|[._:-])(?:open|fetch|get_file|read_file)(?:$|[._:-])|_(?:open|fetch)$/,
    chain: /chain.*step|step.*chain/
  };
  const wordPatterns: Record<Exclude<ExecutionObligationKind, "exact">, RegExp> = {
    read: /\b(?:read|retrieve|get|load|current value|current state)\b/,
    write: /\b(?:set|write|update|mutate|change)\b/,
    verify: /\b(?:verify|check|confirm|validate)\b/,
    search: /\b(?:search|find|lookup|locate)\b/,
    open: /\b(?:open|fetch file|read file|file content)\b/,
    chain: /\bchain\b.*\bstep\b|\bstep\b.*\bchain\b/
  };
  let score = 0;
  if (exactNamePatterns[kind].test(name)) score += 8;
  if (wordPatterns[kind].test(text)) score += 4;
  if (kind === "open" && /search/.test(name)) score -= 5;
  if (kind === "read" && /search|open|verify|set|write|update/.test(name)) score -= 3;
  if (kind === "write" && /read|search|open|verify/.test(name)) score -= 3;
  return score;
}

function chooseTool(kind: Exclude<ExecutionObligationKind, "exact">, tools: readonly ModelToolDefinition[]): string | null {
  let best: { name: string; score: number } | null = null;
  for (const tool of tools) {
    const score = scoreTool(tool, kind);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { name: tool.name, score };
  }
  return best?.name ?? null;
}

function actionPosition(prompt: string, kind: Exclude<ExecutionObligationKind, "exact">): number {
  const match = ACTION_PATTERNS[kind].exec(prompt);
  return match?.index ?? -1;
}

function countValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 20) return numeric;
  return NUMBER_WORDS[normalized] ?? null;
}

function chainCount(prompt: string, toolName?: string): number {
  const escaped = toolName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    /\b(?:exactly\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ordered\s+)?[A-Za-z0-9_.-]*chain[A-Za-z0-9_.-]*step(?:s|\s+calls?)?\b/i,
    escaped ? new RegExp(`\\b(?:exactly\\s+)?(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:ordered\\s+)?${escaped}\\s+calls?\\b`, "i") : /$a/
  ];
  for (const pattern of patterns) {
    const count = countValue(pattern.exec(prompt)?.[1]);
    if (count) return count;
  }
  return 1;
}

function normalizePromptToken(value: string): string {
  return value.replace(/[.,;!?]+$/, "");
}

function desiredValue(prompt: string): string | null {
  const patterns = [
    /\b(?:desired|target)\s+value\s+(?:is|=|:)\s*[`"']?([A-Za-z0-9._:/-]+)[`"']?/i,
    /\b(?:set|change|update|write)\b[\s\S]{0,80}?\bvalue\s+to\s*[`"']?([A-Za-z0-9._:/-]+)[`"']?/i,
    /\b(?:set|change|update|write)\b[\s\S]{0,80}?\bto\s*[`"']?([A-Za-z0-9._:/-]+)[`"']?/i,
    /\bverify\b(?:\s+(?:with\s+)?expected)?\s*[`"']?([A-Za-z0-9._:/-]+)[`"']?/i
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(prompt)?.[1];
    if (!raw) continue;
    const value = normalizePromptToken(raw);
    if (value && !/^(?:the|current|value|state|result)$/i.test(value)) return value;
  }
  return null;
}

function negatedToolReference(prompt: string, index: number): boolean {
  const sentenceStart = Math.max(prompt.lastIndexOf(".", index - 1), prompt.lastIndexOf(";", index - 1), prompt.lastIndexOf("\n", index - 1));
  const prefix = prompt.slice(sentenceStart + 1, index);
  return /\b(?:never|do\s+not|don't|must\s+not|forbidden\s+to)\b[\s\S]{0,120}\b(?:call|use|run|execute|mutate|write)?\b/i.test(prefix);
}

function explicitToolObligations(prompt: string, tools: readonly ModelToolDefinition[]): Obligation[] {
  const obligations: Obligation[] = [];
  for (const tool of tools) {
    let from = 0;
    while (from < prompt.length) {
      const index = prompt.indexOf(tool.name, from);
      if (index < 0) break;
      from = index + tool.name.length;
      if (negatedToolReference(prompt, index)) continue;
      if (/chain.*step|step.*chain/i.test(tool.name)) {
        const count = chainCount(prompt, tool.name);
        for (let repetition = 0; repetition < count; repetition += 1) obligations.push({ kind: "chain", toolName: tool.name, position: index + repetition / 100 });
      } else {
        obligations.push({ kind: "exact", toolName: tool.name, position: index });
      }
      break;
    }
  }
  return obligations;
}

function semanticObligations(prompt: string, tools: readonly ModelToolDefinition[]): Obligation[] {
  const obligations: Obligation[] = [];
  const readOnly = READ_ONLY.test(prompt);
  for (const kind of ["read", "write", "verify", "search", "open"] as const) {
    if (kind === "write" && readOnly) continue;
    const position = actionPosition(prompt, kind);
    if (position < 0) continue;
    const toolName = chooseTool(kind, tools);
    if (toolName) obligations.push({ kind, toolName, position });
  }

  const chainPosition = actionPosition(prompt, "chain");
  if (chainPosition >= 0) {
    const toolName = chooseTool("chain", tools);
    if (toolName) {
      const count = chainCount(prompt, toolName);
      for (let index = 0; index < count; index += 1) obligations.push({ kind: "chain", toolName, position: chainPosition + index / 100 });
    }
  }
  return obligations;
}

function normalizeObligations(prompt: string, tools: readonly ModelToolDefinition[]): Obligation[] {
  const explicit = explicitToolObligations(prompt, tools);
  const explicitChainTools = new Set(explicit.filter((item) => item.kind === "chain").map((item) => item.toolName));
  const semantic = semanticObligations(prompt, tools).filter((item) => item.kind !== "chain" || !explicitChainTools.has(item.toolName));
  const combined = [...explicit, ...semantic].sort((a, b) => a.position - b.position);

  if (READ_FIRST.test(prompt)) {
    const readIndex = combined.findIndex((item) => item.kind === "read" || /(?:^|[_:. -])read$/i.test(item.toolName));
    if (readIndex > 0) {
      const [read] = combined.splice(readIndex, 1);
      if (read) combined.unshift({ ...read, position: -1 });
    }
  }

  const deduped: Obligation[] = [];
  for (const obligation of combined) {
    const previous = deduped[deduped.length - 1];
    if (previous?.toolName === obligation.toolName && obligation.kind !== "chain" && previous.kind !== "chain") continue;
    deduped.push(obligation);
  }
  return deduped;
}

function remainingObligation(
  prompt: string,
  obligations: readonly Obligation[],
  executed: readonly string[],
  messages: readonly ModelMessage[]
): Obligation | null {
  const queue = [...obligations];
  let executedIndex = 0;
  while (queue.length && executedIndex < executed.length) {
    const expected = queue[0]!;
    const actual = executed[executedIndex]!;
    if (actual === expected.toolName) queue.shift();
    executedIndex += 1;
  }

  const pending = queue[0];
  if (IDEMPOTENT.test(prompt) && pending && (pending.kind === "write" || WRITE_TOOL_NAME.test(pending.toolName))) {
    const desired = desiredValue(prompt);
    const current = latestAuthoritativeValue(messages);
    if (desired && current === desired) queue.shift();
  }
  return queue[0] ?? null;
}

function obligationInstruction(prompt: string, route: Obligation, executed: readonly string[]): string {
  return [
    `Runtime execution obligation: the original user request explicitly requires the exposed tool ${route.toolName} at this point.`,
    `Already completed native tool calls: ${executed.length ? executed.join(", ") : "none"}.`,
    "Emit exactly one native structured tool call now; do not answer with narration, pseudo-tool markup, JSON envelopes, or a final answer before this obligation is executed.",
    "Derive arguments only from the original user request and authoritative runtime tool results. Preserve exact returned tokens, identifiers, paths, state values, and sequence numbers; never abbreviate or guess them.",
    route.kind === "search" ? "For search queries, preserve the full material search phrase from the user request instead of shortening it." : "",
    route.kind === "chain" ? "For ordered chains, use the exact nextToken from the latest successful tool result as the next previousToken and advance exactly one step." : "",
    `Original execution request: ${prompt}`
  ].filter(Boolean).join(" ");
}

export function routeExecutionObligation(request: GenerateRequest): ExecutionObligationRoute | null {
  const tools = request.tools ?? [];
  if (!tools.length || request.requiredToolName?.trim()) return null;
  const prompt = firstUserContent(request.messages);
  if (!prompt || EXPLANATORY_ONLY.test(prompt) || !IMPERATIVE_EXECUTION.test(prompt)) return null;

  const retryTool = latestRetryableTool(request.messages, tools);
  const executed = executedToolNames(request.messages);
  if (retryTool) {
    const retry: Obligation = { kind: "exact", toolName: retryTool, position: -1 };
    return { requiredToolName: retryTool, instruction: obligationInstruction(prompt, retry, executed), kind: retry.kind };
  }

  const obligations = normalizeObligations(prompt, tools);
  if (!obligations.length) return null;
  const next = remainingObligation(prompt, obligations, executed, request.messages);
  if (!next) return null;
  return { requiredToolName: next.toolName, instruction: obligationInstruction(prompt, next, executed), kind: next.kind };
}

function schemaRecord(value: unknown): JsonRecord | null {
  return asRecord(value);
}

function requiredFields(tool: ModelToolDefinition): string[] | null {
  const required = tool.inputSchema.required;
  if (required === undefined) return [];
  if (!Array.isArray(required) || !required.every((value): value is string => typeof value === "string")) return null;
  return required;
}

function propertySchema(tool: ModelToolDefinition, field: string): JsonRecord | null {
  const properties = schemaRecord(tool.inputSchema.properties);
  return schemaRecord(properties?.[field]);
}

function enumOrConst(schema: JsonRecord): unknown {
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return schema.enum[0];
  return undefined;
}

function explicitFieldValue(prompt: string, field: string): string | number | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = new RegExp(`\\b${escaped}\\b\\s*(?:=|:|is|to)?\\s*[\u0060\"']?([A-Za-z0-9._:/-]+)[\u0060\"']?`, "i").exec(prompt)?.[1];
  if (!raw) return null;
  const direct = normalizePromptToken(raw);
  if (direct && direct.toLowerCase() !== field.toLowerCase()) return /^\d+$/.test(direct) ? Number(direct) : direct;
  return null;
}

function rankedPath(output: unknown): string | null {
  const record = asRecord(output);
  if (!record) return null;
  if (typeof record.path === "string" && record.path) return record.path;
  const candidates = [record.results, record.matches, record.items].find(Array.isArray);
  if (!Array.isArray(candidates)) return null;
  const paths = candidates
    .map((item, index) => {
      const entry = asRecord(item);
      return entry && typeof entry.path === "string" && entry.path
        ? { path: entry.path, score: typeof entry.score === "number" ? entry.score : -index }
        : null;
    })
    .filter((item): item is { path: string; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);
  return paths[0]?.path ?? null;
}

function searchPhrase(prompt: string): string | null {
  const match = /\b(?:search|find|locate|look\s+up)\b[\s\S]{0,80}?\b(?:for|about)\s+([^,.;\n]{2,180})/i.exec(prompt)?.[1]?.trim();
  if (match) return match;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length >= 2 ? compact.slice(0, 180) : null;
}

function latestOutputField(messages: readonly ModelMessage[], field: string): unknown {
  const history = toolHistory(messages);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const output = asRecord(history[index]?.output);
    if (output && Object.hasOwn(output, field)) return output[field];
  }
  return undefined;
}

function chainField(messages: readonly ModelMessage[], prompt: string, field: string): unknown {
  const history = toolHistory(messages);
  const latest = history[history.length - 1];
  const latestOutput = asRecord(latest?.output);
  if (field === "previousToken") {
    if (typeof latestOutput?.nextToken === "string") return latestOutput.nextToken;
    return explicitFieldValue(prompt, field);
  }
  if (field === "step") {
    if (typeof latestOutput?.step === "number" && Number.isInteger(latestOutput.step)) return latestOutput.step + 1;
    if (typeof latest?.input.step === "number" && Number.isInteger(latest.input.step)) return (latest.input.step as number) + 1;
    const explicit = explicitFieldValue(prompt, field);
    if (typeof explicit === "number") return explicit;
    const start = /\bstart\s+step\s+(\d+)\b/i.exec(prompt)?.[1];
    return start ? Number(start) : null;
  }
  return undefined;
}

function validateSchemaValue(value: unknown, schema: JsonRecord): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) return false;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) return false;
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) return false;
  }
  if (schema.type === "number" && typeof value !== "number") return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  return true;
}

function resolveField(request: GenerateRequest, route: ExecutionObligationRoute, field: string, schema: JsonRecord): unknown {
  const fixed = enumOrConst(schema);
  if (fixed !== undefined) return fixed;

  const prompt = firstUserContent(request.messages);
  const lower = field.toLowerCase();
  let candidate: unknown;

  if (lower === "value") candidate = desiredValue(prompt) ?? explicitFieldValue(prompt, field);
  else if (lower === "expected") candidate = explicitFieldValue(prompt, field) ?? desiredValue(prompt) ?? latestAuthoritativeValue(request.messages);
  else if (lower === "query") candidate = searchPhrase(prompt);
  else if (lower === "path") candidate = rankedPath(latestHistory(request.messages)?.output) ?? explicitFieldValue(prompt, field);
  else if (lower === "previoustoken" || lower === "step") candidate = chainField(request.messages, prompt, field);
  else {
    const sameKey = latestOutputField(request.messages, field);
    candidate = sameKey !== undefined ? sameKey : explicitFieldValue(prompt, field);
  }

  return candidate !== null && candidate !== undefined && validateSchemaValue(candidate, schema) ? candidate : undefined;
}

/**
 * Materialize a required tool call only when every required argument is provable
 * from the declared schema, the original user request, or authoritative prior
 * tool results. If any required value is ambiguous, return null and let the
 * normal Qwen required-tool path handle it fail-closed.
 */
export function materializeExecutionObligation(request: GenerateRequest, route: ExecutionObligationRoute): ModelToolCall | null {
  const tool = request.tools?.find((definition) => definition.name === route.requiredToolName);
  if (!tool) return null;
  const required = requiredFields(tool);
  if (!required) return null;
  const input: Record<string, unknown> = {};
  for (const field of required) {
    const schema = propertySchema(tool, field);
    if (!schema) return null;
    const value = resolveField(request, route, field, schema);
    if (value === undefined) return null;
    input[field] = value;
  }
  return {
    id: `${request.requestId}:runtime-obligation:${toolHistory(request.messages).length + 1}:${route.requiredToolName}`,
    name: route.requiredToolName,
    input
  };
}

export function withExecutionObligation(request: GenerateRequest, route = routeExecutionObligation(request)): GenerateRequest {
  if (!route) return request;
  return {
    ...request,
    requiredToolName: route.requiredToolName,
    temperature: 0,
    messages: [...request.messages, { role: "system", content: route.instruction }]
  };
}
