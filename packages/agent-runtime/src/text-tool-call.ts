import type { ModelToolDefinition } from "@div3rsa/model-sdk";

export type TextToolIntentReason =
  | "registered_invocation"
  | "explicit_registered_intent"
  | "text_tool_envelope"
  | "unstructured_execution";

export interface TextToolIntent {
  toolName: string | null;
  reason: TextToolIntentReason;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function registeredToolNames(tools: readonly ModelToolDefinition[]): string[] {
  return tools.map((tool) => tool.name.trim()).filter(Boolean);
}

function invocationToolName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  for (const toolName of registeredToolNames(tools)) {
    const invocationPattern = new RegExp(
      `(?:^|[^A-Za-z0-9_])${escapeRegExp(toolName)}\\s*\\(`,
      "m"
    );
    if (invocationPattern.test(content)) return toolName;
  }
  return null;
}

function envelopeToolName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  const envelope = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const allowed = new Set(registeredToolNames(tools));
  for (const match of content.matchAll(envelope)) {
    const payload = match[1] ?? "";
    const name = /["']name["']\s*:\s*["']([^"']+)["']/i.exec(payload)?.[1]?.trim();
    if (name && allowed.has(name)) return name;
  }
  return null;
}

function explicitIntentToolName(content: string, tools: readonly ModelToolDefinition[]): string | null {
  for (const toolName of registeredToolNames(tools)) {
    const escaped = escapeRegExp(toolName);
    const patterns = [
      new RegExp(`\\b(?:i\\s+)?(?:need|must|will|shall|am\\s+going\\s+to)\\s+(?:to\\s+)?(?:use|call|run|invoke)\\s+(?:the\\s+)?${escaped}\\b`, "i"),
      new RegExp(`\\b(?:jag\\s+)?(?:behöver|måste|ska|kommer\\s+att)\\s+(?:använda|köra|anropa)\\s+(?:verktyget\\s+)?${escaped}\\b`, "i")
    ];
    if (patterns.some((pattern) => pattern.test(content))) return toolName;
  }
  return null;
}

const commandLikeExecutionPattern = /(?:```(?:bash|sh|shell|zsh|powershell)?\s*[\s\S]*?\b(?:curl|wget|nmap|dig|nslookup|ping)\b|(?:^|\n)\s*(?:\$\s*)?(?:curl|wget|nmap|dig|nslookup|ping)\b)/i;
const executionIntentPattern = /\b(?:behöver|måste|ska|need|needs|must|will|going\s+to)\b[\s\S]{0,240}\b(?:bekräfta|verifiera|testa|köra|confirm|verify|check|test|run|execute)\b/i;

function looksLikeUnstructuredExecution(content: string): boolean {
  return commandLikeExecutionPattern.test(content) && executionIntentPattern.test(content);
}

export function detectRegisteredToolIntent(
  content: string,
  tools: readonly ModelToolDefinition[]
): TextToolIntent | null {
  if (!content) return null;

  const invocation = invocationToolName(content, tools);
  if (invocation) return { toolName: invocation, reason: "registered_invocation" };

  const envelope = envelopeToolName(content, tools);
  if (envelope) return { toolName: envelope, reason: "text_tool_envelope" };

  const explicit = explicitIntentToolName(content, tools);
  if (explicit) return { toolName: explicit, reason: "explicit_registered_intent" };

  if (looksLikeUnstructuredExecution(content)) {
    return { toolName: null, reason: "unstructured_execution" };
  }

  return null;
}

export function looksLikeRegisteredToolInvocation(
  content: string,
  tools: readonly ModelToolDefinition[]
): boolean {
  return invocationToolName(content, tools) !== null;
}
