import { describe, expect, it } from "vitest";
import { shadowProbeConfigFromEnvironment } from "./shadow-probe-config";

describe("shadow probe configuration", () => {
  it("is disabled with zero sampling by default", () => {
    expect(shadowProbeConfigFromEnvironment({})).toEqual({
      enabled: false,
      sampleBasisPoints: 0,
      maxConcurrent: 1,
      maxCallsPerRun: 3,
      maxOutputTokensPerCall: 256,
      timeoutMsPerCall: 4_000
    });
  });

  it("requires both explicit enablement and a positive sample rate", () => {
    expect(shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED: "1" }).enabled).toBe(false);
    expect(shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS: "100" }).enabled).toBe(false);
    expect(shadowProbeConfigFromEnvironment({
      DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED: "true",
      DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS: "100"
    }).enabled).toBe(true);
  });

  it("rejects unsafe budgets", () => {
    expect(() => shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS: "10001" })).toThrow(/PROBE_SAMPLE_BPS/);
    expect(() => shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CONCURRENT: "5" })).toThrow(/PROBE_MAX_CONCURRENT/);
    expect(() => shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_CALLS: "4" })).toThrow(/PROBE_MAX_CALLS/);
    expect(() => shadowProbeConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS: "1024" })).toThrow(/PROBE_MAX_OUTPUT_TOKENS/);
  });
});
