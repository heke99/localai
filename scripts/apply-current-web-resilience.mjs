import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`patch_anchor_missing:${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`patch_anchor_not_unique:${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const corePath = "services/agent-worker/src/core-tool-runtime.ts";
let core = readFileSync(corePath, "utf8");

const readableAnchor = `function isReadableContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType === "application/json"
    || contentType === "application/xml"
    || contentType === "application/xhtml+xml";
}

export class CoreToolRuntime implements WorkerToolRuntime {`;

const boundedHelper = `function isReadableContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType === "application/json"
    || contentType === "application/xml"
    || contentType === "application/xhtml+xml";
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel("bounded_web_fetch_limit_reached").catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total === maxBytes) {
        const probe = await reader.read();
        if (!probe.done) {
          truncated = true;
          await reader.cancel("bounded_web_fetch_limit_reached").catch(() => undefined);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export class CoreToolRuntime implements WorkerToolRuntime {`;
core = replaceOnce(core, readableAnchor, boundedHelper, "bounded_body_helper");

const hardFailFetch = `      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxFetchBytes) throw new Error("web_fetch_response_too_large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxFetchBytes) throw new Error("web_fetch_response_too_large");
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);`;
const boundedFetch = `      const declaredLengthHeader = response.headers.get("content-length");
      const declaredLength = declaredLengthHeader == null ? null : Number(declaredLengthHeader);
      const declaredBytes = declaredLength !== null && Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : null;
      const bounded = await readBoundedResponseBody(response, this.maxFetchBytes);
      const bytes = bounded.bytes;
      const truncated = bounded.truncated || (declaredBytes !== null && declaredBytes > bytes.byteLength);
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);`;
core = replaceOnce(core, hardFailFetch, boundedFetch, "bounded_fetch_read");

const fetchResult = `        text: text.slice(0, 120_000),
        bytes: bytes.byteLength,
        retrievedAt: this.now().toISOString()`;
const fetchResultWithMetadata = `        text: text.slice(0, 120_000),
        bytes: bytes.byteLength,
        declaredBytes,
        truncated,
        retrievedAt: this.now().toISOString()`;
core = replaceOnce(core, fetchResult, fetchResultWithMetadata, "bounded_fetch_metadata");
writeFileSync(corePath, core);

const processorPath = "services/agent-worker/src/processor.ts";
let processor = readFileSync(processorPath, "utf8");
processor = replaceOnce(
  processor,
  `import { collectRequiredFreshnessEvidence } from "./freshness-preflight";`,
  `import { collectRequiredFreshnessEvidence, freshnessSearchQueries, rankSearchCandidates } from "./freshness-preflight";`,
  "freshness_imports"
);

const noToolCall = `              if (research.finishReason !== "tool_call" || !research.toolCalls?.length) {
                throw new Error("grounded_evidence_research_retry_no_new_evidence");
              }`;
const deterministicFallback = `              if (research.finishReason !== "tool_call" || !research.toolCalls?.length) {
                const fallbackQueries = [
                  \`${'${contract.normalizedPrompt}'} official current source\`,
                  \`${'${contract.normalizedPrompt} ${groundingReview.reason}'}\`,
                  ...freshnessSearchQueries(contract.normalizedPrompt)
                ]
                  .map((query) => query.replace(/\\s+/g, " ").trim().slice(0, 500))
                  .filter((query, index, all) => query.length >= 4 && all.indexOf(query) === index);
                const fallbackQuery = fallbackQueries[Math.min(researchAttempt, Math.max(0, fallbackQueries.length - 1))]
                  ?? contract.normalizedPrompt.slice(0, 500);
                const searchCall: ModelToolCall = {
                  id: \`${'${run.requestId}'}:grounding-fallback-search:${'${verificationRound}'}:${'${researchAttempt}'}\`,
                  name: "web_search",
                  input: { query: fallbackQuery, limit: 12 }
                };
                loopGuard.record({ action: searchCall.name, inputHash: hashInput(searchCall.input) });
                await this.queue.step(run.runId, "tool", "waiting_for_tool", "web_search", {
                  toolCallId: searchCall.id,
                  verificationRound,
                  researchAttempt,
                  deterministicEvidenceFallback: true
                });
                let searchOutput: unknown;
                try {
                  searchOutput = await this.tools.execute(run, searchCall);
                } catch (error) {
                  await this.queue.step(run.runId, "tool", "blocked", "Deterministic evidence fallback search failed", {
                    verificationRound,
                    researchAttempt,
                    query: fallbackQuery,
                    error: error instanceof Error ? error.message : "web_search_failed"
                  });
                  continue;
                }
                toolTrace.push({ sequence: toolTrace.length + 1, name: searchCall.name, input: searchCall.input, output: searchOutput });
                messages.push({ role: "assistant", content: "", toolCalls: [searchCall] });
                messages.push({ role: "tool", name: searchCall.name, toolCallId: searchCall.id, content: compactToolOutput(searchOutput) });

                const openedUrls = new Set(toolTrace
                  .filter((item) => item.name === "web_fetch" && typeof item.input.url === "string")
                  .map((item) => String(item.input.url)));
                const candidate = rankSearchCandidates(searchOutput, contract.normalizedPrompt)
                  .find((item) => !openedUrls.has(item.url));
                if (!candidate) {
                  await this.queue.step(run.runId, "tool", "blocked", "Deterministic evidence fallback found no new source", {
                    verificationRound,
                    researchAttempt,
                    query: fallbackQuery
                  });
                  continue;
                }

                const fetchCall: ModelToolCall = {
                  id: \`${'${run.requestId}'}:grounding-fallback-fetch:${'${verificationRound}'}:${'${researchAttempt}'}\`,
                  name: "web_fetch",
                  input: { url: candidate.url }
                };
                loopGuard.record({ action: fetchCall.name, inputHash: hashInput(fetchCall.input) });
                await this.queue.step(run.runId, "tool", "waiting_for_tool", "web_fetch", {
                  toolCallId: fetchCall.id,
                  verificationRound,
                  researchAttempt,
                  url: candidate.url,
                  deterministicEvidenceFallback: true
                });
                try {
                  const output = await this.tools.execute(run, fetchCall);
                  toolTrace.push({ sequence: toolTrace.length + 1, name: fetchCall.name, input: fetchCall.input, output });
                  messages.push({ role: "assistant", content: "", toolCalls: [fetchCall] });
                  messages.push({ role: "tool", name: fetchCall.name, toolCallId: fetchCall.id, content: compactToolOutput(output) });
                  openedNewSource = true;
                } catch (error) {
                  await this.queue.step(run.runId, "tool", "blocked", "Deterministic evidence fallback source fetch failed", {
                    verificationRound,
                    researchAttempt,
                    url: candidate.url,
                    error: error instanceof Error ? error.message : "web_fetch_failed"
                  });
                }
                continue;
              }`;
processor = replaceOnce(processor, noToolCall, deterministicFallback, "deterministic_evidence_fallback");
writeFileSync(processorPath, processor);

console.log("Applied current-web resilience production patch.");
