import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ModelMessage, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { compactToolOutput } from "./tool-output";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "./processor";
import type { WorkerToolTrace } from "./worker-verification";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function explicitTimezone(prompt: string): string | null {
  const match = prompt.match(/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?\b/);
  if (match) return match[0];
  const aliases: Array<[RegExp, string]> = [
    [/\b(stockholm|sweden|sverige)\b/i, "Europe/Stockholm"],
    [/\b(london|united kingdom|uk)\b/i, "Europe/London"],
    [/\b(tokyo|japan)\b/i, "Asia/Tokyo"],
    [/\b(dubai|uae|united arab emirates)\b/i, "Asia/Dubai"],
    [/\b(new york|nyc)\b/i, "America/New_York"],
    [/\b(los angeles|la)\b/i, "America/Los_Angeles"],
    [/\b(chicago)\b/i, "America/Chicago"],
    [/\b(sydney)\b/i, "Australia/Sydney"]
  ];
  return aliases.find(([pattern]) => pattern.test(prompt))?.[1]
    ?? process.env.DIV3RSA_DEFAULT_TIMEZONE?.trim()
    ?? "UTC";
}

function available(definitions: ModelToolDefinition[], name: string): boolean {
  return definitions.some((tool) => tool.name === name);
}

const latestIntentPattern = /\b(?:latest|current|newest|most\s+recent|latest\s+release|senaste|nyaste|aktuell(?:a|t)?)\b/i;
const currentIndexPattern = /(?:^|[\s/_-])(?:latest|current)(?:$|[\s/_-])|\blatest\s+(?:release|version|lts)\b|\bcurrent\s+(?:release|version)\b|(?:^|\/)downloads?(?:\/|$)/i;
const versionSpecificPathPattern = /(?:^|\/)v?\d+\.\d+\.\d+(?:\/|$)/i;

function currentIntentScore(url: URL, title: string, snippet: string): number {
  const evidence = `${url.pathname} ${title} ${snippet}`;
  if (currentIndexPattern.test(evidence)) return 4;
  if (/\b(?:release\s+schedule|release\s+index|versions?|releases?)\b/i.test(evidence)) return 3;
  if (versionSpecificPathPattern.test(url.pathname)) return 0;
  return 1;
}

function publishedTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export interface RankedSearchCandidate {
  url: string;
  rank: number;
  score: number;
  intentScore: number;
  publishedAtMs: number;
}

export function rankSearchCandidates(output: unknown, prompt: string): RankedSearchCandidate[] {
  const body = record(output);
  const results = Array.isArray(body?.results) ? body!.results : [];
  const seen = new Set<string>();
  const asksLatest = latestIntentPattern.test(prompt);
  const candidates = results.flatMap((item, index) => {
    const value = record(item);
    if (typeof value?.url !== "string") return [];
    let url: URL;
    try { url = new URL(value.url); } catch { return []; }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) return [];
    seen.add(url.href);
    const hostname = url.hostname.toLowerCase();
    const title = typeof value.title === "string" ? value.title : "";
    const snippet = typeof value.snippet === "string" ? value.snippet : "";
    const primary = /(?:^|\.)(?:gov(?:\.[a-z]{2})?|europa\.eu|who\.int|un\.org|riksdagen\.se|regeringen\.se|skatteverket\.se|svk\.se|digg\.se)$/i.test(hostname)
      || /^(?:docs|developer|developers|support|help)\./i.test(hostname);
    const reputable = /\.(?:edu|ac\.[a-z]{2})$/i.test(hostname);
    return [{
      url: url.href,
      rank: primary ? 0 : reputable ? 1 : 2,
      score: typeof value.score === "number" ? value.score : Math.max(0, 100 - index),
      intentScore: asksLatest ? currentIntentScore(url, title, snippet) : 0,
      publishedAtMs: publishedTimestamp(value.publishedAt)
    }];
  });

  return candidates.sort((a, b) => {
    if (asksLatest && a.intentScore !== b.intentScore) return b.intentScore - a.intentScore;
    if (asksLatest && a.publishedAtMs !== b.publishedAtMs) return b.publishedAtMs - a.publishedAtMs;
    return a.rank - b.rank || b.score - a.score;
  });
}

async function executeRequiredTool(input: {
  queue: AgentQueue;
  tools: WorkerToolRuntime;
  run: ClaimedRun;
  messages: ModelMessage[];
  trace: WorkerToolTrace[];
  call: ModelToolCall;
}): Promise<unknown> {
  const { queue, tools, run, messages, trace, call } = input;
  await queue.step(run.runId, "tool", "waiting_for_tool", call.name, {
    toolCallId: call.id,
    runtimeRequired: true,
    freshnessPreflight: true
  });
  const output = await tools.execute(run, call);
  trace.push({ sequence: trace.length + 1, name: call.name, input: call.input, output });
  messages.push({ role: "assistant", content: "", toolCalls: [call] });
  messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: compactToolOutput(output) });
  return output;
}

export async function collectRequiredFreshnessEvidence(input: {
  task: TaskAnalysis;
  normalizedPrompt: string;
  definitions: ModelToolDefinition[];
  queue: AgentQueue;
  tools: WorkerToolRuntime;
  run: ClaimedRun;
  messages: ModelMessage[];
  trace: WorkerToolTrace[];
}): Promise<void> {
  const { task, normalizedPrompt, definitions, queue, tools, run, messages, trace } = input;
  if (!task.requiresCurrentInformation) return;

  if (task.liveDataKind === "time") {
    if (!available(definitions, "current_time")) throw new Error("required_current_time_tool_unavailable");
    await executeRequiredTool({
      queue,
      tools,
      run,
      messages,
      trace,
      call: {
        id: `${run.requestId}:freshness:time`,
        name: "current_time",
        input: { timezone: explicitTimezone(normalizedPrompt) }
      }
    });
    return;
  }

  if (!available(definitions, "web_search")) throw new Error("required_web_search_tool_unavailable");
  if (!available(definitions, "web_fetch")) throw new Error("required_web_fetch_tool_unavailable");

  const searchOutput = await executeRequiredTool({
    queue,
    tools,
    run,
    messages,
    trace,
    call: {
      id: `${run.requestId}:freshness:search`,
      name: "web_search",
      input: { query: normalizedPrompt.slice(0, 500), limit: 12 }
    }
  });

  const candidates = rankSearchCandidates(searchOutput, normalizedPrompt);
  if (!candidates.length) throw new Error("current_information_search_returned_no_sources");
  const targetSources = task.researchDepth === "deep" || task.risk === "high" || task.risk === "critical" ? 2 : 1;
  const fetchedHosts = new Set<string>();
  let fetched = 0;
  let lastError: unknown = null;

  for (const candidate of candidates) {
    if (fetched >= targetSources) break;
    let hostname = "";
    try { hostname = new URL(candidate.url).hostname.toLowerCase(); } catch { continue; }
    if (fetchedHosts.has(hostname)) continue;
    try {
      await executeRequiredTool({
        queue,
        tools,
        run,
        messages,
        trace,
        call: {
          id: `${run.requestId}:freshness:fetch:${fetched + 1}`,
          name: "web_fetch",
          input: { url: candidate.url }
        }
      });
      fetchedHosts.add(hostname);
      fetched += 1;
    } catch (error) {
      lastError = error;
      await queue.step(run.runId, "tool", "blocked", "web_fetch", {
        runtimeRequired: true,
        freshnessPreflight: true,
        url: candidate.url,
        error: error instanceof Error ? error.message : "web_fetch_failed"
      });
    }
  }

  if (fetched < targetSources) {
    const detail = lastError instanceof Error ? lastError.message : "insufficient_opened_sources";
    throw new Error(`current_information_source_fetch_failed:${fetched}/${targetSources}:${detail}`);
  }
}
