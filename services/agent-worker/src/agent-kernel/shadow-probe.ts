import { createHash } from "node:crypto";
import type { ModelAlias, ModelMessage } from "@div3rsa/model-sdk";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelShadowProbeConfig } from "./shadow-probe-config";

export interface ShadowProbeModelResult {
  readonly content: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface ShadowProbeModelRuntime {
  generate(input: {
    requestId: string;
    alias: ModelAlias;
    messages: ModelMessage[];
    temperature: number;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<ShadowProbeModelResult>;
}

export interface ShadowProbeInput {
  readonly runId: string;
  readonly requestId: string;
  readonly modelAlias: ModelAlias;
  readonly prompt: string;
  readonly baselineAnswer: string;
  readonly task: TaskAnalysis;
  readonly selectedSkills: readonly string[];
}

export interface ShadowProbeObservation {
  readonly sampled: true;
  readonly calls: readonly {
    readonly role: "planner" | "researcher" | "verifier";
    readonly modelAlias: string;
    readonly durationMs: number;
    readonly outputHash: string;
    readonly outputChars: number;
    readonly usage: Readonly<Record<string, number>>;
  }[];
  readonly quality: {
    readonly score: number | null;
    readonly passed: boolean | null;
    readonly reasonCode: string;
  };
  readonly totalDurationMs: number;
}

export type ShadowProbeOutcome =
  | { readonly status: "disabled" | "not_sampled" | "capacity_skipped" }
  | { readonly status: "completed"; readonly observation: ShadowProbeObservation }
  | { readonly status: "probe_error"; readonly errorCode: string };

function outputHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function deterministicProbeSample(runId: string, basisPoints: number): boolean {
  if (basisPoints <= 0) return false;
  if (basisPoints >= 10_000) return true;
  const digest = createHash("sha256").update(runId).digest();
  return digest.readUInt32BE(0) % 10_000 < basisPoints;
}

function parseQuality(content: string): ShadowProbeObservation["quality"] {
  try {
    const parsed = JSON.parse(content) as { score?: unknown; passed?: unknown; reasonCode?: unknown };
    const score = typeof parsed.score === "number" && Number.isFinite(parsed.score)
      ? Math.max(0, Math.min(100, Math.round(parsed.score)))
      : null;
    const passed = typeof parsed.passed === "boolean" ? parsed.passed : null;
    const reasonCode = typeof parsed.reasonCode === "string" && /^[a-z0-9_-]{1,80}$/i.test(parsed.reasonCode)
      ? parsed.reasonCode
      : "verifier_output_unparsed";
    return { score, passed, reasonCode };
  } catch {
    return { score: null, passed: null, reasonCode: "verifier_output_unparsed" };
  }
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
    requiresLiveData: task.requiresLiveData,
    requiresRepository: task.requiresRepository,
    requiresBrowser: task.requiresBrowser,
    requiresDatabase: task.requiresDatabase,
    requiresDeployment: task.requiresDeployment,
    requiresSecurityReview: task.requiresSecurityReview,
    verificationRequirements: task.verificationRequirements
  };
}

export class AgentKernelShadowProbeRunner {
  private active = 0;

  constructor(
    private readonly config: AgentKernelShadowProbeConfig,
    private readonly models: ShadowProbeModelRuntime
  ) {}

  async run(input: ShadowProbeInput): Promise<ShadowProbeOutcome> {
    if (!this.config.enabled) return { status: "disabled" };
    if (!deterministicProbeSample(input.runId, this.config.sampleBasisPoints)) return { status: "not_sampled" };
    if (this.active >= this.config.maxConcurrent) return { status: "capacity_skipped" };

    this.active += 1;
    const startedAt = performance.now();
    try {
      const calls: ShadowProbeObservation["calls"][number][] = [];
      let callCount = 0;

      const invoke = async (role: "planner" | "researcher" | "verifier", alias: ModelAlias, messages: ModelMessage[]) => {
        if (callCount >= this.config.maxCallsPerRun) throw new Error("agent_kernel_shadow_probe_call_budget_exhausted");
        callCount += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Shadow probe timeout", "AbortError")), this.config.timeoutMsPerCall);
        timer.unref?.();
        const callStartedAt = performance.now();
        try {
          const result = await this.models.generate({
            requestId: `${input.requestId}:agent-kernel-shadow:${role}:${callCount}`,
            alias,
            messages,
            temperature: 0,
            maxOutputTokens: this.config.maxOutputTokensPerCall,
            signal: controller.signal
          });
          calls.push({
            role,
            modelAlias: alias,
            durationMs: Math.max(0, performance.now() - callStartedAt),
            outputHash: outputHash(result.content),
            outputChars: result.content.length,
            usage: { ...(result.usage ?? {}) }
          });
          return result.content;
        } finally {
          clearTimeout(timer);
        }
      };

      const task = compactTask(input.task);
      const planner = await invoke("planner", input.modelAlias, [
        { role: "system", content: "You are a shadow planner. Do not use tools and do not claim execution. Produce a compact plan that identifies required evidence, risks, checks and likely failure modes. Do not reveal private chain-of-thought; return only concise conclusions." },
        { role: "user", content: JSON.stringify({ task, selectedSkills: input.selectedSkills, request: input.prompt.slice(0, 12_000) }) }
      ]);

      let researcher = "not_required";
      if ((input.task.requiresCurrentInformation || input.task.researchDepth !== "none") && callCount < this.config.maxCallsPerRun) {
        researcher = await invoke("researcher", input.modelAlias, [
          { role: "system", content: "You are a tool-free shadow researcher. Do not answer from memory. Return only the authoritative evidence types, source categories and search/fetch actions that would be needed to verify this request. Never claim that you actually searched." },
          { role: "user", content: JSON.stringify({ task, request: input.prompt.slice(0, 12_000), planner: planner.slice(0, 6_000) }) }
        ]);
      }

      let quality: ShadowProbeObservation["quality"] = { score: null, passed: null, reasonCode: "verifier_not_run" };
      if (callCount < this.config.maxCallsPerRun) {
        const verifier = await invoke("verifier", "verifier-prod", [
          { role: "system", content: "You are an independent shadow quality verifier. Judge the existing baseline answer against the supplied task and shadow planning evidence. Do not use tools. Return JSON only: {\"score\":0-100,\"passed\":boolean,\"reasonCode\":\"short_machine_code\"}. Score factual support, completeness, constraint adherence and whether required evidence is missing." },
          { role: "user", content: JSON.stringify({ task, planner: planner.slice(0, 6_000), researcher: researcher.slice(0, 6_000), baselineAnswer: input.baselineAnswer.slice(0, 16_000) }) }
        ]);
        quality = parseQuality(verifier);
      }

      return {
        status: "completed",
        observation: {
          sampled: true,
          calls,
          quality,
          totalDurationMs: Math.max(0, performance.now() - startedAt)
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "agent_kernel_shadow_probe_failed");
      return { status: "probe_error", errorCode: message.slice(0, 160) };
    } finally {
      this.active -= 1;
    }
  }
}
