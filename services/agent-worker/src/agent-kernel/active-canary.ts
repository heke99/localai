import type { ModelAlias, ModelMessage } from "@div3rsa/model-sdk";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ClaimedRun, WorkerKernelRuntime, WorkerKernelAugmentation } from "../processor";
import type { AgentKernelConfig } from "./config";
import { deterministicProbeSample } from "./shadow-probe";

interface ActiveCanaryModelResult {
  readonly content: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface ActiveCanaryModelRuntime {
  generate(input: {
    requestId: string;
    alias: ModelAlias;
    messages: ModelMessage[];
    temperature: number;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<ActiveCanaryModelResult>;
}

function compactTask(task: TaskAnalysis) {
  return {
    categories: task.categories,
    risk: task.risk,
    complexity: task.complexity,
    reasoningLevel: task.reasoningLevel,
    informationFreshness: task.informationFreshness,
    researchDepth: task.researchDepth,
    requiresCurrentInformation: task.requiresCurrentInformation,
    requiresRepository: task.requiresRepository,
    requiresDatabase: task.requiresDatabase,
    requiresDeployment: task.requiresDeployment,
    requiresSecurityReview: task.requiresSecurityReview,
    verificationRequirements: task.verificationRequirements
  };
}

function safeContent(value: string, max = 6_000): string {
  return value.trim().slice(0, max);
}

export class AgentKernelActiveCanaryRuntime implements WorkerKernelRuntime {
  constructor(
    private readonly config: AgentKernelConfig,
    private readonly model: ActiveCanaryModelRuntime
  ) {}

  async prepare(run: ClaimedRun, task: TaskAnalysis, prompt: string, selectedSkills: readonly string[]): Promise<WorkerKernelAugmentation | null> {
    if (!this.config.enabled || this.config.mode !== "active") return null;
    if (!deterministicProbeSample(run.runId, this.config.activeCanaryBasisPoints)) return null;

    const startedAt = performance.now();
    const compact = compactTask(task);
    const roles: Array<{ role: "planner" | "analyst" | "researcher"; messages: ModelMessage[] }> = [
      {
        role: "planner",
        messages: [
          { role: "system", content: "You are the planner subagent in a bounded production canary. Return a concise execution plan, explicit required evidence, likely failure modes and verification checkpoints. Do not use tools, do not claim work was executed, and do not reveal private chain-of-thought." },
          { role: "user", content: JSON.stringify({ task: compact, selectedSkills, request: prompt.slice(0, 12_000) }) }
        ]
      },
      {
        role: "analyst",
        messages: [
          { role: "system", content: "You are an independent analysis subagent. Identify dependency/consequence risks, state invariants that must remain true, and the smallest safe validation set for this request. Do not use tools or claim execution. Return only concise conclusions." },
          { role: "user", content: JSON.stringify({ task: compact, request: prompt.slice(0, 12_000) }) }
        ]
      }
    ];

    if ((task.requiresCurrentInformation || task.researchDepth !== "none") && roles.length < this.config.maxSubagents) {
      roles.push({
        role: "researcher",
        messages: [
          { role: "system", content: "You are a research-planning subagent. Specify which authoritative evidence types and source categories are needed and what must be verified. You have no tools in this pass, so never claim you searched or fetched anything." },
          { role: "user", content: JSON.stringify({ task: compact, request: prompt.slice(0, 12_000) }) }
        ]
      });
    }

    const limited = roles.slice(0, this.config.maxSubagents);
    const results: Array<{ role: string; content: string; durationMs: number; usage: Readonly<Record<string, number>> }> = [];

    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.config.maxParallelSubagents, limited.length) }, async () => {
      while (cursor < limited.length) {
        const index = cursor++;
        const item = limited[index];
        if (!item) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Agent Kernel active canary timeout", "AbortError")), this.config.activeTimeoutMsPerCall);
        timer.unref?.();
        const callStartedAt = performance.now();
        try {
          const result = await this.model.generate({
            requestId: `${run.requestId}:agent-kernel-active:${item.role}:${index + 1}`,
            alias: run.modelAlias,
            messages: item.messages,
            temperature: 0,
            maxOutputTokens: this.config.activeMaxOutputTokensPerCall,
            signal: controller.signal
          });
          results[index] = {
            role: item.role,
            content: safeContent(result.content),
            durationMs: Math.max(0, performance.now() - callStartedAt),
            usage: { ...(result.usage ?? {}) }
          };
        } finally {
          clearTimeout(timer);
        }
      }
    });

    try {
      await Promise.all(workers);
    } catch {
      return null;
    }

    const completed = results.filter((result): result is NonNullable<typeof result> => Boolean(result?.content));
    if (completed.length === 0) return null;

    return {
      mode: "active-canary",
      instruction: [
        "Agent Kernel V2 bounded subagent findings. Treat these as advisory planning context, not as evidence that any action occurred. Verify all material claims with the actual tools/evidence available in this run.",
        ...completed.map((result) => `### ${result.role}\n${result.content}`)
      ].join("\n\n"),
      telemetry: {
        sampled: true,
        roles: completed.map((result) => ({ role: result.role, durationMs: result.durationMs, usage: result.usage })),
        totalDurationMs: Math.max(0, performance.now() - startedAt)
      }
    };
  }
}
