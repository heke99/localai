import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelMessage, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { routeExecutionObligation } from "./execution-obligation-router";

function tool(name: string, description: string): ModelToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  };
}

const tools = [
  tool("fixture_read", "Read the authoritative current fixture value"),
  tool("fixture_set", "Set or change the fixture value"),
  tool("fixture_verify", "Verify the fixture value against an expected value"),
  tool("fixture_fail_once", "Transient fixture operation that may be retried"),
  tool("fixture_repo_search", "Search repository fixture files"),
  tool("fixture_repo_open", "Open a repository fixture file"),
  tool("fixture_chain_step", "Execute one ordered fixture chain step")
];

function request(prompt: string, messages: ModelMessage[] = []): GenerateRequest {
  return {
    requestId: "req-obligation",
    alias: "general-prod",
    messages: [{ role: "user", content: prompt }, ...messages],
    tools
  };
}

function executed(name: string, input: Record<string, unknown>, output: unknown, id = `call-${name}`): ModelMessage[] {
  const call: ModelToolCall = { id, name, input };
  return [
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", name, toolCallId: id, content: JSON.stringify(output) }
  ];
}

describe("execution obligation router", () => {
  it("forces an explicitly named authoritative read before allowing a final answer", () => {
    const prompt = "Read the authoritative fixture by calling fixture_read; then answer with the exact token DATA-TOOL-ALPHA. Do not answer from memory.";
    expect(routeExecutionObligation(request(prompt))?.requiredToolName).toBe("fixture_read");
    expect(routeExecutionObligation(request(prompt, executed("fixture_read", {}, { value: "DATA-TOOL-ALPHA" })))).toBeNull();
  });

  it("preserves read -> write -> verify sequencing from the actual native tool trace", () => {
    const prompt = "Read the fixture state, change it to state-v2, then call fixture_verify and answer with STATE-VERIFIED-v2 only after successful verification.";
    expect(routeExecutionObligation(request(prompt))?.requiredToolName).toBe("fixture_read");

    const afterRead = executed("fixture_read", {}, { value: "initial" });
    expect(routeExecutionObligation(request(prompt, afterRead))?.requiredToolName).toBe("fixture_set");

    const afterWrite = [
      ...afterRead,
      ...executed("fixture_set", { value: "state-v2" }, { value: "state-v2", changed: true }, "call-set")
    ];
    expect(routeExecutionObligation(request(prompt, afterWrite))?.requiredToolName).toBe("fixture_verify");

    const afterVerify = [
      ...afterWrite,
      ...executed("fixture_verify", { expected: "state-v2" }, { ok: true, value: "state-v2" }, "call-verify")
    ];
    expect(routeExecutionObligation(request(prompt, afterVerify))).toBeNull();
  });

  it("retries the latest explicitly requested tool when authoritative output says retryable", () => {
    const prompt = "Call fixture_fail_once. It will fail transiently once, so retry it once and answer exactly RECOVERED when it succeeds.";
    expect(routeExecutionObligation(request(prompt))?.requiredToolName).toBe("fixture_fail_once");

    const firstAttempt = executed("fixture_fail_once", {}, { ok: false, retryable: true, error: "TRANSIENT" });
    expect(routeExecutionObligation(request(prompt, firstAttempt))?.requiredToolName).toBe("fixture_fail_once");

    const recovered = [
      ...firstAttempt,
      ...executed("fixture_fail_once", {}, { ok: true, retryable: false, token: "RECOVERED" }, "call-retry")
    ];
    expect(routeExecutionObligation(request(prompt, recovered))).toBeNull();
  });

  it("honors read-first idempotency and skips mutation when the current value already matches", () => {
    const prompt = "Set the current fixture to stable-v1 idempotently. Read first, change only if needed, verify the resulting value, and answer STABLE-OK.";
    expect(routeExecutionObligation(request(prompt))?.requiredToolName).toBe("fixture_read");

    const alreadyStable = executed("fixture_read", {}, { value: "stable-v1" });
    expect(routeExecutionObligation(request(prompt, alreadyStable))?.requiredToolName).toBe("fixture_verify");

    const needsChange = executed("fixture_read", {}, { value: "initial" });
    expect(routeExecutionObligation(request(prompt, needsChange))?.requiredToolName).toBe("fixture_set");
  });

  it("searches before opening the canonical repository file", () => {
    const prompt = "Search the repository fixture to find the canonical file that contains RELIABILITY-CANONICAL-42, open that file, then answer exactly RELIABILITY-CANONICAL-42. Do not guess the file path.";
    const first = routeExecutionObligation(request(prompt));
    expect(first?.requiredToolName).toBe("fixture_repo_search");
    expect(first?.instruction).toContain("RELIABILITY-CANONICAL-42");

    const searched = executed("fixture_repo_search", { query: "RELIABILITY-CANONICAL-42" }, { matches: [{ path: "docs/reliability/canonical.txt" }] });
    expect(routeExecutionObligation(request(prompt, searched))?.requiredToolName).toBe("fixture_repo_open");
  });

  it("requires every explicitly counted ordered chain step", () => {
    const prompt = "Complete exactly five ordered fixture chain steps. Begin with previousToken=START and step=1; for every next step use the exact nextToken returned by the previous tool result. After step 5 answer exactly CHAIN-FINAL-5.";
    let history: ModelMessage[] = [];
    for (let step = 1; step <= 5; step += 1) {
      expect(routeExecutionObligation(request(prompt, history))?.requiredToolName).toBe("fixture_chain_step");
      history = [
        ...history,
        ...executed(
          "fixture_chain_step",
          { step, previousToken: step === 1 ? "START" : `CHAIN-TOKEN-${step - 1}` },
          { ok: true, nextToken: step === 5 ? "CHAIN-FINAL-5" : `CHAIN-TOKEN-${step}` },
          `call-chain-${step}`
        )
      ];
    }
    expect(routeExecutionObligation(request(prompt, history))).toBeNull();
  });

  it("keeps a read-only request read-only", () => {
    const prompt = "Read the current fixture value and report it exactly. This is a read-only task; do not call any mutation tool.";
    expect(routeExecutionObligation(request(prompt))?.requiredToolName).toBe("fixture_read");
    expect(routeExecutionObligation(request(prompt, executed("fixture_read", {}, { value: "initial" })))).toBeNull();
  });

  it("does not force tools for explanatory prose", () => {
    expect(routeExecutionObligation(request("Explain how a read and verify workflow should work."))).toBeNull();
  });
});
