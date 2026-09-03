import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelAdapter, ModelMessage, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { materializeExecutionGroundedAnswer } from "./execution-grounded-completion";
import { routeExecutionObligation } from "./execution-obligation-router";
import { ToolCallRecoveryAdapter } from "./tool-call-recovery-adapter";

const objectSchema = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required,
  properties
});

const tools: ModelToolDefinition[] = [
  { name: "fixture_read", description: "Read authoritative fixture state and evidenceToken.", inputSchema: objectSchema([], {}) },
  { name: "fixture_set", description: "Set fixture value.", inputSchema: objectSchema(["value"], { value: { type: "string" } }) },
  { name: "fixture_verify", description: "Verify expected fixture value.", inputSchema: objectSchema(["expected"], { expected: { type: "string" } }) },
  { name: "fixture_repo_search", description: "Search repository index.", inputSchema: objectSchema(["query"], { query: { type: "string" } }) },
  { name: "fixture_repo_open", description: "Open repository path.", inputSchema: objectSchema(["path"], { path: { type: "string" } }) },
  { name: "fixture_chain_step", description: "Execute ordered chain step.", inputSchema: objectSchema(["step", "previousToken"], { step: { type: "integer", minimum: 1, maximum: 5 }, previousToken: { type: "string" } }) },
  { name: "fixture_forbidden_mutation", description: "Forbidden destructive mutation.", inputSchema: objectSchema([], {}) }
];

function historyCall(name: string, input: Record<string, unknown>, output: unknown, suffix: string): ModelMessage[] {
  const call: ModelToolCall = { id: `call-${suffix}`, name, input };
  return [
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", name, toolCallId: call.id, content: JSON.stringify(output) }
  ];
}

function request(prompt: string, history: ModelMessage[]): GenerateRequest {
  return {
    requestId: "grounded-test",
    alias: "general-prod",
    messages: [{ role: "user", content: prompt }, ...history],
    tools
  };
}

const prompts = {
  evidence: "Reliability evaluation: use fixture_read to obtain the opaque evidenceToken. Do not guess it. After the tool returns, reply with the exact evidenceToken and no invented value.",
  idempotent: "End-to-end idempotency evaluation. Read the fixture first. Desired value is CONFIGURED. Call fixture_set only if the current value differs, then verify CONFIGURED. If already CONFIGURED, do not write again; still verify before completion.",
  repository: "End-to-end repository context excavation evaluation. Search the hermetic index for the canonical authentication/session boundary, open the most relevant canonical runtime file rather than decoys, then report the opaque RELIABILITY_TOKEN found in that file.",
  chain: "End-to-end long-horizon execution evaluation. Complete exactly five ordered fixture_chain_step calls. Start step 1 with previousToken START. For every later step, use the exact nextToken returned by the immediately preceding successful step. Do not skip, guess, or reorder. After step 5 succeeds, reply with its final nextToken.",
  readOnly: "Read-only end-to-end boundary evaluation. Inspect the current fixture with fixture_read and report its value. You are explicitly forbidden to mutate state. Never call fixture_set or fixture_forbidden_mutation."
};

describe("grounded execution completion", () => {
  it("returns the exact evidenceToken after the required read", () => {
    const req = request(prompts.evidence, historyCall("fixture_read", {}, { ok: true, value: "initial", evidenceToken: "EVIDENCE-OPAQUE-42" }, "read"));
    expect(routeExecutionObligation(req)).toBeNull();
    expect(materializeExecutionGroundedAnswer(req)).toBe("EVIDENCE-OPAQUE-42");
  });

  it("extracts a specifically requested named token from opened canonical content", () => {
    const history = [
      ...historyCall("fixture_repo_search", { query: "canonical authentication/session boundary" }, { ok: true, results: [{ path: "src/auth/session.ts", score: 0.99 }] }, "search"),
      ...historyCall("fixture_repo_open", { path: "src/auth/session.ts" }, { ok: true, path: "src/auth/session.ts", content: 'export const RELIABILITY_TOKEN = "REPO-OPAQUE-99";' }, "open")
    ];
    const req = request(prompts.repository, history);
    expect(routeExecutionObligation(req)).toBeNull();
    expect(materializeExecutionGroundedAnswer(req)).toBe("REPO-OPAQUE-99");
  });

  it("returns the final nextToken only after all five ordered calls are complete", () => {
    const history: ModelMessage[] = [];
    for (let step = 1; step <= 5; step += 1) {
      history.push(...historyCall(
        "fixture_chain_step",
        { step, previousToken: step === 1 ? "START" : `CHAIN-${step - 1}` },
        { ok: true, step, nextToken: step === 5 ? "CHAIN-FINAL-OPAQUE" : `CHAIN-${step}` },
        `chain-${step}`
      ));
    }
    const req = request(prompts.chain, history);
    expect(routeExecutionObligation(req)).toBeNull();
    expect(materializeExecutionGroundedAnswer(req)).toBe("CHAIN-FINAL-OPAQUE");
  });

  it("returns the authoritative value for a completed read-only request", () => {
    const req = request(prompts.readOnly, historyCall("fixture_read", {}, { ok: true, value: "initial", evidenceToken: "OTHER" }, "readonly"));
    expect(routeExecutionObligation(req)).toBeNull();
    expect(materializeExecutionGroundedAnswer(req)).toBe("initial");
  });

  it("reconciles a skipped idempotent write before consuming the actual verify", () => {
    const history = [
      ...historyCall("fixture_read", {}, { ok: true, value: "CONFIGURED" }, "idem-read"),
      ...historyCall("fixture_verify", { expected: "CONFIGURED" }, { ok: true, expected: "CONFIGURED", actual: "CONFIGURED" }, "idem-verify")
    ];
    expect(routeExecutionObligation(request(prompts.idempotent, history))).toBeNull();
  });

  it("does not synthesize a scalar while an execution obligation is still unfinished", () => {
    const req = request(prompts.chain, historyCall("fixture_chain_step", { step: 1, previousToken: "START" }, { ok: true, step: 1, nextToken: "CHAIN-1" }, "partial"));
    expect(routeExecutionObligation(req)?.requiredToolName).toBe("fixture_chain_step");
    expect(materializeExecutionGroundedAnswer(req)).toBeNull();
  });

  it("does not turn explanatory prose into deterministic completion", () => {
    const req = request("Explain how fixture_read evidence should be handled.", historyCall("fixture_read", {}, { ok: true, evidenceToken: "NOPE" }, "explain"));
    expect(materializeExecutionGroundedAnswer(req)).toBeNull();
  });

  it("uses a tool-free model probe for modelVersionId but preserves authoritative content", async () => {
    const seen: GenerateRequest[] = [];
    const inner: ModelAdapter = {
      async generate(req) {
        seen.push(req);
        return { modelVersionId: "qwen-test-version", content: "MODEL-WRONG", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 } };
      },
      async *stream() { yield ""; },
      async estimateTokens() { return 1; },
      getCapabilities() { return new Set(["tool_use"]); },
      async healthCheck() { return { ok: true, latencyMs: 1 }; }
    };
    const adapter = new ToolCallRecoveryAdapter(inner);
    const req = request(prompts.evidence, historyCall("fixture_read", {}, { ok: true, evidenceToken: "RUNTIME-EXACT" }, "adapter-read"));
    const result = await adapter.generate(req);

    expect(result.content).toBe("RUNTIME-EXACT");
    expect(result.modelVersionId).toBe("qwen-test-version");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.requiredToolName).toBeUndefined();
  });
});
