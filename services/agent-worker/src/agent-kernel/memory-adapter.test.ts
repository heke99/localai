import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelAdapter } from "@div3rsa/model-sdk";
import { VerifiedMemoryAdapter, memoryScopeFromRequest } from "./memory-adapter";
import type { SupabaseAgentKernelStore } from "./store";

const request: GenerateRequest = {
  requestId: "req-1",
  alias: "code-prod",
  messages: [
    { role: "system", content: 'Execution contract:\n{}\nRepository intelligence:\n{"repository":"Heke99/LocalAI","ref":"main"}\nSelected project resources:\n[]' },
    { role: "user", content: "fix it" }
  ]
};

function base() {
  return {
    generate: vi.fn(async (input: GenerateRequest) => ({ modelVersionId: "m", content: input.messages[0]?.content ?? "", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } })),
    stream: vi.fn(async function* () { yield "x"; }),
    estimateTokens: vi.fn(async () => 1),
    getCapabilities: vi.fn(() => new Set()),
    healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 1 }))
  } as unknown as ModelAdapter;
}

describe("VerifiedMemoryAdapter", () => {
  it("derives stable repository scope from the primary execution context", () => {
    expect(memoryScopeFromRequest(request)).toBe("repo:heke99/localai");
  });

  it("injects only planning-eligible verified memory into primary execution", async () => {
    const underlying = base();
    const store = {
      findMemories: vi.fn(async () => [
        { id: "a", tier: "verified_experience", scope: "repo:heke99/localai", summary: "Use targeted regression tests.", evidenceRefs: ["verification:unit-tests"], sourceRunId: "r", createdAt: new Date().toISOString(), verified: true, confidence: 1 },
        { id: "b", tier: "procedural", scope: "repo:heke99/localai", summary: "unverified must not appear", evidenceRefs: [], sourceRunId: "r", createdAt: new Date().toISOString(), verified: false, confidence: 0.5 }
      ])
    } as unknown as SupabaseAgentKernelStore;
    const adapter = new VerifiedMemoryAdapter(underlying, store, true, { warn: vi.fn() });
    const result = await adapter.generate(request);
    expect(store.findMemories).toHaveBeenCalledWith("repo:heke99/localai", 8);
    expect(result.content).toContain("VERIFIED PROCEDURAL MEMORY");
    expect(result.content).toContain("Use targeted regression tests.");
    expect(result.content).not.toContain("unverified must not appear");
  });

  it("never augments internal verifier calls", async () => {
    const underlying = base();
    const store = { findMemories: vi.fn(async () => []) } as unknown as SupabaseAgentKernelStore;
    const adapter = new VerifiedMemoryAdapter(underlying, store, true, { warn: vi.fn() });
    await adapter.generate({ ...request, alias: "verifier-prod", messages: [{ role: "system", content: "independent verifier" }, { role: "user", content: "review" }] });
    expect(store.findMemories).not.toHaveBeenCalled();
  });
});
