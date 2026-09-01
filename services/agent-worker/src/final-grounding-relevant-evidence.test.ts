import { describe, expect, it } from "vitest";
import { groundedEvidenceReviewMessages, type GroundingToolTrace } from "./final-grounding";

describe("grounded evidence review selection", () => {
  it("keeps an earlier relevant opened primary source even after many irrelevant web calls", () => {
    const prompt = "Find the current latest Node.js release from official Node.js information and report the verified version.";
    const trace: GroundingToolTrace[] = [
      {
        sequence: 1,
        name: "web_search",
        input: { query: "site:nodejs.org current latest Node.js release" },
        output: { results: [{ url: "https://nodejs.org/en/download/current", title: "Download Node.js - Current", snippet: "Latest Release" }] }
      },
      {
        sequence: 2,
        name: "web_fetch",
        input: { url: "https://nodejs.org/en/download/current" },
        output: {
          url: "https://nodejs.org/en/download/current",
          title: "Node.js — Download Node.js®",
          retrievedAt: "2026-09-01T15:58:28.000Z",
          text: `${"navigation filler ".repeat(700)} Node.js Current Latest Release v26.8.1. Get Node.js v26.8.1 Current.`,
          truncated: false
        }
      },
      ...Array.from({ length: 11 }, (_, index): GroundingToolTrace => ({
        sequence: index + 3,
        name: index % 2 === 0 ? "web_fetch" : "web_search",
        input: index % 2 === 0
          ? { url: `https://irrelevant.example/${index}` }
          : { query: `irrelevant query ${index}` },
        output: index % 2 === 0
          ? { url: `https://irrelevant.example/${index}`, title: "Unrelated page", text: "Completely unrelated content about gardening and weather." }
          : { results: [{ url: `https://irrelevant.example/search/${index}`, title: "Unrelated", snippet: "No runtime information" }] }
      }))
    ];

    const messages = groundedEvidenceReviewMessages({
      originalPrompt: prompt,
      answer: "The current Node.js release is v26.8.1.",
      trace
    });

    const payload = JSON.parse(messages[1]?.content ?? "{}") as { evidence?: unknown[] };
    const serialized = JSON.stringify(payload.evidence ?? []);
    expect(serialized).toContain("https://nodejs.org/en/download/current");
    expect(serialized).toContain("Node.js Current Latest Release v26.8.1");
    expect(serialized.length).toBeLessThan(5_000);
  });
});
