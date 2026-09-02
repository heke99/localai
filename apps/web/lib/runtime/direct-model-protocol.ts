export type DirectModelMessage = { role: "system" | "user" | "assistant"; content: string };

type StoredMessage = { role?: string | null; content?: unknown };

const DIRECT_SYSTEM_PROMPT = "Direct model mode. No agent loop, tools, web access, repository access, connected resources, or external actions are available in this execution path. Answer from the supplied conversation and model knowledge only. Never claim that an external action was performed.";
const DEFAULT_DIRECT_CONTEXT_TOKENS = 32_768;
const DIRECT_MAX_OUTPUT_TOKENS = 4_096;
const DIRECT_CONTEXT_SAFETY_TOKENS = 1_024;
const CONSERVATIVE_CHARACTERS_PER_TOKEN = 3;

function positiveIntegerEnvironment(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

export function directRuntimeModelName() {
  return process.env.QWEN_RUNTIME_MODEL?.trim()
    || process.env.DIRECT_MODEL_RUNTIME_MODEL?.trim()
    || "localai-qwen38-v3-q8";
}

export function directInferenceApiKey() {
  return process.env.GENERIC_RUNTIME_API_KEY?.trim()
    || process.env.DIV3RSA_INFERENCE_API_KEY?.trim()
    || process.env.QWEN_INFERENCE_API_KEY?.trim()
    || "";
}

export function directModelInputCharacterBudget(
  contextTokens = positiveIntegerEnvironment(["DIV3RSA_MODEL_CONTEXT_SIZE", "QWEN_CONTEXT_SIZE"], DEFAULT_DIRECT_CONTEXT_TOKENS),
  outputTokens = DIRECT_MAX_OUTPUT_TOKENS
): number {
  const usableInputTokens = contextTokens - Math.max(1, Math.floor(outputTokens)) - DIRECT_CONTEXT_SAFETY_TOKENS;
  if (usableInputTokens < 1_024) throw new Error("direct_model_context_configuration_too_small");
  return usableInputTokens * CONSERVATIVE_CHARACTERS_PER_TOKEN;
}

export function storedMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";
  const record = content as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.content === "string") return record.content.trim();
  return "";
}

export function stripThinking(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const openIndex = output.toLowerCase().lastIndexOf("<think>");
  const closeIndex = output.toLowerCase().lastIndexOf("</think>");
  if (openIndex >= 0 && openIndex > closeIndex) output = output.slice(0, openIndex);
  return output.replace(/<\/?think>/gi, "").trim();
}

export function conservativeTokenCount(reported: unknown, texts: readonly string[]): number {
  const numeric = Number(reported);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.trunc(numeric));

  // llama.cpp normally reports exact prompt/completion token counts. If an
  // OpenAI-compatible runtime omits usage, never turn that omission into free
  // quota. ~3 characters/token is deliberately conservative across code and
  // multilingual text; billing remains safe until exact usage is available.
  const characters = texts.reduce((total, text) => total + text.length, 0);
  return characters > 0 ? Math.max(1, Math.ceil(characters / CONSERVATIVE_CHARACTERS_PER_TOKEN)) : 0;
}

export function buildDirectModelMessages(rows: readonly StoredMessage[], maxCharacters = directModelInputCharacterBudget()): DirectModelMessage[] {
  if (!Number.isFinite(maxCharacters) || maxCharacters < 1) throw new Error("direct_model_context_budget_invalid");
  const accepted = rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role as "user" | "assistant", content: storedMessageText(row.content) }))
    .filter((row) => row.content.length > 0);

  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let characters = 0;
  for (let index = accepted.length - 1; index >= 0; index -= 1) {
    const message = accepted[index]!;
    if (characters + message.content.length > maxCharacters) {
      if (selected.length === 0) throw new Error("direct_model_current_message_exceeds_context");
      break;
    }
    selected.push(message);
    characters += message.content.length;
  }
  selected.reverse();
  while (selected[0]?.role === "assistant") selected.shift();

  return [{ role: "system", content: DIRECT_SYSTEM_PROMPT }, ...selected];
}
