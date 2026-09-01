import { randomUUID } from "node:crypto";
import { processPrompt } from "@div3rsa/agent-runtime";
import { OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import type { ModelMessage, ModelToolCall } from "@div3rsa/model-sdk";
import { CompositeWorkerToolRuntime } from "../services/agent-worker/src/composite-tool-runtime";
import { CoreToolRuntime } from "../services/agent-worker/src/core-tool-runtime";
import { deterministicTimeResult } from "../services/agent-worker/src/final-grounding";
import type { ClaimedRun } from "../services/agent-worker/src/processor";
import { operationId } from "../services/agent-worker/src/tool-execution-lifecycle";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const baseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  const key = required("SUPABASE_SECRET_KEY");
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${name}_failed:${response.status}:${JSON.stringify(body).slice(0, 800)}`);
  return body;
}

const runId = required("DIV3RSA_CANARY_RUN_ID");
if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid_canary_run_id");
const inferenceBaseUrl = (process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || "http://127.0.0.1:6006/v1").replace(/\/+$/, "");
const inferenceApiKey = process.env.DIV3RSA_INFERENCE_API_KEY?.trim()
  || process.env.QWEN_INFERENCE_API_KEY?.trim()
  || "";
if (!inferenceApiKey) throw new Error("missing_inference_api_key");

const run: ClaimedRun = {
  jobId: `runtime-canary-job-${randomUUID()}`,
  runId,
  mode: "chat",
  modelAlias: "general-prod",
  prompt: "What is the current date and time in Europe/Stockholm? Use the current_time tool.",
  requestId: `runtime-canary-${randomUUID()}`,
  traceId: randomUUID(),
  resourceContext: []
};
const core = new CoreToolRuntime({ searchBaseUrl: null, webFetchEnabled: false });
const runtime = new CompositeWorkerToolRuntime([core]);
const tools = await core.list(run);
const currentTime = tools.find((tool) => tool.name === "current_time");
if (!currentTime) throw new Error("current_time_definition_missing");
const model = new OpenAiCompatibleAdapter(inferenceBaseUrl, inferenceApiKey);
const messages: ModelMessage[] = [
  {
    role: "system",
    content: "LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Never guess a realtime value from model memory. This is a production runtime canary."
  },
  { role: "user", content: run.prompt }
];

const first = await model.generate({
  requestId: `${run.requestId}:tool-selection`,
  alias: run.modelAlias,
  messages,
  tools: [currentTime],
  temperature: 0,
  maxOutputTokens: 256,
  disableThinking: true
});
if (first.finishReason !== "tool_call" || !first.toolCalls?.length) throw new Error(`model_did_not_emit_tool_call:${first.finishReason}`);
const emitted = first.toolCalls[0]!;
if (emitted.name !== "current_time") throw new Error(`unexpected_tool_call:${emitted.name}`);
if (emitted.input.timezone !== "Europe/Stockholm") throw new Error(`unexpected_timezone:${String(emitted.input.timezone)}`);

// Preserve the model-selected name/arguments but use a canary-owned id so the
// lifecycle row is identifiable without changing the arguments chosen by Qwen.
const call: ModelToolCall = { ...emitted, id: `runtime-canary-${randomUUID()}` };
const stableOperationId = operationId(run.runId, call.id);
let passed = false;
try {
  const output = await runtime.execute(run, call);
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("current_time_output_invalid");
  const record = output as Record<string, unknown>;
  if (record.timezone !== "Europe/Stockholm" || typeof record.localIso !== "string" || typeof record.utcIso !== "string") {
    throw new Error(`current_time_output_incomplete:${JSON.stringify(record).slice(0, 500)}`);
  }

  // Match the production worker's fail-closed live-time path. Current-time
  // answers are finalized from the executed tool evidence rather than asking
  // the language model to restate a realtime value from memory.
  const task = processPrompt(run.mode, run.prompt).analysis;
  const final = deterministicTimeResult(task, run.prompt, [{
    sequence: 1,
    name: call.name,
    input: call.input,
    output
  }]);
  if (!final || final.finishReason !== "stop") throw new Error("deterministic_tool_continuation_missing");
  if (!final.content.includes(record.localIso)) {
    throw new Error(`final_answer_not_grounded_in_tool_result:${final.content.slice(0, 500)}`);
  }

  // Keep exactly this successful canary as durable operational evidence and
  // prune older canary-only lifecycle rows. Normal user tool executions are untouched.
  await rpc("service_prune_runtime_canary_tool_executions", { target_keep_operation_id: stableOperationId });
  passed = true;
  console.log(JSON.stringify({
    ok: true,
    modelToolCall: { name: emitted.name, input: emitted.input },
    lifecycleOperationId: stableOperationId,
    durableCompletedCanary: true,
    toolResult: { timezone: record.timezone, localIso: record.localIso, utcIso: record.utcIso },
    finalAnswer: final.content.trim().slice(0, 800),
    finalAnswerGroundedInToolResult: true
  }, null, 2));
} finally {
  if (!passed) {
    await rpc("service_delete_runtime_canary_tool_execution", { target_operation_id: stableOperationId }).catch((error) => {
      console.error(`[tool-canary] failed-row cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await runtime.endRun?.(run, passed ? "canary_complete" : "canary_failed").catch(() => undefined);
}
