import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const label = process.argv[2] || "unknown";
const key = (await readFile("/root/autodl-tmp/localai/secrets/inference-api-key", "utf8")).trim();
const endpoint = "http://127.0.0.1:6006/v1/chat/completions";
const model = "localai-qwen38-v3-q8";

async function streamRequest(name, messages, extra = {}) {
  const started = performance.now();
  let firstReasoning = null;
  let firstContent = null;
  let content = "";
  let reasoningChars = 0;
  let usage = null;
  let timings = null;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 768, stream: true, stream_options: { include_usage: true }, cache_prompt: true, ...extra }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status} ${await response.text()}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? "";
        if (reasoning) {
          if (firstReasoning == null) firstReasoning = performance.now();
          reasoningChars += String(reasoning).length;
        }
        if (delta.content) {
          if (firstContent == null) firstContent = performance.now();
          content += delta.content;
        }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.timings) timings = parsed.timings;
      }
    }
  }
  const ended = performance.now();
  return {
    name,
    firstReasoningMs: firstReasoning == null ? null : Math.round(firstReasoning - started),
    firstContentMs: firstContent == null ? null : Math.round(firstContent - started),
    totalMs: Math.round(ended - started),
    reasoningChars,
    content,
    usage,
    timings
  };
}

const standardPrompt = "Du driver en Node.js tjänst med 8 workers. Varje worker klarar 12 jobb per minut vid 100% belastning. För att behålla stabilitet får produktion köras på högst 75% av den teoretiska kapaciteten. Vilken säker total kapacitet i jobb per minut får systemet? Visa kort beräkning och slutsats.";
const asyncPrompt = "Review this JavaScript and return the corrected code plus one concise explanation: async function loadAll(ids) { const values = ids.map(async id => load(id)); return values; } The caller must receive resolved values, not promises.";
const architecturePrompt = "Jämför server-side polling mot SSE för statusuppdateringar i en multi-tenant AI-agent. Fokusera på latency, request-overhead, skalning vid många samtidiga användare och återhämtning vid tappad anslutning. Ge en kort rekommendation och ange den viktigaste tradeoffen.";

const cases = [];
cases.push(await streamRequest("capacity", [{ role: "user", content: standardPrompt }], { max_tokens: 320 }));
cases.push(await streamRequest("async_bug", [{ role: "user", content: asyncPrompt }], { max_tokens: 320 }));
cases.push(await streamRequest("architecture_1", [{ role: "user", content: architecturePrompt }], { max_tokens: 768 }));
cases.push(await streamRequest("architecture_2", [{ role: "user", content: architecturePrompt }], { max_tokens: 768 }));

const prefix = [
  "You are reviewing a TypeScript service. Preserve behavior and answer only the question.",
  ...Array.from({ length: 350 }, (_, i) => `Invariant ${i + 1}: tenant isolation, idempotency, deterministic ordering, bounded retries, structured audit evidence.`),
  "The implementation uses a queue, a worker pool, durable events, and SSE delivery."
].join("\n");
const prefixResults = [];
for (let i = 0; i < 3; i += 1) {
  prefixResults.push(await streamRequest(`prefix_${i + 1}`, [
    { role: "system", content: prefix },
    { role: "user", content: `Return only the integer ${40 + i + 1}.` }
  ], { max_tokens: 24, reasoning_effort: "none" }));
}

const quality = {
  capacity72: /\b72\b/.test(cases[0].content),
  asyncPromiseAll: /Promise\.all/.test(cases[1].content),
  prefixCorrect: prefixResults.every((r, i) => new RegExp(`\\b${41 + i}\\b`).test(r.content))
};

console.log(JSON.stringify({ label, quality, cases, prefixResults }, null, 2));
if (!Object.values(quality).every(Boolean)) process.exitCode = 2;
