import { readFileSync, writeFileSync } from "node:fs";

const path = "services/agent-worker/src/processor.ts";
let source = readFileSync(path, "utf8");

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: anchor is not unique`);
  source = source.replace(before, after);
}

replaceOnce(
  "attempt-state-declaration",
  `            const evidenceStart = toolTrace.length;\n            let repairUsage = finalResult.usage;`,
  `            const evidenceStart = toolTrace.length;\n            const attemptedFallbackUrls = new Set<string>();\n            let repairUsage = finalResult.usage;`
);

replaceOnce(
  "candidate-filter",
  `                const candidate = rankSearchCandidates(searchOutput, contract.normalizedPrompt)\n                  .find((item) => !openedUrls.has(item.url));`,
  `                const candidate = rankSearchCandidates(searchOutput, contract.normalizedPrompt)\n                  .find((item) => !openedUrls.has(item.url) && !attemptedFallbackUrls.has(item.url));`
);

replaceOnce(
  "mark-attempt-before-fetch",
  `                const fetchCall: ModelToolCall = {\n                  id: \`${"${run.requestId}"}:grounding-fallback-fetch:${"${verificationRound}"}:${"${researchAttempt}"}\`,`,
  `                attemptedFallbackUrls.add(candidate.url);\n\n                const fetchCall: ModelToolCall = {\n                  id: \`${"${run.requestId}"}:grounding-fallback-fetch:${"${verificationRound}"}:${"${researchAttempt}"}\`,`
);

writeFileSync(path, source);
console.log("Applied deterministic evidence fallback attempt-state patch.");
