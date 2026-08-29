import type { KernelRunMode } from "./contracts";

export interface AgentKernelConfig {
  readonly enabled: boolean;
  readonly mode: KernelRunMode;
  readonly maxSubagents: number;
  readonly maxParallelSubagents: number;
  readonly verificationRequired: boolean;
  readonly activeCanaryBasisPoints: number;
  readonly activeTimeoutMsPerCall: number;
  readonly activeMaxOutputTokensPerCall: number;
}

type EnvironmentMap = Readonly<Record<string, string | undefined>>;

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid_boolean_environment:${value}`);
}

function integerValue(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid_positive_integer_environment:${name}`);
  return parsed;
}

function basisPointsValue(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error(`invalid_basis_points_environment:${name}`);
  return parsed;
}

function modeValue(value: string | undefined): KernelRunMode {
  const normalized = value?.trim().toLowerCase() || "legacy";
  if (normalized === "legacy" || normalized === "shadow" || normalized === "active") return normalized;
  throw new Error(`invalid_agent_kernel_mode:${value}`);
}

export function agentKernelConfigFromEnvironment(env: EnvironmentMap = process.env): AgentKernelConfig {
  const enabled = booleanValue(env.DIV3RSA_AGENT_KERNEL_V2_ENABLED, false);
  const requestedMode = modeValue(env.DIV3RSA_AGENT_KERNEL_V2_MODE);
  const mode: KernelRunMode = enabled ? requestedMode : "legacy";
  const maxSubagents = integerValue(env.DIV3RSA_AGENT_KERNEL_V2_MAX_SUBAGENTS, 4, "DIV3RSA_AGENT_KERNEL_V2_MAX_SUBAGENTS");
  const maxParallelSubagents = integerValue(env.DIV3RSA_AGENT_KERNEL_V2_MAX_PARALLEL_SUBAGENTS, 2, "DIV3RSA_AGENT_KERNEL_V2_MAX_PARALLEL_SUBAGENTS");

  if (maxParallelSubagents > maxSubagents) {
    throw new Error("agent_kernel_parallel_subagents_exceeds_total");
  }

  return {
    enabled,
    mode,
    maxSubagents,
    maxParallelSubagents,
    verificationRequired: booleanValue(env.DIV3RSA_AGENT_KERNEL_V2_VERIFICATION_REQUIRED, true),
    activeCanaryBasisPoints: basisPointsValue(env.DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS, 0, "DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS"),
    activeTimeoutMsPerCall: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_ACTIVE_TIMEOUT_MS, 4_000, "DIV3RSA_AGENT_KERNEL_V2_ACTIVE_TIMEOUT_MS"),
    activeMaxOutputTokensPerCall: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_ACTIVE_MAX_OUTPUT_TOKENS, 384, "DIV3RSA_AGENT_KERNEL_V2_ACTIVE_MAX_OUTPUT_TOKENS")
  };
}
