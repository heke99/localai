import { describe, expect, it } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { looksLikeRegisteredToolInvocation } from "./text-tool-call";

function tool(name: string): ModelToolDefinition {
  return { name, description: `${name} test tool`, inputSchema: { type: "object" } };
}

describe("textual registered tool-call detection", () => {
  it("detects web_search emitted as an ordinary function-style text call", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'I will check this live now. web_search({"query":"latest status"})',
        [tool("web_search")]
      )
    ).toBe(true);
  });

  it("detects any other registered tool without hard-coding its name", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'Next I need the repository state. repo_lookup ( {"path":"src/index.ts"} )',
        [tool("repo_lookup")]
      )
    ).toBe(true);
  });

  it("does not treat a plain prose mention of a registered tool as an invocation", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        "The web_search tool is available if live lookup becomes necessary.",
        [tool("web_search")]
      )
    ).toBe(false);
  });

  it("does not match text calls for tools that are not registered in this run", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'web_search({"query":"latest status"})',
        [tool("http_request")]
      )
    ).toBe(false);
  });

  it("escapes regular-expression characters in registered tool names", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'vendor.search-v2({"query":"status"})',
        [tool("vendor.search-v2")]
      )
    ).toBe(true);
  });
});
