import { describe, expect, it } from "vitest";
import {
  groundedEvidenceReviewMessages,
  groundedSynthesisMessages,
  parseGroundedEvidenceReview
} from "./final-grounding";

describe("groundedSynthesisMessages", () => {
  it("tightens synthesis for latest/current requests", () => {
    const messages = groundedSynthesisMessages({
      messages: [],
      draft: "",
      originalPrompt: "Find the current latest Node.js release from official information.",
      attempt: 0
    });
    const instruction = String(messages.at(-1)?.content ?? "");
    expect(instruction).toContain("latest/current request");
    expect(instruction).toContain("Do not substitute LTS for Current");
    expect(instruction).toContain("version-specific release page");
    expect(instruction).toContain("source count is not a vote");
    expect(instruction).toContain("effective or applicability date");
    expect(instruction).toContain("Opened page content is stronger evidence than a search-result snippet");
  });

  it("does not add release-track instructions to stable questions", () => {
    const messages = groundedSynthesisMessages({
      messages: [],
      draft: "",
      originalPrompt: "Explain HTTP 401 and 403.",
      attempt: 0
    });
    expect(String(messages.at(-1)?.content ?? "")).not.toContain("Do not substitute LTS for Current");
  });

  it("returns independent reviewer feedback to the repair synthesis", () => {
    const messages = groundedSynthesisMessages({
      messages: [],
      draft: "The old release is current.",
      originalPrompt: "What is the latest runtime version?",
      attempt: 1,
      reviewerFeedback: "Canonical Current page says v26.8.1; the draft relied on a historical release page."
    });
    expect(String(messages.at(-1)?.content ?? "")).toContain("Independent evidence reviewer feedback to correct");
    expect(String(messages.at(-1)?.content ?? "")).toContain("Canonical Current page says v26.8.1");
  });
});

describe("groundedEvidenceReviewMessages", () => {
  it("reviews authority, scope, dates and opened evidence rather than voting by source count", () => {
    const messages = groundedEvidenceReviewMessages({
      originalPrompt: "What is the current VAT rate?",
      answer: "25%.",
      trace: [
        {
          sequence: 1,
          name: "web_search",
          input: { query: "current VAT" },
          output: { results: [{ url: "https://example.com", snippet: "old summary" }] }
        },
        {
          sequence: 2,
          name: "web_fetch",
          input: { url: "https://www.skatteverket.se/current" },
          output: { url: "https://www.skatteverket.se/current", text: "25 procent", retrievedAt: "2026-08-27T19:00:00Z" }
        }
      ]
    });
    const instruction = String(messages[0]?.content ?? "");
    const payload = String(messages[1]?.content ?? "");
    expect(instruction).toContain("source count is not a vote");
    expect(instruction).toContain("scope/jurisdiction");
    expect(instruction).toContain("effective or applicability date");
    expect(instruction).toContain("search snippets");
    expect(payload).toContain("skatteverket.se");
    expect(payload).toContain("25 procent");
  });
});

describe("parseGroundedEvidenceReview", () => {
  it("accepts only explicit passed=true JSON", () => {
    expect(parseGroundedEvidenceReview('{"passed":true,"reason":"supported"}')).toEqual({ passed: true, reason: "supported" });
    expect(parseGroundedEvidenceReview('{"passed":false,"reason":"stale source"}')).toEqual({ passed: false, reason: "stale source" });
    expect(parseGroundedEvidenceReview("not-json")).toEqual({ passed: false, reason: "grounded_reviewer_invalid_json" });
  });
});
