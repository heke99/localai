import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const apiKey = (await readFile("/root/autodl-tmp/localai/secrets/inference-api-key", "utf8")).trim();
const endpoint = "http://127.0.0.1:6006/v1/chat/completions";
const model = "localai-qwen38-v3-q8";
const system = "Reasoning policy: STANDARD: decompose material subproblems, verify assumptions, then answer. STABLE INFORMATION: external research is not required. Be concise and follow the requested output format.";

const repoTools = [
  { type: "function", function: { name: "repo_read", description: "Read an exact repository file path before changing it.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "repo_search", description: "Search repository text when the relevant file is unknown.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "repo_write", description: "Write a repository file after relevant source has been inspected.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }
];

const cases = [
  {
    name: "capacity_math",
    prompt: "A service has 8 workers. Each can sustain 12 requests/second. Reserve 25% of total capacity for spikes. What steady-state request rate should we admit? Return only the number.",
    check: ({ content }) => /(^|\D)72(?:\.0+)?($|\D)/.test(content)
  },
  {
    name: "async_bug",
    prompt: "Fix the concurrency bug in this JavaScript and explain in one sentence: `const values = ids.map(async id => load(id)); return values;` The caller needs resolved values, not promises.",
    check: ({ content }) => /Promise\.all/i.test(content) && /await/i.test(content)
  },
  {
    name: "sql_index",
    prompt: "Postgres query: `select * from jobs where tenant_id=$1 and status='queued' order by created_at desc limit 50`. Name the most useful composite btree index column order. Keep the answer to one line.",
    check: ({ content }) => /tenant_id/i.test(content) && /status/i.test(content) && /created_at/i.test(content)
  },
  {
    name: "idempotency",
    prompt: "An HTTP payment webhook may be delivered multiple times and two workers may process the same event concurrently. Give the two most important database/runtime controls that prevent duplicate side effects. Max 45 words.",
    check: ({ content }) => /idempot|unique/i.test(content) && /transaction|constraint|conflict|lock/i.test(content)
  },
  {
    name: "known_file_tool",
    prompt: "Before changing the npm scripts, inspect the repository's package.json. Use the appropriate repository tool first; do not write anything yet.",
    tools: repoTools,
    check: ({ toolCalls }) => toolCalls.some((call) => call.name === "repo_read" && call.arguments.includes("package.json"))
  },
  {
    name: "unknown_file_tool",
    prompt: "Find where `ensureModelRuntime` is implemented in the repository. You do not know the file path yet. Use the appropriate repository tool first and do not modify anything.",
    tools: repoTools,
    check: ({ toolCalls }) => toolCalls.some((call) => call.name === "repo_search" && call.arguments.includes("ensureModelRuntime"))
  }
];

async function runCase(testCase, effort) {
  const body = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: testCase.prompt }],
    max_tokens: 768,
    temperature: 0,
    cache_prompt: false,
    stream: true,
    stream_options: { include_usage: true },
    tools: testCase.tools
  };
  if (effort) body.reasoning_effort = effort;
  const started = performance.now();
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) throw new Error(`${testCase.name}:${effort ?? "default"}:http_${response.status}`);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let firstActionMs = null;
  let firstReasoningMs = null;
  let content = "";
  let usage = null;
  const toolParts = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      const payload = JSON.parse(raw);
      const delta = payload.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content && firstReasoningMs === null) firstReasoningMs = performance.now() - started;
      if (delta.content) {
        if (firstActionMs === null) firstActionMs = performance.now() - started;
        content += delta.content;
      }
      for (const part of delta.tool_calls ?? []) {
        if (firstActionMs === null) firstActionMs = performance.now() - started;
        const index = part.index ?? 0;
        const current = toolParts.get(index) ?? { name: "", arguments: "" };
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolParts.set(index, current);
      }
      if (payload.usage) usage = payload.usage;
    }
  }
  const toolCalls = [...toolParts.values()];
  const result = {
    case: testCase.name,
    effort: effort ?? "default",
    passed: testCase.check({ content, toolCalls }),
    firstReasoningMs: firstReasoningMs === null ? null : Math.round(firstReasoningMs),
    firstActionMs: firstActionMs === null ? null : Math.round(firstActionMs),
    totalMs: Math.round(performance.now() - started),
    completionTokens: usage?.completion_tokens ?? null,
    content: content.trim().slice(0, 700),
    toolCalls
  };
  console.log(JSON.stringify(result));
  return result;
}

const results = [];
for (const testCase of cases) {
  results.push(await runCase(testCase, null));
  results.push(await runCase(testCase, "none"));
}
const grouped = Object.fromEntries(cases.map((testCase) => [testCase.name, results.filter((item) => item.case === testCase.name)]));
const defaultPassed = results.filter((item) => item.effort === "default" && item.passed).length;
const nonePassed = results.filter((item) => item.effort === "none" && item.passed).length;
const median = (values) => { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; };
console.log(JSON.stringify({ summary: { totalCases: cases.length, defaultPassed, nonePassed, defaultMedianFirstActionMs: median(results.filter((item) => item.effort === "default").map((item) => item.firstActionMs ?? item.totalMs)), noneMedianFirstActionMs: median(results.filter((item) => item.effort === "none").map((item) => item.firstActionMs ?? item.totalMs)) }, grouped }));
if (nonePassed < defaultPassed) process.exitCode = 2;
