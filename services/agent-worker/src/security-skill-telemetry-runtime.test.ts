import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { SecuritySkillTelemetryRuntime, securitySkillTelemetry, type SecuritySkillTelemetryEvent } from "./security-skill-telemetry-runtime";
import { planPentestCapabilities } from "./pentest-capability-planner";

const securityTool: ModelToolDefinition = {
  name: "security_scan",
  description: "bounded security",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "target"],
    properties: {
      tool: { type: "string", enum: ["dns_lookup", "http_probe", "tls_probe", "content_discovery"] },
      target: { type: "string" },
      options: { type: "object", additionalProperties: false }
    }
  }
};

function run(prompt = "Verify BOLA / IDOR on this authorized API"): ClaimedRun {
  return {
    jobId: "job",
    runId: "run",
    mode: "lab",
    modelAlias: "general-prod",
    prompt,
    requestId: "req",
    traceId: "trace",
    resourceContext: []
  } as ClaimedRun;
}

function inner(output: unknown = {
  schemaVersion: 1,
  ok: true,
  status: "completed",
  durationMs: 15,
  exitCode: 0,
  evidence: { schemaVersion: 1, kind: "security_tool_observation" }
}): WorkerToolRuntime {
  return {
    list: vi.fn(async () => [securityTool]),
    execute: vi.fn(async () => output)
  };
}

describe("security skill-use telemetry", () => {
  it("records selected -> execution-aligned -> useful using runtime correlation, not hidden reasoning", async () => {
    const events: SecuritySkillTelemetryEvent[] = [];
    const runtime = new SecuritySkillTelemetryRuntime(
      inner(),
      async () => ["authorized-pentest", "external-security:api-authorization-bola"],
      async (_run, event) => { events.push(event); }
    );

    await runtime.list(run());
    await runtime.execute(run(), {
      id: "call-1",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://example.test", options: {} }
    });

    expect(events).toContainEqual(expect.objectContaining({
      stage: "selected",
      skill: "external-security:api-authorization-bola",
      selected: true,
      materiallyUsed: false,
      useful: null,
      capabilityGap: true,
      attributionBasis: "runtime_execution_correlation_not_chain_of_thought"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      stage: "execution_aligned",
      skill: "external-security:api-authorization-bola",
      operation: "http_probe",
      materiallyUsed: true,
      useful: true,
      evidenceStatus: "completed"
    }));
  });

  it("does not attribute an unrelated operation to a specialist skill", () => {
    const plan = planPentestCapabilities({
      mode: "lab",
      prompt: "Verify OAuth session security",
      selectedSkills: ["external-security:oauth-authorization"],
      toolDefinitions: [securityTool]
    })!;
    const events = securitySkillTelemetry.executionEvents(plan, "content_discovery", {
      ok: true,
      status: "completed",
      durationMs: 1,
      evidence: { kind: "security_tool_observation" }
    });
    expect(events).toEqual([]);
  });

  it("marks executor errors as materially attempted but not useful evidence", async () => {
    const events: SecuritySkillTelemetryEvent[] = [];
    const runtime = new SecuritySkillTelemetryRuntime(
      inner({
        schemaVersion: 1,
        ok: false,
        status: "executor_error",
        errorCode: "security_executor_timeout",
        evidence: { schemaVersion: 1, kind: "security_tool_observation", status: "executor_error" }
      }),
      async () => ["authorized-pentest", "external-security:web-recon"],
      async (_run, event) => { events.push(event); }
    );

    await runtime.execute(run("Map the authorized web attack surface"), {
      id: "call-timeout",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://example.test", options: {} }
    });

    expect(events).toContainEqual(expect.objectContaining({
      stage: "execution_aligned",
      skill: "external-security:web-recon",
      materiallyUsed: true,
      useful: false,
      evidenceStatus: "executor_error"
    }));
  });

  it("preserves fail-closed tool errors and records them as blocked instead of swallowing them", async () => {
    const events: SecuritySkillTelemetryEvent[] = [];
    const failing: WorkerToolRuntime = {
      list: async () => [securityTool],
      execute: async () => { throw new Error("security_target_out_of_scope"); }
    };
    const runtime = new SecuritySkillTelemetryRuntime(
      failing,
      async () => ["authorized-pentest", "external-security:web-recon"],
      async (_run, event) => { events.push(event); }
    );

    await expect(runtime.execute(run("Map the authorized web attack surface"), {
      id: "blocked",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://outside.test", options: {} }
    })).rejects.toThrow("security_target_out_of_scope");

    expect(events).toContainEqual(expect.objectContaining({
      stage: "execution_blocked",
      materiallyUsed: false,
      useful: false,
      errorCode: "security_target_out_of_scope"
    }));
  });

  it("deduplicates repeated list telemetry for the same run and plan", async () => {
    const sink = vi.fn(async () => {});
    const runtime = new SecuritySkillTelemetryRuntime(
      inner(),
      async () => ["authorized-pentest", "external-security:web-recon"],
      sink
    );
    await runtime.list(run("Map the authorized web attack surface"));
    const callsAfterFirst = sink.mock.calls.length;
    await runtime.list(run("Map the authorized web attack surface"));
    expect(sink.mock.calls.length).toBe(callsAfterFirst);
  });

  it("never emits security skill telemetry outside Lab mode", async () => {
    const sink = vi.fn(async () => {});
    const base = inner();
    const runtime = new SecuritySkillTelemetryRuntime(base, async () => ["authorized-pentest"], sink);
    const chatRun = { ...run(), mode: "chat" } as ClaimedRun;
    await runtime.list(chatRun);
    expect(sink).not.toHaveBeenCalled();
  });
});
