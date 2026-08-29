import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("services/agent-worker/src/main.ts", "utf8");
const canary = readFileSync("services/agent-worker/src/agent-kernel/active-canary-adapter.ts", "utf8");
const broker = readFileSync("services/agent-worker/src/dynamic-tool-broker.ts", "utf8");

describe("Agent Kernel V2 active wiring contract", () => {
  it("wraps either direct or registry inference with the bounded active canary", () => {
    expect(main).toContain("const inferenceAdapter: ModelAdapter");
    expect(main).toContain("new AgentKernelActiveCanaryAdapter(inferenceAdapter, agentKernelConfig)");
    expect(canary).toContain("processPrompt(primary.mode, primary.prompt, {})");
    expect(canary).toContain("disableThinking: true");
  });

  it("keeps active execution fail closed behind explicit kernel config and basis-point sampling", () => {
    expect(canary).toContain("AgentKernelActiveCanaryRuntime");
    expect(main).toContain("activeCanaryBasisPoints");
    expect(main).not.toContain("DIV3RSA_AGENT_KERNEL_V2_ACTIVE_CANARY_BPS=10000");
  });

  it("wires dynamic tool discovery only through an explicit opt-in flag", () => {
    expect(main).toContain('booleanEnvironment("DIV3RSA_DYNAMIC_TOOL_DISCOVERY_ENABLED", false)');
    expect(main).toContain("new DynamicToolBroker(baseToolRuntime");
    expect(broker).toContain("dynamic_tool_write_requires_direct_schema");
  });

  it("keeps shadow verifier calls on the unaugmented inference adapter", () => {
    expect(main).toContain("inferenceAdapter.generate({ ...input, disableThinking: true })");
  });
});
