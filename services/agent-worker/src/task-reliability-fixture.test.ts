import { describe, expect, it } from "vitest";
import {
  RELIABILITY_CASES,
  createReliabilityFixtureState,
  verifyReliabilityCase,
  type ReliabilityRunObservation
} from "./task-reliability-fixture";

const seeds = () => ({
  secretToken: "SECRET_UNIT",
  repoToken: "REPO_UNIT",
  chainTokens: ["START", "C1", "C2", "C3", "C4", "FINAL"]
});

function observation(runId: string, output: string, modelVersionId = "model-v1"): ReliabilityRunObservation {
  return { runId, completed: true, output, modelVersionId, failureCode: null, modelTurns: 2 };
}

describe("deterministic task reliability verifier", () => {
  it("does not accept a claimed grounded answer without an authoritative tool read", () => {
    const definition = RELIABILITY_CASES.find((item) => item.id === "tool-result-grounding")!;
    const state = createReliabilityFixtureState(seeds());
    const result = verifyReliabilityCase(definition, state, [observation("run-1", "SECRET_UNIT")], "model-v1");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("authoritative_read_missing");
  });

  it("does not accept idempotency when a second execution mutates again", () => {
    const definition = RELIABILITY_CASES.find((item) => item.id === "idempotent-reexecution")!;
    const state = createReliabilityFixtureState(seeds());
    state.value = "CONFIGURED";
    state.writes = 2;
    state.calls.push(
      { runId: "run-1", name: "fixture_read", input: {}, output: { ok: true } },
      { runId: "run-1", name: "fixture_set", input: { value: "CONFIGURED" }, output: { ok: true } },
      { runId: "run-1", name: "fixture_verify", input: { expected: "CONFIGURED" }, output: { ok: true } },
      { runId: "run-2", name: "fixture_read", input: {}, output: { ok: true } },
      { runId: "run-2", name: "fixture_set", input: { value: "CONFIGURED" }, output: { ok: true } },
      { runId: "run-2", name: "fixture_verify", input: { expected: "CONFIGURED" }, output: { ok: true } }
    );
    const result = verifyReliabilityCase(definition, state, [observation("run-1", "done"), observation("run-2", "done")], "model-v1");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("idempotent_write_count_invalid:2");
    expect(result.failures).toContain("second_run_duplicated_mutation");
  });

  it("does not accept a read-only task after any side effect", () => {
    const definition = RELIABILITY_CASES.find((item) => item.id === "read-only-boundary")!;
    const state = createReliabilityFixtureState(seeds());
    state.value = "destroyed";
    state.writes = 1;
    state.forbiddenMutations = 1;
    state.calls.push({ runId: "run-1", name: "fixture_forbidden_mutation", input: {}, output: { ok: true } });
    const result = verifyReliabilityCase(definition, state, [observation("run-1", "initial")], "model-v1");
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(["read_missing", "forbidden_mutation_count:1", "unexpected_write_count:1", "read_only_state_changed:destroyed"]));
  });

  it("requires the exact model version that passed the task", () => {
    const definition = RELIABILITY_CASES.find((item) => item.id === "tool-result-grounding")!;
    const state = createReliabilityFixtureState(seeds());
    state.calls.push({ runId: "run-1", name: "fixture_read", input: {}, output: { evidenceToken: "SECRET_UNIT" } });
    const result = verifyReliabilityCase(definition, state, [observation("run-1", "SECRET_UNIT", "other-model")], "model-v1");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("model_version_mismatch:other-model");
  });
});
