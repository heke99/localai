import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { SecurityAwareOpenAiCompatibleAdapter } from "./security-aware-openai-compatible-adapter";

const inspectTool: ModelToolDefinition = {
  name: "workspace_inspect",
  description: "Inspect the current workspace",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string" } }
  }
};

function completion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("generic tool no-progress repair", () => {
  it("repairs deferred Swedish action prose into an exposed tool call", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion("Jag börjar med att identifiera vad som krävs. Låt mig undersöka arbetsmiljön och tillgängliga verktyg."))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string | null }> };
        expect(body.messages.some((message) => typeof message.content === "string" && message.content.includes("Execution repair"))).toBe(true);
        expect(body.messages.some((message) => typeof message.content === "string" && message.content.includes("workspace_inspect"))).toBe(true);
        return completion("<tool_call><function=workspace_inspect><parameter=path>.</parameter></function></tool_call>");
      });

    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "generic-repair",
      alias: "code-prod",
      messages: [{ role: "user", content: "Undersök projektet och hitta felet." }],
      tools: [inspectTool]
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]).toMatchObject({ name: "workspace_inspect", input: { path: "." } });
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 0 });
  });

  it("buffers tool-equipped streaming so deferred prose is never emitted before repair", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion("Jag börjar nu. Låt mig undersöka arbetsmiljön och verktygen."))
      .mockResolvedValueOnce(completion("<tool_call><function=workspace_inspect><parameter=path>.</parameter></function></tool_call>"));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const deltas: string[] = [];

    const output = await adapter.generateStreamed({
      requestId: "generic-stream-repair",
      alias: "code-prod",
      messages: [{ role: "user", content: "Inspektera arbetsytan." }],
      tools: [inspectTool]
    }, (delta) => { deltas.push(delta); });

    expect(output.finishReason).toBe("tool_call");
    expect(deltas).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails deterministically if the bounded repair still only defers action", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion("Låt mig undersöka arbetsmiljön och verktygen först."))
      .mockResolvedValueOnce(completion("Jag ska nu kontrollera arbetsmiljön och tillgängliga verktyg."));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    await expect(adapter.generate({
      requestId: "generic-repair-fails-closed",
      alias: "code-prod",
      messages: [{ role: "user", content: "Inspektera arbetsytan." }],
      tools: [inspectTool]
    })).rejects.toThrow("model_no_progress_after_tool_repair");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
