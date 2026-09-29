import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SkillEngine, formatSkillInstructions, skillRuntimeOptionsFromEnvironment, type SkillManifest } from "@div3rsa/skill-engine";
import type { ModelInferenceProtocol, ModelProtocolProfile } from "@div3rsa/model-sdk";
import { createInferenceAdapter, modelProtocolProfileFromEnvironment } from "../../model-gateway/src/adapter-factory";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun, type WorkerSkillRuntime, type WorkerToolRuntime } from "./processor";
import { CoreToolRuntime } from "./core-tool-runtime";
import { SecurityToolRuntime, type SecurityExecutorRequest } from "./security-tool-runtime";
import type { SecurityOperationId } from "./pentest-capability-planner";

// Use the shipped artifact and real bodies, not a synthetic manifest or a test-only skill list.
const root = new URL("../../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("skills/runtime-manifest.json", root), "utf8")) as SkillManifest;
function skills() {
  const engine = new SkillEngine(manifest, { read: (path) => readFile(new URL(path, root), "utf8") }, skillRuntimeOptionsFromEnvironment({}));
  const runtime: WorkerSkillRuntime = {
    async prepare(mode, prompt) {
      const loaded = await engine.load(engine.select(mode, prompt));
      return { names: loaded.map((skill) => skill.metadata.name), instructions: formatSkillInstructions(loaded) };
    }
  };
  return runtime;
}

function claimed(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return { jobId: "job", runId: "run", mode: "chat", modelAlias: "general-prod", prompt: "What is two plus two?", requestId: "request", traceId: "trace", resourceContext: [], ...overrides };
}

function queue(run: ClaimedRun) {
  return {
    claim: vi.fn().mockResolvedValueOnce(run).mockResolvedValue(null),
    step: vi.fn(async () => undefined), stream: vi.fn(async () => undefined),
    recordRunIntelligence: vi.fn<AgentQueue["recordRunIntelligence"]>(async () => undefined),
    recordRepositoryIndex: vi.fn(async () => "index"), recordImpactAnalysis: vi.fn(async () => "impact"),
    recordVerificationRun: vi.fn<AgentQueue["recordVerificationRun"]>(async () => "verification"),
    complete: vi.fn<AgentQueue["complete"]>(async () => undefined), fail: vi.fn<AgentQueue["fail"]>(async () => undefined),
    isCancelled: vi.fn(async () => false)
  } satisfies AgentQueue;
}

type WireMessage = { role: string; content?: string; name?: string; tool_call_id?: string };
type WireRequest = { model: string; stream?: boolean; messages: WireMessage[]; tools?: unknown[]; chat_template_kwargs?: unknown; cache_prompt?: unknown; json_schema?: unknown };
type WireCall = { id: string; type: "function"; function: { name: string; arguments: string } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Only HTTP transport is a fixture. Production adapter, skill engine and worker are exercised together. */
function inference(protocol: ModelInferenceProtocol, answer: string, call?: { name: string; input: Record<string, unknown> }) {
  const profile: ModelProtocolProfile = modelProtocolProfileFromEnvironment(protocol === "qwen-llamacpp" ? {} : {
    DIV3RSA_INFERENCE_PROTOCOL: "generic-openai", DIV3RSA_INFERENCE_MODEL_NAME: "replacement-model",
    DIV3RSA_INFERENCE_MODEL_VERSION_ID: "replacement-model-v1",
    DIV3RSA_INFERENCE_MODEL_CAPABILITIES: "general,reasoning,research,security,tool_use,verification"
  });
  const requests: WireRequest[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as WireRequest;
    requests.push(body);
    const system = body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const review = /independent.*(?:reviewer|review)|evidence reviewer/i.test(system) && !body.tools?.length;
    const observed = body.messages.some((message) => message.role === "tool" && message.name === call?.name);
    const toolCalls: WireCall[] | undefined = call && !observed && body.tools?.length ? [{
      id: "fixture-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) }
    }] : undefined;
    const content = review ? '{"passed":true,"reason":"Fixture evidence was opened and matches the answer."}' : toolCalls ? null : answer;
    const finish = toolCalls ? "tool_calls" : "stop";
    if (body.stream) {
      const delta = toolCalls ? { tool_calls: toolCalls.map((tool) => ({ index: 0, ...tool })) } : { content };
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return json({ choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  });
  return { profile, requests, adapter: createInferenceAdapter({ baseUrl: "https://fixture-model.invalid/v1", apiKey: "fixture", profile, fetcher }) };
}

function scoped(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return claimed({ mode: "lab", prompt: "Check the HTTP response headers of our authorized target https://owned.example.test.", resourceContext: [{
    resourceId: "owner-approved-scope", connectionId: "scope", provider: "security", resourceType: "security_scope",
    externalResourceId: "owner-approved-scope", displayName: "Owned test fixture", capabilities: ["security.passive", "security.active"],
    metadata: { allowHosts: ["owned.example.test"], allowIpv4Cidrs: [] }
  }], ...overrides });
}

function security(operations: SecurityOperationId[] = ["http_probe"]) {
  const runtimeSkills = skills();
  const execute = vi.fn(async (_request: SecurityExecutorRequest) => ({ ok: true, exitCode: 0, durationMs: 1, stdout: "Fixture response: HTTP 200; x-content-type-options: nosniff", findings: [], auditId: "fixture-audit" }));
  const runtime = new SecurityToolRuntime({ execute, capabilities: async () => ({ schemaVersion: 1, ready: true, complete: operations.length === 6, checkedAt: new Date().toISOString(), operations }) }, async (run) => (await runtimeSkills.prepare(run.mode, run.prompt)).names);
  return { runtimeSkills, runtime, execute };
}

describe("shipped minimal skill artifact", () => {
  for (const [mode, count] of [["chat", 3], ["code", 5], ["lab", 7], ["research", 5]] as const) {
    it(`starts and loads all verified ${mode} prerequisites from the checked-in manifest`, async () => {
      const prepared = await skills().prepare(mode, "");
      expect(prepared.names).toHaveLength(count);
      expect(prepared.names).toContain("reasoning-router");
      expect(prepared.instructions).toContain("# Reasoning Router");
      expect(prepared.instructions.length).toBeLessThanOrEqual(32_000);
    });
  }
});

for (const protocol of ["qwen-llamacpp", "generic-openai"] as const) {
  describe(`minimal worker with ${protocol}`, () => {
    it("answers a stable question with only the three base skills", async () => {
      const run = claimed(); const jobs = queue(run); const wire = inference(protocol, "Two plus two is four.");
      const runtimeSkills = skills(); const prepared = await runtimeSkills.prepare(run.mode, run.prompt);
      await new AgentWorkerProcessor(jobs, { resolve: () => wire.adapter }, "worker", runtimeSkills).processOnce();
      expect(jobs.fail).not.toHaveBeenCalled();
      expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: "Two plus two is four.", modelVersionId: wire.profile.modelVersionId }));
      expect(jobs.recordRunIntelligence.mock.calls[0]?.[2]).toEqual(prepared.names);
      expect(wire.requests[0]?.messages[0]?.content).toContain(prepared.instructions);
      expect(wire.requests[0]?.model).toBe(wire.profile.runtimeModel);
      if (protocol === "generic-openai") for (const body of wire.requests) {
        expect(body.chat_template_kwargs).toBeUndefined(); expect(body.cache_prompt).toBeUndefined(); expect(body.json_schema).toBeUndefined();
      }
    });

    it("searches and opens current evidence before answering using the same skills", async () => {
      const run = claimed({ prompt: "What is the current release of Example Runtime?" }); const jobs = queue(run);
      const pageUrl = "https://docs.example.test/releases";
      const transport = vi.fn<typeof fetch>(async (input) => String(input).startsWith("https://fixture-search.invalid")
        ? json({ results: [{ url: pageUrl, title: "Official current release", content: "Current release v2.0.0" }] })
        : new Response("<html><body>Example Runtime current release is v2.0.0.</body></html>", { headers: { "content-type": "text/html" } }));
      const tools = new CoreToolRuntime({ searchBaseUrl: "https://fixture-search.invalid", fetcher: transport, resolveHost: async () => ["93.184.216.34"] });
      const wire = inference(protocol, `The current release is v2.0.0 according to ${pageUrl}.`);
      await new AgentWorkerProcessor(jobs, { resolve: () => wire.adapter }, "worker", skills(), tools).processOnce();
      expect(jobs.fail).not.toHaveBeenCalled();
      expect(transport.mock.calls.some(([input]) => String(input) === pageUrl)).toBe(true);
      expect(wire.requests[0]?.messages.some((message) => message.role === "tool" && message.name === "web_fetch" && message.content?.includes("v2.0.0"))).toBe(true);
      expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: expect.stringContaining("v2.0.0"), modelVersionId: wire.profile.modelVersionId }));
    });

    it("executes an authorized probe and continues from its real runtime observation", async () => {
      const run = scoped(); const jobs = queue(run); const sec = security();
      const wire = inference(protocol, "The scoped HTTP probe returned HTTP 200 with x-content-type-options: nosniff.", { name: "security_scan", input: { tool: "http_probe", target: "https://owned.example.test" } });
      await new AgentWorkerProcessor(jobs, { resolve: () => wire.adapter }, "worker", sec.runtimeSkills, sec.runtime).processOnce();
      expect(jobs.fail).not.toHaveBeenCalled();
      expect(sec.execute).toHaveBeenCalledOnce();
      expect(sec.execute.mock.calls[0]?.[0]).toMatchObject({ target: "https://owned.example.test", scope: { scopeId: "owner-approved-scope" } });
      expect(wire.requests.some((body) => body.messages.some((message) => message.role === "tool" && message.name === "security_scan" && message.content?.includes("nosniff")))).toBe(true);
      expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ modelVersionId: wire.profile.modelVersionId }));
    });

    it("does not grant authorization from Lab skill instructions or a prompt", async () => {
      const run = scoped({ resourceContext: [] }); const sec = security();
      expect((await sec.runtimeSkills.prepare("lab", run.prompt)).names).toContain("authorized-pentest");
      expect(await sec.runtime.list(run)).toEqual([]);
      await expect(sec.runtime.execute(run, { id: "denied", name: "security_scan", input: { tool: "http_probe", target: "https://owned.example.test" } })).rejects.toThrow();
      expect(sec.execute).not.toHaveBeenCalled();
    });

    it("blocks an out-of-scope model call before reaching the executor", async () => {
      const run = scoped(); const jobs = queue(run); const sec = security(["http_probe", "tls_probe", "dns_lookup", "port_scan", "template_scan", "content_discovery"]);
      const wire = inference(protocol, "unused", { name: "security_scan", input: { tool: "http_probe", target: "https://third-party.example.test" } });
      await new AgentWorkerProcessor(jobs, { resolve: () => wire.adapter }, "worker", sec.runtimeSkills, sec.runtime).processOnce();
      expect(sec.execute).not.toHaveBeenCalled();
      expect(jobs.complete).not.toHaveBeenCalled();
      expect(jobs.fail).toHaveBeenCalledWith(run, "security_target_out_of_scope", false);
    });

    it("keeps active test permission independent from the selected model and skills", async () => {
      const sec = security(["http_probe", "port_scan"]); const authorized = scoped({ prompt: "Run a bounded port scan of our authorized target." });
      const call = { id: "ports", name: "security_scan", input: { tool: "port_scan", target: "owned.example.test", options: { ports: [443] } } };
      await sec.runtime.execute(authorized, call);
      expect(sec.execute).toHaveBeenCalledOnce();
      const passiveOnly = { ...authorized, resourceContext: authorized.resourceContext.map((resource) => ({ ...resource, capabilities: ["security.passive"] })) };
      await expect(sec.runtime.execute(passiveOnly, call)).rejects.toThrow("security_active_capability_required");
      expect(sec.execute).toHaveBeenCalledOnce();
    });

    it("cancels before dispatch without losing the core skill configuration", async () => {
      const run = claimed(); const jobs = queue(run); const wire = inference(protocol, "unused");
      jobs.isCancelled.mockResolvedValue(true);
      await new AgentWorkerProcessor(jobs, { resolve: () => wire.adapter }, "worker", skills()).processOnce();
      expect(wire.requests).toEqual([]); expect(jobs.complete).not.toHaveBeenCalled(); expect(jobs.fail).not.toHaveBeenCalled();
      expect(jobs.recordRunIntelligence.mock.calls[0]?.[2]).toHaveLength(3);
    });
  });
}
