type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export interface AgentKernelShadowProbeConfig {
  readonly enabled: boolean;
  readonly sampleBasisPoints: number;
  readonly maxConcurrent: number;
  readonly maxCallsPerRun: number;
  readonly maxOutputTokensPerCall: number;
  readonly timeoutMsPerCall: number;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid_boolean_environment:${value}`);
}

function integerValue(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid_integer_environment:${name}`);
  return parsed;
}

export function shadowProbeConfigFromEnvironment(env: EnvironmentMap = process.env): AgentKernelShadowProbeConfig {
  const enabled = booleanValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED, false);
  const sampleBasisPoints = integerValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS, 0, "DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS", 0, 10_000);
  return {
    enabled: enabled && sampleBasisPoints > 0,
    sampleBasisPoints,
    maxConcurrent: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CONCURRENT, 1, "DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CONCURRENT", 1, 4),
    maxCallsPerRun: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CALLS, 3, "DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CALLS", 1, 3),
    maxOutputTokensPerCall: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS, 256, "DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS", 64, 512),
    timeoutMsPerCall: integerValue(env.DIV3RSA_AGENT_KERNEL_V2_PROBE_TIMEOUT_MS, 4_000, "DIV3RSA_AGENT_KERNEL_V2_PROBE_TIMEOUT_MS", 500, 15_000)
  };
}
