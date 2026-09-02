import { describe, expect, it } from "vitest";
import { buildDirectModelMessages, conservativeTokenCount, directModelInputCharacterBudget, storedMessageText, stripThinking } from "./direct-model-protocol";

describe("direct model protocol", () => {
  it("reads persisted message text without accepting arbitrary objects", () => {
    expect(storedMessageText({ text: " hello " })).toBe("hello");
    expect(storedMessageText({ content: "world" })).toBe("world");
    expect(storedMessageText({ tool: "ignored" })).toBe("");
  });

  it("removes hidden thinking blocks including an unclosed tail", () => {
    expect(stripThinking("before<think>secret</think>after")).toBe("beforeafter");
    expect(stripThinking("answer\n<think>unfinished")).toBe("answer");
  });

  it("uses exact reported usage but never treats missing usage as zero quota", () => {
    expect(conservativeTokenCount(42, ["ignored fallback"])).toBe(42);
    expect(conservativeTokenCount(undefined, ["123456789"])).toBe(3);
    expect(conservativeTokenCount(0, ["abc"])).toBe(1);
    expect(conservativeTokenCount(undefined, [])).toBe(0);
  });

  it("reserves output and safety headroom from the runtime context", () => {
    expect(directModelInputCharacterBudget(32_768, 4_096)).toBe((32_768 - 4_096 - 1_024) * 3);
    expect(() => directModelInputCharacterBudget(5_000, 4_096)).toThrow("direct_model_context_configuration_too_small");
  });

  it("keeps newest complete turns and caps old context without orphan assistant messages", () => {
    const messages = buildDirectModelMessages([
      { role: "tool", content: { text: "tool output" } },
      { role: "user", content: { text: "old-old-old" } },
      { role: "assistant", content: { text: "recent" } },
      { role: "user", content: { text: "latest" } }
    ], 12);

    expect(messages[0]?.role).toBe("system");
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "latest" }
    ]);
  });

  it("rejects a current user message that cannot fit rather than silently overflowing the runtime", () => {
    expect(() => buildDirectModelMessages([
      { role: "user", content: { text: "x".repeat(101) } }
    ], 100)).toThrow("direct_model_current_message_exceeds_context");
  });

  it("drops older turns first while preserving the latest user message", () => {
    const messages = buildDirectModelMessages([
      { role: "user", content: { text: "old-user" } },
      { role: "assistant", content: { text: "old-assistant" } },
      { role: "user", content: { text: "latest-user" } }
    ], 20);

    expect(messages.slice(1)).toEqual([{ role: "user", content: "latest-user" }]);
  });
});
