import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import {
  collectRequiredFreshnessEvidence,
  freshnessSearchQueries,
  rankSearchCandidates
} from "./freshness-preflight";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "./processor";

describe("freshnessSearchQueries", () => {
  it("falls back from a verbose research instruction to the intent-bearing sentence and compact query", () => {
    const queries = freshnessSearchQueries("Find the current latest Node.js release from official Node.js information. Search the web, open the relevant source, and report the version you verified and that the information was checked now. Do not rely on model memory.");
    expect(queries[0]).toContain("Search the web");
    expect(queries[1]).toBe("Find the current latest Node.js release from official Node.js information");
    expect(queries[2]).toBe("current latest Node.js release");
  });
});

describe("rankSearchCandidates", () => {
  it("prefers an official current/download index over a stale version-specific release for latest intent", () => {
    const ranked = rankSearchCandidates({
      results: [
        {
          url: "https://nodejs.org/en/blog/release/v24.18.0",
          title: "Node.js 24.18.0",
          snippet: "Version 24.18.0 release notes",
          score: 100,
          publishedAt: "2026-08-27T12:00:00Z"
        },
        {
          url: "https://nodejs.org/en/download/current",
          title: "Download Node.js - Current",
          snippet: "Latest Release",
          score: 10,
          publishedAt: "2026-08-26T12:00:00Z"
        }
      ]
    }, "Find the current latest Node.js release");

    expect(ranked.map((candidate) => candidate.url)).toEqual([
      "https://nodejs.org/en/download/current",
      "https://nodejs.org/en/blog/release/v24.18.0"
    ]);
    expect(ranked[0]?.intentScore).toBeGreaterThan(ranked[1]?.intentScore ?? 0);
  });

  it("prefers the explicit current path over a generic download page that defaults to LTS", () => {
    const ranked = rankSearchCandidates({
      results: [
        {
          url: "https://nodejs.org/en/download",
          title: "Download Node.js",
          snippet: "Get the latest LTS version",
          score: 100,
          publishedAt: "2026-08-27T13:00:00Z"
        },
        {
          url: "https://nodejs.org/en/download/current",
          title: "Download Node.js - Current",
          snippet: "Latest Release",
          score: 1,
          publishedAt: "2026-08-26T13:00:00Z"
        }
      ]
    }, "What is the current latest Node.js release?");

    expect(ranked[0]?.url).toBe("https://nodejs.org/en/download/current");
    expect(ranked[0]?.intentScore).toBe(6);
    expect(ranked[1]?.intentScore).toBe(4);
  });
});

describe("collectRequiredFreshnessEvidence", () => {
  it("retries with a focused query when the first current-information search returns no sources", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        if (execute.mock.calls.filter(([, called]) => called.name === "web_search").length === 1) return { results: [] };
        return {
          results: [{
            url: "https://nodejs.org/en/download/current",
            title: "Download Node.js - Current",
            snippet: "Latest Release",
            score: 10
          }]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "v26.8.1 Latest Release" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-1", requestId: "request-1" } as ClaimedRun;
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

    await collectRequiredFreshnessEvidence({
      task,
      normalizedPrompt: "Find the current latest Node.js release from official Node.js information. Search the web, open the relevant source, and report the version you verified and that the information was checked now. Do not rely on model memory.",
      definitions,
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    expect(execute.mock.calls.map(([, call]) => call.name)).toEqual(["web_search", "web_search", "web_fetch"]);
    expect(String(execute.mock.calls[1]?.[1].input.query)).toBe("Find the current latest Node.js release from official Node.js information");
  });
});
