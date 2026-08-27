import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@div3rsa/model-sdk";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { deterministicTimeResult, groundedSynthesisMessages } from "./final-grounding";

describe("live-time deterministic completion", () => {
  it("answers the exact Stockholm clock question as clock time without model synthesis", () => {
    const result = deterministicTimeResult(
      { requiresCurrentInformation: true, liveDataKind: "time" } as TaskAnalysis,
      "Vilken tid är det i Stockholm?",
      [{
        sequence: 1,
        name: "current_time",
        input: { timezone: "Europe/Stockholm" },
        output: {
          timezone: "Europe/Stockholm",
          localDate: "2026-08-28",
          localTime: "00:09:00",
          localIso: "2026-08-28T00:09:00+02:00"
        }
      }]
    );

    expect(result?.content).toBe("The current time in Europe/Stockholm is 00:09:00.");
    expect(result?.modelVersionId).toBe("deterministic-current-time-v1");
  });
});

describe("current evidence repair synthesis", () => {
  it("rebuilds the repair prompt from clean evidence instead of replaying tool protocol", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "What is the standard VAT rate in Sweden?" },
      { role: "assistant", content: "", toolCalls: [{ id: "search", name: "web_search", input: { query: "Sweden VAT official" } }] },
      { role: "tool", name: "web_search", toolCallId: "search", content: JSON.stringify({ results: [{ url: "https://www.skatteverket.se/moms", snippet: "25 procent" }] }) },
      { role: "assistant", content: "<tool_call>bad protocol replay</tool_call>" },
      { role: "tool", name: "web_fetch", toolCallId: "fetch", content: JSON.stringify({ url: "https://www.skatteverket.se/moms", text: "Den generella momssatsen är 25 procent." }) }
    ];

    const repaired = groundedSynthesisMessages({
      messages,
      draft: "",
      originalPrompt: "What is the standard VAT rate in Sweden?",
      attempt: 1,
      reviewerFeedback: "Use the opened Swedish Tax Agency evidence."
    });

    expect(repaired).toHaveLength(2);
    expect(repaired.every((message) => message.role !== "tool" && !message.toolCalls?.length)).toBe(true);
    const payload = repaired.map((message) => String(message.content ?? "")).join("\n");
    expect(payload).toContain("clean-room");
    expect(payload).toContain("skatteverket.se");
    expect(payload).toContain("25 procent");
    expect(payload).not.toContain("bad protocol replay");
  });
});
