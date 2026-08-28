import { describe, expect, it } from "vitest";
import { processPrompt } from "./prompt-processor";

describe("live time routing", () => {
  it("routes the exact Swedish Stockholm clock question to deterministic live time", () => {
    const contract = processPrompt("chat", "Vilken tid är det i Stockholm?");
    expect(contract.freshness).toBe("live");
    expect(contract.analysis.requiresCurrentInformation).toBe(true);
    expect(contract.analysis.requiresLiveData).toBe(true);
    expect(contract.analysis.liveDataKind).toBe("time");
    expect(contract.analysis.reasoningLevel).toBe("fast");
  });
});
