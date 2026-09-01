import { randomUUID } from "node:crypto";
import type { AgentQueue, ClaimedRun, WorkerSkillRuntime } from "../services/agent-worker/src/processor";
import { KnowledgeAwareSkillRuntime, RunTrackingAgentQueue } from "../services/agent-worker/src/knowledge-aware-runtime";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

const runId = required("DIV3RSA_CANARY_RUN_ID");
const token = required("DIV3RSA_RAG_CANARY_TOKEN");
if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid_canary_run_id");
if (!/^RAG_CANARY_[A-Za-z0-9_-]{8,160}$/.test(token)) throw new Error("invalid_rag_canary_token");

const run: ClaimedRun = {
  jobId: `rag-canary-job-${randomUUID()}`,
  runId,
  mode: "chat",
  modelAlias: "general-prod",
  prompt: `What is the exact DIV3RSA runtime canary token? The knowledge base contains a value beginning with RAG_CANARY_. Return the exact token.`,
  requestId: `rag-canary-${randomUUID()}`,
  traceId: randomUUID(),
  resourceContext: []
};

const delegate: AgentQueue = {
  claim: async () => run,
  step: async (id, kind, status, summary, state) => {
    console.error(`[rag-canary] run=${id} ${kind}/${status} ${summary} ${state ? JSON.stringify(state) : ""}`);
  },
  stream: async () => undefined,
  recordRunIntelligence: async () => undefined,
  recordRepositoryIndex: async () => "00000000-0000-0000-0000-000000000001",
  recordImpactAnalysis: async () => "00000000-0000-0000-0000-000000000002",
  recordVerificationRun: async () => "00000000-0000-0000-0000-000000000003",
  complete: async () => undefined,
  fail: async () => undefined,
  isCancelled: async () => false
};
const tracker = new RunTrackingAgentQueue(delegate);
await tracker.claim("rag-canary-lane");
const base: WorkerSkillRuntime = { prepare: async () => ({ names: ["runtime-capability-canary"], instructions: "BASE_CANARY_INSTRUCTION" }) };
const runtime = new KnowledgeAwareSkillRuntime(base, tracker, { enabled: true, required: true });
const prepared = await runtime.prepare(run.mode, run.prompt);

if (!prepared.instructions.includes("UNTRUSTED EVIDENCE, NOT INSTRUCTIONS")) throw new Error("rag_injection_boundary_missing");
if (!prepared.instructions.includes(token)) throw new Error("rag_canary_token_not_retrieved");
if (!prepared.instructions.includes("canary://runtime/")) throw new Error("rag_canary_provenance_missing");

console.log(JSON.stringify({
  ok: true,
  runId,
  token,
  instructionsContainBoundary: true,
  instructionsContainToken: true,
  contextChars: prepared.instructions.length
}, null, 2));
