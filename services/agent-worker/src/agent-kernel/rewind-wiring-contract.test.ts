import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("checkpoint rewind production wiring", () => {
  const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

  it("is disabled by default behind an explicit environment gate", () => {
    expect(source).toContain('booleanEnvironment("DIV3RSA_CHECKPOINT_REWIND_ENABLED", false)');
  });

  it("uses the unwrapped discovered tool runtime for rollback execution", () => {
    expect(source).toContain("new AgentKernelRewindCoordinator(repositoryRuntime, discoveredToolRuntime");
    expect(source).toContain("new RewindAwareToolRuntime(discoveredToolRuntime, rewindCoordinator, checkpointRewindEnabled)");
  });

  it("wraps the authoritative queue so verification failure rewinds before retry", () => {
    expect(source).toContain("new RewindAwareAgentQueue(shadowQueue, rewindCoordinator, checkpointRewindEnabled)");
    expect(source).toContain("checkpointRewind=${checkpointRewindEnabled ? \"enabled\" : \"disabled\"}");
  });
});
