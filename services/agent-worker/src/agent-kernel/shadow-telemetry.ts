import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelConfig } from "./config";
import { AGENT_KERNEL_PROTOCOL_VERSION } from "./contracts";
import { AgentKernelShadowOrchestrator, type ShadowKernelInput } from "./shadow-orchestrator";

export interface LegacyExecutionSnapshot {
  readonly executionTier: string;
  readonly repoDepth: string;
  readonly verificationRounds: number;
  readonly selectedSkills: readonly string[];
  readonly toolNames: readonly string[];
}

export interface ShadowTelemetryState {
  readonly protocolVersion: typeof AGENT_KERNEL_PROTOCOL_VERSION;
  readonly mode: "shadow";
  readonly observedAt: string;
  readonly durationMs: number;
  readonly plan: {
    readonly agents: readonly { readonly id: string; readonly role: string; readonly capabilities: readonly string[]; readonly modelAlias: string }[];
    readonly steps: readonly { readonly id: string; readonly agentId: string; readonly dependencies: readonly string[]; readonly capabilities: readonly string[]; readonly verificationRequired: boolean }[];
    readonly parallelWaves: readonly (readonly string[])[];
  };
  readonly metrics: {
    readonly agentCount: number;
    readonly stepCount: number;
    readonly maxParallelWidth: number;
    readonly requiresVerification: boolean;
  };
  readonly baseline: LegacyExecutionSnapshot;
  readonly comparison: {
    readonly aligned: boolean;
    readonly differences: readonly string[];
  };
}

export type ShadowTelemetryOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "observed"; readonly state: ShadowTelemetryState }
  | { readonly status: "planning_error"; readonly errorCode: string }
  | { readonly status: "persistence_error"; readonly errorCode: string };

export interface ShadowTelemetrySink {
  record(runId: string, state: ShadowTelemetryState): Promise<void>;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_shadow_telemetry_error");
  return message.slice(0, 160);
}

function compare(task: TaskAnalysis, state: ReturnType<AgentKernelShadowOrchestrator["observe"]>, baseline: LegacyExecutionSnapshot): string[] {
  if (!state) return [];
  const stepIds = new Set(state.plan.steps.map((step) => step.id));
  const differences: string[] = [];
  const researchExpected = task.requiresCurrentInformation || task.researchDepth !== "none";
  const executionExpected = true;
  const verificationExpected = baseline.verificationRounds > 0 || task.verificationRequirements.length > 0;

  if (stepIds.has("research") !== researchExpected) differences.push("research_step_mismatch");
  if (stepIds.has("execute") !== executionExpected) differences.push("execution_step_mismatch");
  if ((state.plan.finalVerifierAgentId !== null) !== verificationExpected) differences.push("verification_step_mismatch");
  if (state.metrics.maxParallelWidth < 1) differences.push("parallel_width_invalid");
  if (state.metrics.agentCount < 2) differences.push("agent_count_below_minimum");
  return differences;
}

export class AgentKernelShadowTelemetry {
  private readonly orchestrator: AgentKernelShadowOrchestrator;

  constructor(config: AgentKernelConfig, private readonly sink: ShadowTelemetrySink) {
    this.orchestrator = new AgentKernelShadowOrchestrator(config);
  }

  async observe(input: ShadowKernelInput, baseline: LegacyExecutionSnapshot): Promise<ShadowTelemetryOutcome> {
    const startedAt = performance.now();
    let observation: ReturnType<AgentKernelShadowOrchestrator["observe"]>;
    try {
      observation = this.orchestrator.observe(input);
    } catch (error) {
      return { status: "planning_error", errorCode: errorCode(error) };
    }
    if (!observation) return { status: "skipped" };

    const differences = compare(input.task, observation, baseline);
    const state: ShadowTelemetryState = {
      protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
      mode: "shadow",
      observedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - startedAt),
      plan: {
        agents: observation.plan.agents.map((agent) => ({
          id: agent.agentId,
          role: agent.role,
          capabilities: [...agent.capabilities],
          modelAlias: agent.modelAlias
        })),
        steps: observation.plan.steps.map((step) => ({
          id: step.id,
          agentId: step.assignedAgentId,
          dependencies: [...step.dependsOn],
          capabilities: [...step.requiredCapabilities],
          verificationRequired: step.verificationRequired
        })),
        parallelWaves: observation.parallelWaves.map((wave) => [...wave])
      },
      metrics: observation.metrics,
      baseline,
      comparison: {
        aligned: differences.length === 0,
        differences
      }
    };

    try {
      await this.sink.record(input.runId, state);
      return { status: "observed", state };
    } catch (error) {
      return { status: "persistence_error", errorCode: errorCode(error) };
    }
  }
}
