import { describe, expect, it, vi } from "vitest";
import { CredentialBroker, ToolGateway, decidePolicy, decideScale, evaluatePromotion, prepareKnowledge, validateSandboxRequest, type PolicyRule } from "./index";

const rules: PolicyRule[] = [{ id: "repo-write", effect: "allow", action: "repository.write", resourcePattern: "github:heke99/*", modes: ["code"], requiresAal2: true }];

describe("platform security boundaries", () => {
  it("requires both permission, allow policy and MFA", () => {
    expect(decidePolicy({ action: "repository.write", resource: "github:heke99/localai", mode: "code", assuranceLevel: "aal1", permissions: new Set(["repository.write"]) }, rules).reason).toBe("aal2_required");
    expect(decidePolicy({ action: "repository.write", resource: "github:other/repo", mode: "code", assuranceLevel: "aal2", permissions: new Set(["repository.write"]) }, rules).reason).toBe("no_allow_rule");
  });

  it("requires a resource-bound temporary credential for writes", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    const executor = { execute: vi.fn(async () => ({ ok: true })) };
    const gateway = new ToolGateway(new Map([["github.commit", { name: "github.commit", requiredPermission: "repository.write", risk: "write", inputSchema: { required: ["sha"] } }]]), rules, executor, audit);
    const call = { requestId: "r", runId: "run", tool: "github.commit", resource: "github:heke99/localai", mode: "code", input: { sha: "abc" }, actor: { permissions: new Set(["repository.write"]), assuranceLevel: "aal2" as const } };
    await expect(gateway.execute(call)).rejects.toThrow("scoped_credential_required");
    await expect(gateway.execute(call, { token: "opaque", expiresAt: new Date(Date.now() + 1000), capabilities: new Set(["repository.write"]), resource: call.resource })).resolves.toEqual({ ok: true });
  });

  it("rejects unsafe sandbox requests", () => {
    expect(() => validateSandboxRequest({ runId: "r", profile: "lab", cpuLimit: 4, memoryMb: 4096, ttlSeconds: 60, network: { default: "deny", allowHosts: ["*"], allowCidrs: [] } })).toThrow("sandbox_wildcard_egress_forbidden");
  });

  it("only promotes approved global knowledge and rejects secrets", () => {
    expect(() => prepareKnowledge({ scope: "global", sourceType: "text", content: "trusted information", provenance: { submittedBy: "u", capturedAt: new Date().toISOString() } })).toThrow("global_knowledge_requires_superadmin_approval");
    expect(() => prepareKnowledge({ scope: "user", sourceType: "text", content: "token sk-secret-value", provenance: { submittedBy: "u", capturedAt: new Date().toISOString() } })).toThrow("knowledge_secret_detected");
  });

  it("blocks promotion without pinned runtime and passing critical evals", () => {
    expect(evaluatePromotion({ lifecycle: "registered", runtimePinned: false, artifactVerified: true, holdoutUntouched: true, metrics: [{ key: "coding", score: 0.7, minimum: 0.8, critical: true }] }).blockers).toEqual(["runtime_not_pinned", "critical_eval_failed:coding"]);
  });

  it("scales deterministically within limits", () => {
    expect(decideScale({ minimumWarm: 1, maximumWorkers: 4, scaleUpQueueDepth: 3, scaleDownUtilization: 20 }, { readyWorkers: 1, provisioningWorkers: 0, queueDepth: 4, averageUtilization: 90 })).toBe("up");
  });

  it("caps credential leases", async () => {
    const broker = new CredentialBroker({ issue: vi.fn(), revoke: vi.fn() }, 300);
    await expect(broker.lease({ actorId: "u", connectionId: "c", resource: "r", capabilities: ["x"], ttlSeconds: 301 })).rejects.toThrow("credential_ttl_exceeded");
  });
});
