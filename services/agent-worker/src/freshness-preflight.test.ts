import { describe, expect, it } from "vitest";
import { rankSearchCandidates } from "./freshness-preflight";

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
});
