export type LiveEvalOracleKind = "node-current-release";

export type OracleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LiveEvalOracleResult {
  kind: LiveEvalOracleKind;
  expectedValue: string;
  sourceUrl: string;
  checkedAt: string;
}

const NODE_CURRENT_RELEASE_URL = "https://nodejs.org/en/download/current";
const semverPattern = /\bv?(\d+\.\d+\.\d+)\b/gi;

function normalizedVersion(value: string): string {
  return `v${value.replace(/^v/i, "")}`;
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&reg;/gi, "®")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractNodeCurrentRelease(html: string): string | null {
  const text = visibleText(html);
  const candidates = new Set<string>();
  const patterns = [
    /\bv?(\d+\.\d+\.\d+)\s+Latest\s+Release\b/gi,
    /\bLatest\s+Release\s+v?(\d+\.\d+\.\d+)\b/gi,
    /\bGet\s+Node\.js®?\s+v?(\d+\.\d+\.\d+)\s+Current\b/gi,
    /\bv?(\d+\.\d+\.\d+)\s+Current\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) candidates.add(normalizedVersion(match[1]));
    }
  }

  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function observedSemverValues(output: string): string[] {
  const values = new Set<string>();
  for (const match of output.matchAll(semverPattern)) {
    if (match[1]) values.add(normalizedVersion(match[1]));
  }
  return [...values];
}

export function validateLiveOracleOutput(output: string, oracle: LiveEvalOracleResult): string[] {
  const observed = observedSemverValues(output);
  if (observed.length === 0) return [`live_oracle_version_missing:expected=${oracle.expectedValue}`];
  if (observed.length !== 1 || observed[0] !== oracle.expectedValue) {
    return [`live_oracle_version_mismatch:expected=${oracle.expectedValue}:observed=${observed.join(",")}`];
  }
  return [];
}

export function failedLiveOracleCaseIds(results: ReadonlyArray<Record<string, unknown>>): string[] {
  return results.flatMap((result) => {
    if (result.liveOracle == null || result.passed === true || typeof result.id !== "string") return [];
    return [result.id];
  });
}

export async function resolveLiveEvalOracle(
  kind: LiveEvalOracleKind,
  fetchImpl: OracleFetch = fetch
): Promise<LiveEvalOracleResult> {
  if (kind !== "node-current-release") throw new Error(`unsupported_live_eval_oracle:${kind}`);

  const response = await fetchImpl(NODE_CURRENT_RELEASE_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "div3rsa-agent-eval/1.0"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`node_current_oracle_http_${response.status}`);

  const expectedValue = extractNodeCurrentRelease(await response.text());
  if (!expectedValue) throw new Error("node_current_oracle_value_unresolved");

  return {
    kind,
    expectedValue,
    sourceUrl: response.url || NODE_CURRENT_RELEASE_URL,
    checkedAt: new Date().toISOString()
  };
}
