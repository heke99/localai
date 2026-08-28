import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const apiKey = (await readFile("/root/autodl-tmp/localai/secrets/inference-api-key", "utf8")).trim();
const endpoint = "http://127.0.0.1:6006/v1/chat/completions";
const model = "localai-qwen38-v3-q8";

const prompts = {
  fast: "Svar kort på svenska: vad är skillnaden mellan RAM och VRAM? Max 60 ord.",
  standard: "Du granskar latency i en AI-chat. Jämför server-side polling mot SSE som primär transport. Ge tre konkreta tradeoffs och en rekommendation. Max 100 ord."
};

async function runCase(name, prompt, effort) {
  const request = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 768,
    temperature: 0,
    cache_prompt: false,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (effort) request.reasoning_effort = effort;

  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(request)
  });
  if (!response.ok || !response.body) throw new Error(`${name}:http_${response.status}`);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let firstReasoningMs = null;
  let firstVisibleMs = null;
  let visible = "";
  let usage = null;
  let timings = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const delta = payload.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content && firstReasoningMs === null) firstReasoningMs = performance.now() - started;
        if (delta.content) {
          if (firstVisibleMs === null) firstVisibleMs = performance.now() - started;
          visible += delta.content;
        }
        if (payload.usage) usage = payload.usage;
        if (payload.timings) timings = payload.timings;
      }
    }
  }

  return {
    name,
    effort: effort ?? "default",
    firstReasoningMs: firstReasoningMs === null ? null : Math.round(firstReasoningMs),
    firstVisibleMs: firstVisibleMs === null ? null : Math.round(firstVisibleMs),
    totalMs: Math.round(performance.now() - started),
    visibleChars: visible.length,
    completionTokens: usage?.completion_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
    serverPromptMs: timings?.prompt_ms ?? null,
    serverPredictedPerSecond: timings?.predicted_per_second ?? null
  };
}

const plan = [
  ["standard_default_1", prompts.standard, null],
  ["standard_medium_1", prompts.standard, "medium"],
  ["fast_default_1", prompts.fast, null],
  ["fast_none_1", prompts.fast, "none"],
  ["fast_none_2", prompts.fast, "none"],
  ["fast_default_2", prompts.fast, null],
  ["standard_medium_2", prompts.standard, "medium"],
  ["standard_default_2", prompts.standard, null]
];

const results = [];
for (const [name, prompt, effort] of plan) {
  const result = await runCase(name, prompt, effort);
  results.push(result);
  console.log(JSON.stringify(result));
}
console.log(JSON.stringify({ summary: results }));
