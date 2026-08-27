import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { collectRequiredFreshnessEvidence } from "./freshness-preflight";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "./processor";

const task = {
  requiresCurrentInformation: true,
  liveDataKind: "web",
  researchDepth: "standard",
  risk: "low"
} as unknown as TaskAnalysis;

const definitions = [
  { name: "web_search" },
  { name: "web_fetch" }
] as unknown as ModelToolDefinition[];

function queue() {
  return { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
}

function run(id: string) {
  return { runId: id, requestId: id } as ClaimedRun;
}

describe("freshness preflight blocked-source resilience", () => {
  it("tries later ranked candidates and continues with one opened strong source when the quality target cannot be fully met", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        return {
          results: [
            { url: "https://www.skatteverket.se/blocked", title: "Official VAT", snippet: "25 procent", score: 100 },
            { url: "https://taxation-customs.ec.europa.eu/vat", title: "EU VAT", snippet: "Sweden 25%", score: 90 },
            { url: "https://www.skatteverket.se/also-blocked", title: "Official VAT detail", snippet: "25 procent", score: 80 }
          ]
        };
      }
      const url = String(call.input.url ?? "");
      if (url.includes("taxation-customs")) return { url, text: "Sweden standard VAT rate 25%", retrievedAt: "2026-08-27T19:00:00Z" };
      throw new Error("web_fetch_failed:403");
    });
    const jobs = queue();
    await expect(collectRequiredFreshnessEvidence({
      task,
      normalizedPrompt: "What is the current standard VAT rate in Sweden?",
      definitions,
      queue: jobs,
      tools: { execute } as unknown as WorkerToolRuntime,
      run: run("partial"),
      messages: [],
      trace: []
    })).resolves.toBeUndefined();

    const fetchUrls = execute.mock.calls
      .map(([, call]) => call)
      .filter((call) => call.name === "web_fetch")
      .map((call) => String(call.input.url));
    expect(fetchUrls).toContain("https://taxation-customs.ec.europa.eu/vat");
    expect(fetchUrls.length).toBeGreaterThan(2);
    expect(jobs.step).toHaveBeenCalledWith(
      "partial",
      "tool",
      "completed",
      "Freshness evidence partially satisfied",
      expect.objectContaining({ openedSources: 1, evidenceQualityTargetMet: false })
    );
  });

  it("remains fail-closed when no candidate can be opened", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        return { results: [
          { url: "https://www.skatteverket.se/a", title: "A", score: 10 },
          { url: "https://www.skatteverket.se/b", title: "B", score: 9 }
        ] };
      }
      throw new Error("web_fetch_failed:403");
    });

    await expect(collectRequiredFreshnessEvidence({
      task,
      normalizedPrompt: "What is the current standard VAT rate in Sweden?",
      definitions,
      queue: queue(),
      tools: { execute } as unknown as WorkerToolRuntime,
      run: run("zero"),
      messages: [],
      trace: []
    })).rejects.toThrow("current_information_source_fetch_failed:0/");
  });
});
