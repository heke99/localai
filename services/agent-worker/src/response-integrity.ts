import type { TaskAnalysis } from "@div3rsa/agent-runtime";

export interface ResponseIntegrityResult {
  passed: boolean;
  reason: string;
}

const HIDDEN_REASONING = /<think\b|<\/think>|<analysis\b|<\/analysis>/i;
const PSEUDO_TOOL_PROTOCOL = /<tool_call\b|<\/tool_call>|<tool_response\b|<\/tool_response>|<function=|<\/function>|\bcontent_selector\b/i;
const PROVISIONAL_RESEARCH = /\b(?:let me|i(?:'|’)ll|i will|i need to|i should|we need to|next,? i(?:'|’)ll)\b[\s\S]{0,140}\b(?:open|fetch|search|look up|check|inspect|browse)\b/i;

export function evaluateResponseIntegrity(output: string | null | undefined, task?: TaskAnalysis): ResponseIntegrityResult {
  const text = output?.trim() ?? "";
  if (!text) return { passed: false, reason: "Model output is empty." };
  if (HIDDEN_REASONING.test(text)) return { passed: false, reason: "Final output exposes hidden reasoning markup." };
  if (PSEUDO_TOOL_PROTOCOL.test(text)) return { passed: false, reason: "Final output contains tool-protocol markup instead of a user-facing answer." };
  if (task?.requiresCurrentInformation && PROVISIONAL_RESEARCH.test(text)) {
    return { passed: false, reason: "Current-information output is still a research plan instead of a completed grounded answer." };
  }
  return { passed: true, reason: "Final output is non-empty and contains no unfinished reasoning or tool protocol." };
}

export function needsGroundedSynthesis(output: string, task: TaskAnalysis): boolean {
  if (!task.requiresCurrentInformation || task.liveDataKind === "time") return false;
  return !evaluateResponseIntegrity(output, task).passed;
}