import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import {
  collectRequiredFreshnessEvidence,
  freshnessSearchQueries,
  rankSearchCandidates
} from "./freshness-preflight";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "./processor";

function webTask(): TaskAnalysis {
  return {
    requiresCurrentInformation: true,
    liveDataKind: "web",
    researchDepth: "standard",
    risk: "low"
  } as unknown as TaskAnalysis;
}

function webDefinitions(): ModelToolDefinition[] {
  return [
    { name: "web_search" },
    { name: "web_fetch" }
  ] as unknown as ModelToolDefinition[];
}

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
  it("collects all fallback searches for latest releases before choosing sources", async () => {
    const prompt = "Find the current latest Node.js release from official Node.js information. Search the web, open the relevant source, and report the version you verified and that the information was checked now. Do not rely on model memory.";
    const queries = freshnessSearchQueries(prompt);
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        const query = String(call.input.query ?? "");
        if (query === queries[0]) {
          return {
            results: [{
              url: "https://nodejs.org/en/blog/release/v25.8.0",
              title: "Node.js 25.8.0",
              snippet: "Version 25.8.0 release notes",
              score: 100
            }]
          };
        }
        if (query === queries[1]) return { results: [] };
        return {
          results: [{
            url: "https://nodejs.org/en/download/current",
            title: "Download Node.js - Current",
            snippet: "Latest Release v26.8.1",
            score: 10
          }]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "verified source" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-latest", requestId: "request-latest" } as ClaimedRun;

    await collectRequiredFreshnessEvidence({
      task: webTask(),
      normalizedPrompt: prompt,
      definitions: webDefinitions(),
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    const calls = execute.mock.calls.map(([, call]) => call);
    expect(calls.map((call) => call.name)).toEqual([
      "web_search",
      "web_search",
      "web_search",
      "web_fetch",
      "web_fetch"
    ]);
    expect(calls.filter((call) => call.name === "web_search").map((call) => String(call.input.query))).toEqual(queries);
    expect(String(calls[3]?.input.url)).toBe("https://nodejs.org/en/download/current");
    expect(String(calls[4]?.input.url)).toBe("https://nodejs.org/en/blog/release/v25.8.0");
  });

  it("allows corroborating latest-release pages from the same authoritative hostname", async () => {
    const prompt = "What is the latest Acme runtime version release?";
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        return {
          results: [
            {
              url: "https://docs.example.com/releases/current",
              title: "Current release",
              snippet: "Latest release 8.2.1",
              score: 10
            },
            {
              url: "https://docs.example.com/releases",
              title: "Release index",
              snippet: "Versions and releases",
              score: 9
            }
          ]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "release evidence" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-same-host", requestId: "request-same-host" } as ClaimedRun;

    await collectRequiredFreshnessEvidence({
      task: webTask(),
      normalizedPrompt: prompt,
      definitions: webDefinitions(),
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    const fetchUrls = execute.mock.calls
      .map(([, call]) => call)
      .filter((call) => call.name === "web_fetch")
      .map((call) => String(call.input.url));
    expect(fetchUrls).toEqual([
      "https://docs.example.com/releases/current",
      "https://docs.example.com/releases"
    ]);
  });

  it("uses multiple sources from one search for ordinary current-state research", async () => {
    const prompt = "What is the current standard VAT rate in Sweden? Use official sources.";
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        return {
          results: [
            {
              url: "https://www.skatteverket.se/foretag/moms/momssatser.html",
              title: "Momssatser och undantag från moms",
              snippet: "25 procent",
              score: 100
            },
            {
              url: "https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en",
              title: "VAT rates",
              snippet: "Sweden standard VAT rate 25%",
              score: 80
            }
          ]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "25 percent" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-vat-multi", requestId: "request-vat-multi" } as ClaimedRun;

    await collectRequiredFreshnessEvidence({
      task: webTask(),
      normalizedPrompt: prompt,
      definitions: webDefinitions(),
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    const calls = execute.mock.calls.map(([, call]) => call);
    expect(calls.map((call) => call.name)).toEqual(["web_search", "web_fetch", "web_fetch"]);
    expect(calls.filter((call) => call.name === "web_fetch").map((call) => String(call.input.url))).toEqual([
      "https://www.skatteverket.se/foretag/moms/momssatser.html",
      "https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en"
    ]);
  });

  it("uses a focused fallback search only when the first search has too little evidence", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        const searchNumber = execute.mock.calls.filter(([, called]) => called.name === "web_search").length;
        if (searchNumber === 1) {
          return {
            results: [{
              url: "https://www.skatteverket.se/foretag/moms/momssatser.html",
              title: "Momssatser och undantag från moms",
              snippet: "25 procent",
              score: 100
            }]
          };
        }
        return {
          results: [{
            url: "https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en",
            title: "VAT rates",
            snippet: "Sweden standard VAT rate 25%",
            score: 80
          }]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "25 percent" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-retry", requestId: "request-retry" } as ClaimedRun;

    await collectRequiredFreshnessEvidence({
      task: webTask(),
      normalizedPrompt: "Find the current standard VAT rate in Sweden from official information. Search the web and verify it now.",
      definitions: webDefinitions(),
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    expect(execute.mock.calls.map(([, call]) => call.name)).toEqual([
      "web_search",
      "web_search",
      "web_fetch",
      "web_fetch"
    ]);
  });

  it("still proceeds when only one distinct source exists after all fallback searches", async () => {
    const execute = vi.fn(async (_run: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        return {
          results: [{
            url: "https://www.skatteverket.se/foretag/moms/momssatser.html",
            title: "Momssatser och undantag från moms",
            snippet: "25 procent",
            score: 100
          }]
        };
      }
      if (call.name === "web_fetch") return { url: call.input.url, status: 200, text: "25 percent" };
      throw new Error(`unexpected tool:${call.name}`);
    });
    const queue = { step: vi.fn(async () => undefined) } as unknown as AgentQueue;
    const tools = { execute } as unknown as WorkerToolRuntime;
    const run = { runId: "run-single", requestId: "request-single" } as ClaimedRun;

    await collectRequiredFreshnessEvidence({
      task: webTask(),
      normalizedPrompt: "What is the current standard VAT rate in Sweden?",
      definitions: webDefinitions(),
      queue,
      tools,
      run,
      messages: [],
      trace: []
    });

    const calls = execute.mock.calls.map(([, call]) => call);
    expect(calls.filter((call) => call.name === "web_search").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.name === "web_fetch").map((call) => String(call.input.url))).toEqual([
      "https://www.skatteverket.se/foretag/moms/momssatser.html"
    ]);
  });
});
