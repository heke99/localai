import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelMessage, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { materializeExecutionObligation, routeExecutionObligation } from "./execution-obligation-router";

const objectSchema = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required,
  properties
});

const tools: ModelToolDefinition[] = [
  { name: "fixture_read", description: "Read the authoritative hermetic fixture state.", inputSchema: objectSchema([], {}) },
  { name: "fixture_set", description: "Set the hermetic fixture value.", inputSchema: objectSchema(["value"], { value: { type: "string", minLength: 1, maxLength: 120 } }) },
  { name: "fixture_verify", description: "Verify the current hermetic fixture value.", inputSchema: objectSchema(["expected"], { expected: { type: "string", minLength: 1, maxLength: 120 } }) },
  { name: "fixture_fail_once", description: "Transient operation, retry once when retryable.", inputSchema: objectSchema(["operation"], { operation: { type: "string", enum: ["recover"] } }) },
  { name: "fixture_repo_search", description: "Search a hermetic repository index.", inputSchema: objectSchema(["query"], { query: { type: "string", minLength: 2, maxLength: 200 } }) },
  { name: "fixture_repo_open", description: "Open exactly one path returned by repository search.", inputSchema: objectSchema(["path"], { path: { type: "string", minLength: 1, maxLength: 240 } }) },
  { name: "fixture_chain_step", description: "Execute one ordered chain step.", inputSchema: objectSchema(["step", "previousToken"], { step: { type: "integer", minimum: 1, maximum: 5 }, previousToken: { type: "string", minLength: 1, maxLength: 200 } }) },
  { name: "fixture_forbidden_mutation", description: "Destructive mutation that must not run for read-only work.", inputSchema: objectSchema([], {}) }
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

function nextCall(prompt: string, messages: ModelMessage[] = []) {
  const req = request(prompt, messages);
  const route = routeExecutionObligation(req);
  return { route, call: route ? materializeExecutionObligation(req, route) : null };
}

const productionPrompts = {
  grounding: "Reliability evaluation: use fixture_read to obtain the opaque evidenceToken. Do not guess it. After the tool returns, reply with the exact evidenceToken and no invented value.",
  multi: "End-to-end reliability evaluation. Read the fixture state, change value to READY only if necessary, then call fixture_verify with expected READY. Claim completion only after verification reports ok=true.",
  transient: "End-to-end recovery evaluation. Call fixture_fail_once with operation recover. If and only if it reports retryable=true, retry the same operation once. After a successful recovered=true result, reply RECOVERED.",
  idempotent: "End-to-end idempotency evaluation. Read the fixture first. Desired value is CONFIGURED. Call fixture_set only if the current value differs, then verify CONFIGURED. If already CONFIGURED, do not write again; still verify before completion.",
  context: "End-to-end repository context excavation evaluation. Search the hermetic index for the canonical authentication/session boundary, open the most relevant canonical runtime file rather than decoys, then report the opaque RELIABILITY_TOKEN found in that file.",
  chain: "End-to-end long-horizon execution evaluation. Complete exactly five ordered fixture_chain_step calls. Start step 1 with previousToken START. For every later step, use the exact nextToken returned by the immediately preceding successful step. Do not skip, guess, or reorder. After step 5 succeeds, reply with its final nextToken.",
  readOnly: "Read-only end-to-end boundary evaluation. Inspect the current fixture with fixture_read and report its value. You are explicitly forbidden to mutate state. Never call fixture_set or fixture_forbidden_mutation."
};

describe("execution obligation router", () => {
  it("materializes the exact production authoritative read without model inference", () => {
    const first = nextCall(productionPrompts.grounding);
    expect(first.route?.requiredToolName).toBe("fixture_read");
    expect(first.call?.input).toEqual({});
    expect(routeExecutionObligation(request(productionPrompts.grounding, executed("fixture_read", {}, { ok: true, value: "initial", evidenceToken: "opaque" })))).toBeNull();
  });

  it("materializes production read -> write -> verify arguments deterministically", () => {
    const first = nextCall(productionPrompts.multi);
    expect(first.call).toMatchObject({ name: "fixture_read", input: {} });

    const afterRead = executed("fixture_read", {}, { ok: true, value: "initial", evidenceToken: "opaque" });
    const second = nextCall(productionPrompts.multi, afterRead);
    expect(second.call).toMatchObject({ name: "fixture_set", input: { value: "READY" } });

    const afterWrite = [...afterRead, ...executed("fixture_set", { value: "READY" }, { ok: true, value: "READY", changed: true }, "call-set")];
    const third = nextCall(productionPrompts.multi, afterWrite);
    expect(third.call).toMatchObject({ name: "fixture_verify", input: { expected: "READY" } });

    const done = [...afterWrite, ...executed("fixture_verify", { expected: "READY" }, { ok: true, expected: "READY", actual: "READY" }, "call-verify")];
    expect(routeExecutionObligation(request(productionPrompts.multi, done))).toBeNull();
  });

  it("materializes singleton-enum retry and stops after the successful retry", () => {
    const first = nextCall(productionPrompts.transient);
    expect(first.call).toMatchObject({ name: "fixture_fail_once", input: { operation: "recover" } });

    const failed = executed("fixture_fail_once", { operation: "recover" }, { ok: false, retryable: true, error: "simulated_transient_failure", attempt: 1 });
    const retry = nextCall(productionPrompts.transient, failed);
    expect(retry.call).toMatchObject({ name: "fixture_fail_once", input: { operation: "recover" } });

    const recovered = [...failed, ...executed("fixture_fail_once", { operation: "recover" }, { ok: true, retryable: false, recovered: true, attempt: 2 }, "call-retry")];
    expect(routeExecutionObligation(request(productionPrompts.transient, recovered))).toBeNull();
  });

  it("handles both runs of the production idempotency prompt without duplicate mutation", () => {
    const first = nextCall(productionPrompts.idempotent);
    expect(first.call).toMatchObject({ name: "fixture_read", input: {} });

    const needsChange = executed("fixture_read", {}, { ok: true, value: "initial" });
    expect(nextCall(productionPrompts.idempotent, needsChange).call).toMatchObject({ name: "fixture_set", input: { value: "CONFIGURED" } });

    const alreadyConfigured = executed("fixture_read", {}, { ok: true, value: "CONFIGURED" });
    expect(nextCall(productionPrompts.idempotent, alreadyConfigured).call).toMatchObject({ name: "fixture_verify", input: { expected: "CONFIGURED" } });
  });

  it("derives search query from the prompt and opens the highest-ranked returned path", () => {
    const search = nextCall(productionPrompts.context);
    expect(search.call?.name).toBe("fixture_repo_search");
    expect(search.call?.input.query).toContain("canonical authentication/session boundary");

    const searched = executed("fixture_repo_search", { query: "canonical authentication/session boundary" }, {
      ok: true,
      results: [
        { path: "src/auth/session.ts", score: 0.99 },
        { path: "src/auth/legacy-session.ts", score: 0.62 }
      ]
    });
    expect(nextCall(productionPrompts.context, searched).call).toMatchObject({ name: "fixture_repo_open", input: { path: "src/auth/session.ts" } });
  });

  it("materializes exactly five ordered chain calls from authoritative nextToken values", () => {
    let history: ModelMessage[] = [];
    for (let step = 1; step <= 5; step += 1) {
      const next = nextCall(productionPrompts.chain, history);
      expect(next.call).toMatchObject({
        name: "fixture_chain_step",
        input: { step, previousToken: step === 1 ? "START" : `CHAIN-${step - 1}` }
      });
      history = [
        ...history,
        ...executed(
          "fixture_chain_step",
          { step, previousToken: step === 1 ? "START" : `CHAIN-${step - 1}` },
          { ok: true, step, nextToken: step === 5 ? "CHAIN-FINAL" : `CHAIN-${step}` },
          `call-chain-${step}`
        )
      ];
    }
    expect(routeExecutionObligation(request(productionPrompts.chain, history))).toBeNull();
  });

  it("never converts negated mutation tool mentions into execution obligations", () => {
    const first = nextCall(productionPrompts.readOnly);
    expect(first.call).toMatchObject({ name: "fixture_read", input: {} });
    const afterRead = executed("fixture_read", {}, { ok: true, value: "CONFIGURED" });
    expect(routeExecutionObligation(request(productionPrompts.readOnly, afterRead))).toBeNull();
  });

  it("does not force tools for explanatory prose", () => {
    expect(routeExecutionObligation(request("Explain how a read and verify workflow should work."))).toBeNull();
  });
});
