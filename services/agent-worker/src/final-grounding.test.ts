import { describe, expect, it } from "vitest";
import { groundedSynthesisMessages } from "./final-grounding";

describe("groundedSynthesisMessages", () => {
  it("tightens synthesis for latest/current requests", () => {
    const messages = groundedSynthesisMessages({
      messages: [],
      draft: "",
      originalPrompt: "Find the current latest Node.js release from official information.",
      attempt: 0
    });
    const instruction = String(messages.at(-1)?.content ?? "");
    expect(instruction).toContain("latest/current request");
    expect(instruction).toContain("Do not substitute LTS for Current");
    expect(instruction).toContain("version-specific release page");
  });

  it("does not add release-track instructions to stable questions", () => {
    const messages = groundedSynthesisMessages({
      messages: [],
      draft: "",
      originalPrompt: "Explain HTTP 401 and 403.",
      attempt: 0
    });
    expect(String(messages.at(-1)?.content ?? "")).not.toContain("Do not substitute LTS for Current");
  });
});
