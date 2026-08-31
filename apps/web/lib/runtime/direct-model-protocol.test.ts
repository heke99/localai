import { describe, expect, it } from "vitest";
import { buildDirectModelMessages, conservativeTokenCount, storedMessageText, stripThinking } from "./direct-model-protocol";

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

  it("keeps only user and assistant history and caps old context", () => {
    const messages = buildDirectModelMessages([
      { role: "tool", content: { text: "tool output" } },
      { role: "user", content: { text: "old-old-old" } },
      { role: "assistant", content: { text: "recent" } },
      { role: "user", content: { text: "latest" } }
    ], 12);

    expect(messages[0]?.role).toBe("system");
    expect(messages.slice(1)).toEqual([
      { role: "assistant", content: "recent" },
      { role: "user", content: "latest" }
    ]);
  });
});
