import { describe, expect, it } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { detectRegisteredToolIntent, looksLikeRegisteredToolInvocation } from "./text-tool-call";

function tool(name: string): ModelToolDefinition {
  return { name, description: `${name} test tool`, inputSchema: { type: "object" } };
}

const executionTools = [tool("web_search"), tool("http_request"), tool("security_scan")];

describe("textual registered tool-call detection", () => {
  it("detects web_search emitted as an ordinary function-style text call", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'I will check this live now. web_search({"query":"latest status"})',
        [tool("web_search")]
      )
    ).toBe(true);
    expect(detectRegisteredToolIntent('web_search({"query":"latest status"})', [tool("web_search")]))
      .toEqual({ toolName: "web_search", reason: "registered_invocation" });
  });

  it("detects any other registered tool without hard-coding its name", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        'Next I need the repository state. repo_lookup ( {"path":"src/index.ts"} )',
        [tool("repo_lookup")]
      )
    ).toBe(true);
  });

  it("detects explicit English and Swedish intent to use a registered tool", () => {
    expect(detectRegisteredToolIntent("I need to use web_search before I can answer.", executionTools))
      .toEqual({ toolName: "web_search", reason: "explicit_registered_intent" });
    expect(detectRegisteredToolIntent("Jag behöver använda http_request för att verifiera detta live.", executionTools))
      .toEqual({ toolName: "http_request", reason: "explicit_registered_intent" });
  });

  it("detects Qwen-style text tool envelopes without treating their arguments as executable", () => {
    expect(detectRegisteredToolIntent('<tool_call>\n{"name":"web_search","arguments":{"query":"latest node"}}\n</tool_call>', executionTools))
      .toEqual({ toolName: "web_search", reason: "text_tool_envelope" });
  });

  it("detects command-like curl output as execution intent without inventing a tool mapping", () => {
    expect(detectRegisteredToolIntent("Jag måste verifiera live.\n```bash\ncurl -sS https://example.test/health\n```", executionTools))
      .toEqual({ toolName: null, reason: "unstructured_execution" });
  });

  it("does not treat a plain prose mention of a registered tool as an invocation", () => {
    expect(
      looksLikeRegisteredToolInvocation(
        "The web_search tool is available if live lookup becomes necessary.",
        [tool("web_search")]
      )
    ).toBe(false);
    expect(detectRegisteredToolIntent("I can use web_search if you want me to research that later.", executionTools)).toBeNull();
    expect(detectRegisteredToolIntent("The web_search tool is available in this runtime.", executionTools)).toBeNull();
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