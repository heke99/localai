import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { WorkerToolTrace } from "./worker-verification";

export type SourceAuthority = "primary" | "reputable" | "unclassified";

export interface VerifiedResearchSource {
  url: string;
  hostname: string;
  authority: SourceAuthority;
  publishedAt: string | null;
  retrievedAt: string | null;
}

export interface ResearchEvidenceReport {
  required: boolean;
  passed: boolean;
  blockers: string[];
  sources: VerifiedResearchSource[];
  evidence: string[];
}

const PRIMARY_HOST_PATTERNS = [
  /(?:^|\.)gov(?:\.[a-z]{2})?$/i,
  /(?:^|\.)europa\.eu$/i,
  /(?:^|\.)who\.int$/i,
  /(?:^|\.)un\.org$/i,
  /(?:^|\.)riksdagen\.se$/i,
  /(?:^|\.)regeringen\.se$/i,
  /(?:^|\.)skatteverket\.se$/i,
  /(?:^|\.)svk\.se$/i,
  /(?:^|\.)digg\.se$/i
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function classifySourceAuthority(url: URL): SourceAuthority {
  const hostname = url.hostname.toLowerCase();
  if (PRIMARY_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return "primary";
  if (/^(docs|developer|developers|support|help)\./i.test(hostname)) return "primary";
  if (/\.(edu|ac\.[a-z]{2})$/i.test(hostname)) return "reputable";
  return "unclassified";
}

function searchEvidence(trace: WorkerToolTrace[]) {
  const urls = new Map<string, { publishedAt: string | null }>();
  for (const item of trace) {
    if (item.name !== "web_search") continue;
    const output = record(item.output);
    const results = Array.isArray(output?.results) ? output!.results : [];
    for (const result of results) {
      const resultRecord = record(result);
      const url = validHttpUrl(resultRecord?.url);
      if (!url) continue;
      urls.set(url.href, {
        publishedAt: typeof resultRecord?.publishedAt === "string" ? resultRecord.publishedAt : null
      });
    }
  }
  return urls;
}

function fetchedSources(trace: WorkerToolTrace[], searched: Map<string, { publishedAt: string | null }>): VerifiedResearchSource[] {
  const sources = new Map<string, VerifiedResearchSource>();
  for (const item of trace) {
    if (item.name !== "web_fetch") continue;
    const output = record(item.output);
    const url = validHttpUrl(output?.url);
    if (!url) continue;
    const searchedEntry = searched.get(url.href)
      ?? [...searched.entries()].find(([candidate]) => {
        try { return new URL(candidate).hostname === url.hostname; } catch { return false; }
      })?.[1];
    if (!searchedEntry) continue;
    sources.set(url.hostname, {
      url: url.href,
      hostname: url.hostname,
      authority: classifySourceAuthority(url),
      publishedAt: searchedEntry.publishedAt,
      retrievedAt: typeof output?.retrievedAt === "string" ? output.retrievedAt : null
    });
  }
  return [...sources.values()];
}

export function evaluateResearchEvidence(task: TaskAnalysis, trace: WorkerToolTrace[]): ResearchEvidenceReport {
  if (!task.requiresCurrentInformation) {
    return { required: false, passed: true, blockers: [], sources: [], evidence: ["current-information-not-required"] };
  }

  const currentTimeUsed = trace.some((item) => item.name === "current_time");
  const searched = searchEvidence(trace);
  const sources = fetchedSources(trace, searched);
  const searchUsed = searched.size > 0;
  const fetchUsed = sources.length > 0;
  const blockers: string[] = [];

  // A direct clock/date question can be satisfied by the deterministic current_time
  // tool. Other changing facts require search plus opened source evidence.
  if (task.requiresLiveData && currentTimeUsed && !searchUsed) {
    return {
      required: true,
      passed: true,
      blockers: [],
      sources: [],
      evidence: ["deterministic-current-time"]
    };
  }

  if (!searchUsed) blockers.push("current-information:web-search-required");
  if (!fetchUsed) blockers.push("current-information:opened-source-required");

  const needsCorroboration = task.researchDepth === "deep" || task.risk === "high" || task.risk === "critical";
  if (needsCorroboration && sources.length < 2) blockers.push("current-information:two-source-corroboration-required");
  if (needsCorroboration && sources.length > 0 && !sources.some((source) => source.authority !== "unclassified")) {
    blockers.push("current-information:authoritative-source-required");
  }

  return {
    required: true,
    passed: blockers.length === 0,
    blockers,
    sources,
    evidence: [
      ...(searchUsed ? [`web-search:${searched.size}`] : []),
      ...sources.map((source) => `web-fetch:${source.hostname}:${source.authority}`)
    ]
  };
}
