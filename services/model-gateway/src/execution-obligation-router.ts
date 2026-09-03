import type { GenerateRequest, ModelMessage, ModelToolDefinition } from "@div3rsa/model-sdk";

export interface ExecutionObligationRoute {
  requiredToolName: string;
  instruction: string;
}

type ObligationKind = "read" | "write" | "verify" | "search" | "open" | "chain" | "exact";
type Obligation = { kind: ObligationKind; toolName: string; position: number };

const ACTION_PATTERNS: Record<Exclude<ObligationKind, "exact">, RegExp> = {
  read: /\b(?:read|retrieve|get|load|inspect\s+the\s+(?:current\s+)?(?:value|state|record))\b/i,
  write: /\b(?:set|change|update|write|mutate)\b/i,
  verify: /\b(?:verify|confirm|validate|check)\b/i,
  search: /\b(?:search|find|locate|look\s+up)\b/i,
  open: /\b(?:open|inspect\s+that\s+file|fetch\s+that\s+file)\b/i,
  chain: /\b(?:ordered\s+)?(?:fixture\s+)?chain\s+steps?\b/i
};

const IMPERATIVE_EXECUTION = /\b(?:call|use|run|execute|read|retrieve|get|set|change|update|write|mutate|verify|confirm|validate|check|search|find|locate|open|retry|complete)\b/i;
const EXPLANATORY_ONLY = /^\s*(?:explain|describe|what\s+is|how\s+does|why\s+does|tell\s+me\s+about)\b/i;
const READ_FIRST = /\bread\s+first\b/i;
const READ_ONLY = /\bread[- ]only\b|\bdo\s+not\s+(?:call\s+any\s+)?(?:mutation|write|set|update|change)\b|\bwithout\s+(?:changing|mutating|writing|updating)\b/i;
const IDEMPOTENT = /\bidempotent(?:ly)?\b|\bonly\s+if\s+needed\b|\bchange\s+only\s+if\s+needed\b/i;
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

function executedToolNames(messages: readonly ModelMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) names.push(call.name);
  }
  return names;
}

function latestToolMessage(messages: readonly ModelMessage[]): ModelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "tool") return message;
  }
  return null;
}

function parseToolResult(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolText(tool: ModelToolDefinition): string {
  return `${tool.name} ${tool.description ?? ""}`.toLowerCase();
}

function scoreTool(tool: ModelToolDefinition, kind: Exclude<ObligationKind, "exact">): number {
  const text = toolText(tool);
  const name = tool.name.toLowerCase();
  const exactNamePatterns: Record<Exclude<ObligationKind, "exact">, RegExp> = {
    read: /(?:^|[._:-])(?:read|get|retrieve|load)(?:$|[._:-])|_read$|read$/,
    write: /(?:^|[._:-])(?:set|write|update|mutate|change)(?:$|[._:-])|_(?:set|write|update)$/,
    verify: /(?:^|[._:-])(?:verify|check|confirm|validate)(?:$|[._:-])|_(?:verify|check)$/,
    search: /(?:^|[._:-])(?:search|find|lookup)(?:$|[._:-])|_(?:search|find)$/,
    open: /(?:^|[._:-])(?:open|fetch|get_file|read_file)(?:$|[._:-])|_(?:open|fetch)$/,
    chain: /chain.*step|step.*chain/
  };
  const wordPatterns: Record<Exclude<ObligationKind, "exact">, RegExp> = {
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

function chooseTool(kind: Exclude<ObligationKind, "exact">, tools: readonly ModelToolDefinition[]): string | null {
  let best: { name: string; score: number } | null = null;
  for (const tool of tools) {
    const score = scoreTool(tool, kind);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { name: tool.name, score };
  }
  return best?.name ?? null;
}

function actionPosition(prompt: string, kind: Exclude<ObligationKind, "exact">): number {
  const match = ACTION_PATTERNS[kind].exec(prompt);
  return match?.index ?? -1;
}

function chainCount(prompt: string): number {
  const nearChain = /\b(?:exactly\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ordered\s+)?(?:fixture\s+)?chain\s+steps?\b/i.exec(prompt);
  if (!nearChain?.[1]) return 1;
  const raw = nearChain[1].toLowerCase();
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 20) return numeric;
  return NUMBER_WORDS[raw] ?? 1;
}

function desiredIdempotentValue(prompt: string): string | null {
  const patterns = [
    /\b(?:set|change|update|write)\b[\s\S]{0,100}?\bto\s+[`"']?([A-Za-z0-9._:-]+)[`"']?/i,
    /\bto\s+[`"']?([A-Za-z0-9._:-]+)[`"']?\s+idempotent(?:ly)?\b/i
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(prompt)?.[1];
    if (value) return value;
  }
  return null;
}

function latestAuthoritativeValue(messages: readonly ModelMessage[]): string | null {
  const latest = latestToolMessage(messages);
  if (!latest) return null;
  const parsed = parseToolResult(latest.content);
  if (!parsed) return null;
  const candidates = [parsed.value, parsed.currentValue, parsed.state, parsed.currentState];
  return candidates.find((value): value is string => typeof value === "string") ?? null;
}

function latestRetryableTool(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[]): string | null {
  const latest = latestToolMessage(messages);
  if (!latest?.name || !tools.some((tool) => tool.name === latest.name)) return null;
  const parsed = parseToolResult(latest.content);
  if (!parsed) return null;
  return parsed.retryable === true ? latest.name : null;
}

function explicitToolObligations(prompt: string, tools: readonly ModelToolDefinition[]): Obligation[] {
  const obligations: Obligation[] = [];
  for (const tool of tools) {
    const index = prompt.indexOf(tool.name);
    if (index >= 0) obligations.push({ kind: "exact", toolName: tool.name, position: index });
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
      const count = chainCount(prompt);
      for (let index = 0; index < count; index += 1) obligations.push({ kind: "chain", toolName, position: chainPosition + index / 100 });
    }
  }
  return obligations;
}

function normalizeObligations(prompt: string, tools: readonly ModelToolDefinition[]): Obligation[] {
  const combined = [...explicitToolObligations(prompt, tools), ...semanticObligations(prompt, tools)]
    .sort((a, b) => a.position - b.position);

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
    if (actual === expected.toolName) {
      queue.shift();
      executedIndex += 1;
      continue;
    }
    executedIndex += 1;
  }

  if (IDEMPOTENT.test(prompt) && queue[0]?.kind === "write") {
    const desired = desiredIdempotentValue(prompt);
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
    route.kind === "search" ? "For search queries, preserve the full material search token or phrase from the user request instead of shortening it." : "",
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
    return {
      requiredToolName: retryTool,
      instruction: obligationInstruction(prompt, { kind: "exact", toolName: retryTool, position: -1 }, executed)
    };
  }

  const obligations = normalizeObligations(prompt, tools);
  if (!obligations.length) return null;
  const next = remainingObligation(prompt, obligations, executed, request.messages);
  if (!next) return null;
  return { requiredToolName: next.toolName, instruction: obligationInstruction(prompt, next, executed) };
}

export function withExecutionObligation(request: GenerateRequest): GenerateRequest {
  const route = routeExecutionObligation(request);
  if (!route) return request;
  return {
    ...request,
    requiredToolName: route.requiredToolName,
    temperature: 0,
    messages: [...request.messages, { role: "system", content: route.instruction }]
  };
}
