import { describe, expect, it } from "vitest";
import { buildDirectModelMessages, storedMessageText, stripThinking } from "./direct-model-protocol";

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
