import type { ModelAlias, ModelMessage } from "@div3rsa/model-sdk";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelConfig } from "./config";
import { deterministicProbeSample } from "./shadow-probe";
import { buildSpecialistPlan, specialistInstruction, type SpecialistPlanEntry } from "./specialist-context";

interface ActiveCanaryModelResult { readonly content: string; readonly usage?: Readonly<Record<string, number>>; }
export interface ActiveCanaryModelRuntime { generate(input: { requestId: string; alias: ModelAlias; messages: ModelMessage[]; temperature: number; maxOutputTokens: number; signal: AbortSignal; }): Promise<ActiveCanaryModelResult>; }
export interface ActiveCanaryInput { readonly runId: string; readonly requestId: string; readonly modelAlias: ModelAlias; readonly prompt: string; readonly task: TaskAnalysis; readonly selectedSkills: readonly string[]; }
export interface ActiveCanaryAugmentation {
  readonly mode: "active-canary";
  readonly instruction: string;
  readonly telemetry: { readonly sampled: true; readonly roles: readonly { readonly role: string; readonly execution: string; readonly allowedToolClasses: readonly string[]; readonly durationMs: number; readonly usage: Readonly<Record<string, number>>; }[]; readonly totalDurationMs: number; };
}

function safeContent(value: string, max = 6_000): string { return value.trim().slice(0, max); }

export class AgentKernelActiveCanaryRuntime {
  constructor(private readonly config: AgentKernelConfig, private readonly model: ActiveCanaryModelRuntime) {}

  private async runEntry(input: ActiveCanaryInput, entry: SpecialistPlanEntry, index: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Agent Kernel active canary timeout", "AbortError")), this.config.activeTimeoutMsPerCall);
    timer.unref?.();
    const started = performance.now();
    try {
      const result = await this.model.generate({
        requestId: `${input.requestId}:agent-kernel-active:${entry.role}:${index + 1}`,
        alias: input.modelAlias,
        messages: [
          { role: "system", content: specialistInstruction(entry.role, entry.allowedToolClasses) },
          { role: "user", content: JSON.stringify(entry.context) }
        ],
        temperature: 0,
        maxOutputTokens: this.config.activeMaxOutputTokensPerCall,
        signal: controller.signal
      });
      return { role: entry.role, execution: entry.execution, allowedToolClasses: entry.allowedToolClasses, content: safeContent(result.content), durationMs: Math.max(0, performance.now() - started), usage: { ...(result.usage ?? {}) } };
    } finally { clearTimeout(timer); }
  }

  async prepare(input: ActiveCanaryInput): Promise<ActiveCanaryAugmentation | null> {
    if (!this.config.enabled || this.config.mode !== "active") return null;
    if (!deterministicProbeSample(input.runId, this.config.activeCanaryBasisPoints)) return null;
    const startedAt = performance.now();
    const plan = buildSpecialistPlan({ task: input.task, prompt: input.prompt, selectedSkills: input.selectedSkills, maxSubagents: this.config.maxSubagents, maxPromptChars: 8_000 });
    const results: Array<Awaited<ReturnType<AgentKernelActiveCanaryRuntime["runEntry"]>>> = [];
    try {
      const readonly = plan.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.execution === "parallel-readonly");
      let cursor = 0;
      const workers = Array.from({ length: Math.min(this.config.maxParallelSubagents, readonly.length) }, async () => {
        while (cursor < readonly.length) {
          const item = readonly[cursor++]; if (!item) continue;
          results.push(await this.runEntry(input, item.entry, item.index));
        }
      });
      await Promise.all(workers);
      for (const { entry, index } of plan.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.execution === "serial")) {
        results.push(await this.runEntry(input, entry, index));
      }
    } catch { return null; }
    const completed = results.filter((result) => Boolean(result.content));
    if (!completed.length) return null;
    return {
      mode: "active-canary",
      instruction: [
        "Agent Kernel V2 specialist findings. These are advisory, role-isolated conclusions, not proof that any tool/action occurred. Current tool evidence, user constraints, checkpoints and independent verification remain authoritative.",
        ...completed.map((result) => `### ${result.role}\n${result.content}`)
      ].join("\n\n"),
      telemetry: { sampled: true, roles: completed.map(({ role, execution, allowedToolClasses, durationMs, usage }) => ({ role, execution, allowedToolClasses, durationMs, usage })), totalDurationMs: Math.max(0, performance.now() - startedAt) }
    };
  }
}
