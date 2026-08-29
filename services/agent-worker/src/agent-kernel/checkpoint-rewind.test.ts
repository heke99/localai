import { describe, expect, it, vi } from "vitest";
import { AGENT_KERNEL_PROTOCOL_VERSION, type KernelPlan } from "./contracts";
import { KernelCheckpointRewindController } from "./checkpoint-rewind";

const plan: KernelPlan = {
  protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
  task: { runId: "run-1", conversationId: null, objective: "test", mode: "code", requestedAt: new Date(0).toISOString(), capabilities: ["repository", "verification"] },
  agents: [
    { agentId: "executor", role: "executor", capabilities: ["repository"], modelAlias: "general-prod" },
    { agentId: "verifier", role: "verifier", capabilities: ["verification"], modelAlias: "verifier-prod" }
  ],
  steps: [],
  finalVerifierAgentId: "verifier"
};

const passed = { passed: true, verifierAgentId: "verifier", findings: [], verifiedAt: new Date(0).toISOString() } as const;
const failed = { passed: false, verifierAgentId: "verifier", findings: [], verifiedAt: new Date(0).toISOString() } as const;

describe("KernelCheckpointRewindController", () => {
  it("restores only a verified checkpoint", async () => {
    const restore = vi.fn(async () => undefined);
    const controller = new KernelCheckpointRewindController({
      capture: async ({ label }) => [{ kind: "repository" as const, locator: "owner/repo", revision: label }],
      restore
    });
    const good = await controller.checkpoint({ runId: "run-1", label: "green", plan, results: [], verification: passed });
    await controller.checkpoint({ runId: "run-1", label: "red", plan, results: [], verification: failed });
    const restored = await controller.rewind("run-1");
    expect(restored.checkpointId).toBe(good.checkpointId);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", snapshots: good.snapshots }));
  });

  it("fails closed when no verified checkpoint exists", async () => {
    const controller = new KernelCheckpointRewindController({ capture: async () => [{ kind: "repository", locator: "x", revision: "bad" }], restore: async () => undefined });
    await controller.checkpoint({ runId: "run-1", label: "bad", plan, results: [], verification: failed });
    await expect(controller.rewind("run-1")).rejects.toThrow("kernel_verified_checkpoint_not_found");
  });

  it("bounds repeated rewind loops", async () => {
    const controller = new KernelCheckpointRewindController({ capture: async () => [{ kind: "repository", locator: "x", revision: "green" }], restore: async () => undefined }, 1);
    await controller.checkpoint({ runId: "run-1", label: "green", plan, results: [], verification: passed });
    await controller.rewind("run-1");
    await expect(controller.rewind("run-1")).rejects.toThrow("kernel_rewind_budget_exhausted");
  });
});
