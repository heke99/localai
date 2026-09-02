import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelAdapter, ModelMessage } from "@div3rsa/model-sdk";
import { VerifiedMemoryAdapter, fitConversationHistory, memoryScopeFromRequest } from "./memory-adapter";
import type { SupabaseAgentKernelStore } from "./store";

const request: GenerateRequest = {
  requestId: "req-1:0:0",
  alias: "code-prod",
  messages: [
    { role: "system", content: 'Execution tier: STANDARD; context budget: 16000; repository depth: targeted.\nExecution contract:\n{}\nRepository intelligence:\n{"repository":"Heke99/LocalAI","ref":"main"}\nSelected project resources:\n[]' },
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

function store(overrides: Partial<SupabaseAgentKernelStore> = {}) {
  return {
    conversationHistory: vi.fn(async () => []),
    findMemories: vi.fn(async () => []),
    ...overrides
  } as unknown as SupabaseAgentKernelStore;
}

describe("VerifiedMemoryAdapter", () => {
  it("derives stable repository scope from the primary execution context", () => {
    expect(memoryScopeFromRequest(request)).toBe("repo:heke99/localai");
  });

  it("injects prior user and assistant turns before the current user prompt even when verified memory is disabled", async () => {
    const underlying = base();
    const history: ModelMessage[] = [
      { role: "user", content: "Use PostgreSQL for the migration." },
      { role: "assistant", content: "Understood; I will use PostgreSQL." }
    ];
    const kernelStore = store({ conversationHistory: vi.fn(async () => history) as never });
    const adapter = new VerifiedMemoryAdapter(underlying, kernelStore, false, { warn: vi.fn() });

    await adapter.generate(request);

    expect(kernelStore.conversationHistory).toHaveBeenCalledWith("req-1", 60);
    expect(underlying.generate).toHaveBeenCalledOnce();
    const sent = (underlying.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as GenerateRequest;
    expect(sent.messages.map((message) => [message.role, message.content])).toEqual([
      ["system", request.messages[0]?.content],
      ["user", "Use PostgreSQL for the migration."],
      ["assistant", "Understood; I will use PostgreSQL."],
      ["user", "fix it"]
    ]);
  });

  it("reuses conversation history across model turns for the same run request", async () => {
    const underlying = base();
    const kernelStore = store({ conversationHistory: vi.fn(async () => [{ role: "user", content: "Earlier context" }]) as never });
    const adapter = new VerifiedMemoryAdapter(underlying, kernelStore, false, { warn: vi.fn() });

    await adapter.generate(request);
    await adapter.generate({ ...request, requestId: "req-1:0:1" });

    expect(kernelStore.conversationHistory).toHaveBeenCalledOnce();
    expect(underlying.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest complete history and never starts with an orphan assistant answer", () => {
    const fitted = fitConversationHistory([
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant" },
      { role: "user", content: "new user" },
      { role: "assistant", content: "new assistant" }
    ], 90);

    expect(fitted).toEqual([
      { role: "user", content: "new user" },
      { role: "assistant", content: "new assistant" }
    ]);
    expect(fitConversationHistory([{ role: "assistant", content: "orphan" }], 100)).toEqual([]);
  });

  it("injects only planning-eligible verified memory into primary execution", async () => {
    const underlying = base();
    const kernelStore = store({
      findMemories: vi.fn(async () => [
        { id: "a", tier: "verified_experience", scope: "repo:heke99/localai", summary: "Use targeted regression tests.", evidenceRefs: ["verification:unit-tests"], sourceRunId: "r", createdAt: new Date().toISOString(), verified: true, confidence: 1 },
        { id: "b", tier: "procedural", scope: "repo:heke99/localai", summary: "unverified must not appear", evidenceRefs: [], sourceRunId: "r", createdAt: new Date().toISOString(), verified: false, confidence: 0.5 }
      ]) as never
    });
    const adapter = new VerifiedMemoryAdapter(underlying, kernelStore, true, { warn: vi.fn() });
    const result = await adapter.generate(request);
    expect(kernelStore.findMemories).toHaveBeenCalledWith("repo:heke99/localai", 8);
    expect(result.content).toContain("VERIFIED PROCEDURAL MEMORY");
    expect(result.content).toContain("Use targeted regression tests.");
    expect(result.content).not.toContain("unverified must not appear");
  });

  it("fails closed when primary conversation history cannot be loaded", async () => {
    const underlying = base();
    const kernelStore = store({ conversationHistory: vi.fn(async () => { throw new Error("history_rpc_failed"); }) as never });
    const adapter = new VerifiedMemoryAdapter(underlying, kernelStore, false, { warn: vi.fn() });

    await expect(adapter.generate(request)).rejects.toThrow("history_rpc_failed");
    expect(underlying.generate).not.toHaveBeenCalled();
  });

  it("never augments internal verifier calls", async () => {
    const underlying = base();
    const kernelStore = store();
    const adapter = new VerifiedMemoryAdapter(underlying, kernelStore, true, { warn: vi.fn() });
    await adapter.generate({ ...request, alias: "verifier-prod", messages: [{ role: "system", content: "independent verifier" }, { role: "user", content: "review" }] });
    expect(kernelStore.conversationHistory).not.toHaveBeenCalled();
    expect(kernelStore.findMemories).not.toHaveBeenCalled();
  });
});
