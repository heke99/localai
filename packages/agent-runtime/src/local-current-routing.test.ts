import { describe, expect, it } from "vitest";
import { processPrompt } from "./prompt-processor";

describe("local current routing", () => {
  it("does not turn internal current fixture/state/value work into a web freshness dependency", () => {
    for (const prompt of [
      "Read the current fixture value and report it exactly.",
      "Set the current fixture to stable-v1 idempotently. Read first, change only if needed, verify the resulting value.",
      "Inspect the current state in this workspace before changing it."
    ]) {
      const contract = processPrompt("chat", prompt);
      expect(contract.freshness).toBe("stable");
      expect(contract.requires.web).toBe(false);
      expect(contract.analysis.requiresCurrentInformation).toBe(false);
    }
  });

  it("still treats genuinely external current facts as current", () => {
    const contract = processPrompt("chat", "What is the current VAT rate in Sweden?");
    expect(contract.freshness).toBe("current");
    expect(contract.requires.web).toBe(true);
    expect(contract.analysis.requiresCurrentInformation).toBe(true);
  });
});
