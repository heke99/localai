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
const latestArtifactIntentPattern = /(?:\b(?:latest|newest|most\s+recent|senaste|nyaste|current|aktuell(?:a|t)?)\b[\s\S]{0,80}\b(?:release|version(?:en)?|build|firmware)\b)|(?:\b(?:release|version(?:en)?|build|firmware)\b[\s\S]{0,80}\b(?:latest|newest|most\s+recent|senaste|nyaste|current|aktuell(?:a|t)?)\b)/i;
const explicitCurrentPathPattern = /(?:^|\/)(?:latest|current)(?:\/|$)/i;
const explicitCurrentLabelPattern = /\b(?:latest\s+(?:release|version)|current\s+(?:release|version))\b/i;
const downloadIndexPattern = /(?:^|\/)downloads?(?:\/|$)/i;
const releaseIndexPattern = /\b(?:release\s+schedule|release\s+index|versions?|releases?)\b/i;
const versionSpecificPathPattern = /(?:^|\/)v?\d+\.\d+\.\d+(?:\/|$)/i;

function normalizedSearchQuery(value: string, maxLength = 500): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").slice(0, maxLength).trim();
}

function compactSearchSentence(sentence: string): string {
  let compact = normalizedSearchQuery(sentence, 240)
    .replace(/^(?:please\s+)?(?:find|search(?:\s+the\s+web)?(?:\s+for)?|look\s+up|verify|check|tell\s+me|show\s+me|what(?:'s|\s+is)|which\s+is)\s+/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
  const officialBoundary = compact.search(/\s+(?:from|using)\s+official\b/i);
  if (officialBoundary >= 8) compact = compact.slice(0, officialBoundary).trim();
  return normalizedSearchQuery(compact, 180);
}

export function freshnessSearchQueries(prompt: string): string[] {
  const normalized = normalizedSearchQuery(prompt);
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizedSearchQuery(sentence, 240))
    .filter((sentence) => sentence.length >= 4);
  const intentSentence = sentences.find((sentence) => latestIntentPattern.test(sentence))
    ?? sentences[0]
    ?? normalized;
  const compact = compactSearchSentence(intentSentence);
  const queries = [normalized, intentSentence, compact];
  return [...new Set(queries.filter((query) => query.length >= 4))].slice(0, 3);
}

function currentIntentScore(url: URL, title: string, snippet: string): number {
  if (explicitCurrentPathPattern.test(url.pathname)) return 6;
  if (versionSpecificPathPattern.test(url.pathname)) return 0;
  const textualEvidence = `${title} ${snippet}`;
  if (explicitCurrentLabelPattern.test(textualEvidence)) return 5;
  if (downloadIndexPattern.test(url.pathname)) return 4;
  if (releaseIndexPattern.test(`${url.pathname} ${textualEvidence}`)) return 3;
  return 1;
}

function publishedTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function searchResults(output: unknown): unknown[] {
  const body = record(output);
  return Array.isArray(body?.results) ? body.results : [];
}

function desiredFreshnessSources(task: TaskAnalysis): number {
  return task.researchDepth === "deep" || task.risk === "high" || task.risk === "critical" ? 3 : 2;
}

export interface RankedSearchCandidate {
  url: string;
  rank: number;
  score: number;
  intentScore: number;
  publishedAtMs: number;
}

export function rankSearchCandidates(output: unknown, prompt: string): RankedSearchCandidate[] {
  const results = searchResults(output);
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

function selectEvidenceCandidates(candidates: RankedSearchCandidate[], limit: number): RankedSearchCandidate[] {
  if (limit <= 0) return [];
  const selected: RankedSearchCandidate[] = [];
  const deferredSameHost: RankedSearchCandidate[] = [];
  const selectedHosts = new Set<string>();

  for (const candidate of candidates) {
    let hostname = "";
    try { hostname = new URL(candidate.url).hostname.toLowerCase(); } catch { continue; }
    if (selectedHosts.has(hostname)) {
      deferredSameHost.push(candidate);
      continue;
    }
    selected.push(candidate);
    selectedHosts.add(hostname);
    if (selected.length >= limit) return selected;
  }

  for (const candidate of deferredSameHost) {
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
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

  const searchQueries = freshnessSearchQueries(normalizedPrompt);
  const requiresLatestArtifactEvidence = latestArtifactIntentPattern.test(normalizedPrompt);
  const desiredSources = desiredFreshnessSources(task);
  const mergedResults: unknown[] = [];
  let candidates: RankedSearchCandidate[] = [];

  for (let index = 0; index < searchQueries.length; index += 1) {
    const query = searchQueries[index]!;
    try {
      const searchOutput = await executeRequiredTool({
        queue,
        tools,
        run,
        messages,
        trace,
        call: {
          id: index === 0 ? `${run.requestId}:freshness:search` : `${run.requestId}:freshness:search:${index + 1}`,
          name: "web_search",
          input: { query, limit: 12 }
        }
      });
      mergedResults.push(...searchResults(searchOutput));
      candidates = rankSearchCandidates({ results: mergedResults }, normalizedPrompt);
      if (!requiresLatestArtifactEvidence && candidates.length >= desiredSources) break;
    } catch (error) {
      await queue.step(run.runId, "tool", "blocked", "web_search", {
        runtimeRequired: true,
        freshnessPreflight: true,
        searchAttempt: index + 1,
        query,
        error: error instanceof Error ? error.message : "web_search_failed"
      });
    }
  }

  if (!candidates.length) throw new Error("current_information_search_returned_no_sources");

  const selectedCandidates = selectEvidenceCandidates(candidates, Math.min(desiredSources, candidates.length));
  const targetSources = selectedCandidates.length;
  let fetched = 0;
  let fetchAttempt = 0;
  let lastError: unknown = null;

  for (const candidate of selectedCandidates) {
    fetchAttempt += 1;
    try {
      await executeRequiredTool({
        queue,
        tools,
        run,
        messages,
        trace,
        call: {
          id: `${run.requestId}:freshness:fetch:${fetchAttempt}`,
          name: "web_fetch",
          input: { url: candidate.url }
        }
      });
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
