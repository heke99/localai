import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const apiKey = (await readFile("/root/autodl-tmp/localai/secrets/inference-api-key", "utf8")).trim();
const endpoint = "http://127.0.0.1:6006/v1/chat/completions";
const prompt = "Du granskar latency i en AI-chat. Jämför server-side polling mot SSE som primär transport. Ge tre konkreta tradeoffs och en rekommendation. Max 100 ord.";

async function run(name, effort) {
  const body = { model: "localai-qwen38-v3-q8", messages: [{ role: "user", content: prompt }], max_tokens: 768, temperature: 0, cache_prompt: false, stream: true, stream_options: { include_usage: true } };
  if (effort) body.reasoning_effort = effort;
  const started = performance.now();
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) throw new Error(`${name}:http_${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", visible = "", firstVisibleMs = null, firstReasoningMs = null, usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
    for (const event of events) for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
      const payload = JSON.parse(data), delta = payload.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content && firstReasoningMs === null) firstReasoningMs = performance.now() - started;
      if (delta.content) { if (firstVisibleMs === null) firstVisibleMs = performance.now() - started; visible += delta.content; }
      if (payload.usage) usage = payload.usage;
    }
  }
  console.log(JSON.stringify({ name, effort: effort ?? "default", firstReasoningMs: firstReasoningMs === null ? null : Math.round(firstReasoningMs), firstVisibleMs: firstVisibleMs === null ? null : Math.round(firstVisibleMs), totalMs: Math.round(performance.now() - started), completionTokens: usage?.completion_tokens ?? null, answer: visible.trim() }));
}

await run("standard_default_1", null);
await run("standard_low_1", "low");
await run("standard_low_2", "low");
await run("standard_default_2", null);
