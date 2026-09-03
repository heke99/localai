import type { GenerateRequest, ModelMessage } from "@div3rsa/model-sdk";
import { routeExecutionObligation } from "./execution-obligation-router";

type JsonRecord = Record<string, unknown>;

const FINAL_REPORT_INTENT = /\b(?:reply|respond|answer)\s+(?:with\s+)?|\breport\b|\breturn\b|\boutput\b|\bprovide\b/i;
const NAMED_TOKEN = /\b[A-Z][A-Z0-9_]*_TOKEN\b/g;

function parseToolOutput(message: ModelMessage): unknown {
  if (message.role !== "tool") return null;
  try { return JSON.parse(message.content) as unknown; }
  catch { return null; }
}

function toolOutputs(messages: readonly ModelMessage[]): unknown[] {
  return messages.filter((message) => message.role === "tool").map(parseToolOutput).filter((value) => value !== null);
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function fieldFromValue(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = fieldFromValue(value[index], field);
      if (found !== null) return found;
    }
    return null;
  }
  const entries = Object.entries(value as JsonRecord);
  for (const [key, item] of entries) {
    if (key.toLowerCase() === field.toLowerCase()) {
      const scalar = scalarString(item);
      if (scalar !== null) return scalar;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const found = fieldFromValue(entries[index]?.[1], field);
    if (found !== null) return found;
  }
  return null;
}

function latestField(outputs: readonly unknown[], fields: readonly string[]): string | null {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    for (const field of fields) {
      const value = fieldFromValue(outputs[index], field);
      if (value !== null) return value;
    }
  }
  return null;
}

function allStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) allStrings(item, target);
    return;
  }
  for (const item of Object.values(value as JsonRecord)) allStrings(item, target);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedAssignment(outputs: readonly unknown[], identifier: string): string | null {
  const escaped = escapeRegExp(identifier);
  const patterns = [
    new RegExp(`\\b${escaped}\\b\\s*=\\s*"([^"\\r\\n]+)"`),
    new RegExp(`\\b${escaped}\\b\\s*=\\s*'([^'\\r\\n]+)'`),
    new RegExp("\\b" + escaped + "\\b\\s*=\\s*`([^`\\r\\n]+)`")
  ];
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const strings: string[] = [];
    allStrings(outputs[index], strings);
    for (const text of strings) {
      for (const pattern of patterns) {
        const match = pattern.exec(text)?.[1];
        if (match) return match;
      }
    }
  }
  return null;
}

/**
 * Returns a final scalar only when execution obligations are complete and the
 * original user explicitly asked to report an authoritative field/token that is
 * present in runtime tool output. No model text, inferred value, or guessed path
 * is accepted as completion evidence.
 */
export function materializeExecutionGroundedAnswer(request: GenerateRequest): string | null {
  const tools = request.tools ?? [];
  if (!tools.length || request.requiredToolName?.trim()) return null;
  const prompt = request.messages.find((message) => message.role === "user")?.content ?? "";
  if (!prompt || !FINAL_REPORT_INTENT.test(prompt)) return null;
  const outputs = toolOutputs(request.messages);
  if (!outputs.length || routeExecutionObligation(request) !== null) return null;

  if (/\bevidenceToken\b/i.test(prompt)) {
    const value = latestField(outputs, ["evidenceToken"]);
    if (value !== null) return value;
  }

  if (/\bnextToken\b/i.test(prompt)) {
    const value = latestField(outputs, ["nextToken"]);
    if (value !== null) return value;
  }

  const identifiers = Array.from(new Set(prompt.match(NAMED_TOKEN) ?? []));
  for (const identifier of identifiers) {
    const direct = latestField(outputs, [identifier]);
    if (direct !== null) return direct;
    const assigned = namedAssignment(outputs, identifier);
    if (assigned !== null) return assigned;
  }

  if (/\breport\s+(?:its\s+|the\s+|current\s+)?value\b/i.test(prompt) || /\b(?:reply|answer|return|output)\b[\s\S]{0,40}\bvalue\b/i.test(prompt)) {
    return latestField(outputs, ["value", "currentValue", "state", "currentState", "actual"]);
  }

  return null;
}
