import type { GenerateResult, ModelMessage } from "@div3rsa/model-sdk";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";

export type GroundingToolTrace = {
  sequence: number;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  return typeof value?.[key] === "string" && value[key].trim() ? value[key].trim() : null;
}

function asksForDate(prompt: string): boolean {
  return /\b(?:date|today(?:'s)?|datum|dagens\s+datum|vilket\s+datum|yyyy[- /]?mm[- /]?dd)\b/i.test(prompt);
}

function asksForClock(prompt: string): boolean {
  return /\b(?:what\s+time|current\s+time|local\s+time|klockan|vad\s+är\s+klockan|hur\s+mycket\s+är\s+klockan|hh:mm)\b/i.test(prompt);
}

function asksForLatestValue(prompt: string): boolean {
  return /\b(?:latest|current|newest|most\s+recent|senaste|nyaste|aktuell(?:a|t)?)\b/i.test(prompt);
}

export function deterministicTimeResult(task: TaskAnalysis, prompt: string, trace: GroundingToolTrace[]): GenerateResult | null {
  if (!task.requiresCurrentInformation || task.liveDataKind !== "time") return null;
  const call = [...trace].reverse().find((item) => item.name === "current_time");
  const output = record(call?.output);
  if (!output) return null;

  const timezone = stringField(output, "timezone") ?? "requested timezone";
  const localDate = stringField(output, "localDate");
  const localTime = stringField(output, "localTime");
  const localIso = stringField(output, "localIso");
  const wantsDate = asksForDate(prompt);
  const wantsClock = asksForClock(prompt);

  let content: string | null = null;
  if (wantsDate && !wantsClock && localDate) {
    content = /yyyy[- /]?mm[- /]?dd/i.test(prompt) ? localDate : `The current date in ${timezone} is ${localDate}.`;
  } else if (wantsClock && !wantsDate && localTime) {
    content = `The current time in ${timezone} is ${localTime}.`;
  } else if (localIso) {
    content = `The current date and time in ${timezone} is ${localIso}.`;
  } else if (localDate && localTime) {
    content = `The current date and time in ${timezone} is ${localDate} ${localTime}.`;
  } else if (localDate) {
    content = localDate;
  } else if (localTime) {
    content = `The current time in ${timezone} is ${localTime}.`;
  }

  if (!content) return null;
  return {
    modelVersionId: "deterministic-current-time-v1",
    content,
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  };
}

export function groundedSynthesisMessages(input: {
  messages: ModelMessage[];
  draft: string;
  originalPrompt: string;
  attempt: number;
}): ModelMessage[] {
  const { messages, draft, originalPrompt, attempt } = input;
  const retry = attempt > 0
    ? "The previous synthesis was not a valid final answer. Correct it now and return only the completed answer."
    : "The research/tool phase is complete. Produce the final answer now.";
  const currentValueInstruction = asksForLatestValue(originalPrompt)
    ? " This is a latest/current request. Prefer opened evidence that explicitly identifies a value as latest, current, newest, or most recent over a version-specific release page that may only document an older historical release. If the evidence distinguishes release tracks such as Current/Latest Release and LTS, answer the exact track the user asked for. Do not substitute LTS for Current or Current for LTS. If the strongest opened evidence does not identify the requested current value unambiguously, say so instead of inferring it from a stale page or model memory."
    : "";
  return [
    ...messages,
    ...(draft.trim() ? [{ role: "assistant" as const, content: draft }] : []),
    {
      role: "user",
      content: `${retry}\n\nOriginal request: ${originalPrompt}\n\nUse only facts supported by the tool evidence already present in this conversation. Do not call, request, imitate, or describe any tool. Do not output <tool_call>, <function>, content_selector, hidden reasoning, or a plan for future research. Resolve the user's requested current value concretely from the opened evidence.${currentValueInstruction} If the user asked for a source, name the source and include its URL when available in the evidence. If sources conflict or do not support a concrete answer, say that plainly instead of guessing. Answer the original request directly and concisely.`
    }
  ];
}

export function mergeUsage(
  left: GenerateResult["usage"],
  right: GenerateResult["usage"]
): GenerateResult["usage"] {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens
  };
}
