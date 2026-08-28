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
    expect(String(messages.at(-1)?.content ?? "")).toContain("Independent evidence reviewer feedback:");
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
  it("accepts explicit reviewer JSON", () => {
    expect(parseGroundedEvidenceReview('{"passed":true,"reason":"supported"}')).toEqual({ passed: true, reason: "supported" });
    expect(parseGroundedEvidenceReview('{"passed":false,"reason":"stale source"}')).toEqual({ passed: false, reason: "stale source" });
  });

  it("accepts a single valid reviewer object wrapped by common model formatting", () => {
    expect(parseGroundedEvidenceReview('```json\n{"passed":true,"reason":"official current page supports v26.8.1"}\n```')).toEqual({
      passed: true,
      reason: "official current page supports v26.8.1"
    });
    expect(parseGroundedEvidenceReview('<think>Check the opened Current page.</think>\n{"passed":true,"reason":"supported"}\nDone.')).toEqual({
      passed: true,
      reason: "supported"
    });
  });

  it("extracts balanced JSON without being confused by braces inside the reason string", () => {
    expect(parseGroundedEvidenceReview('review: {"passed":false,"reason":"claim {current} is unsupported"} trailing')).toEqual({
      passed: false,
      reason: "claim {current} is unsupported"
    });
  });

  it("remains fail-closed for malformed or incomplete reviewer output", () => {
    expect(parseGroundedEvidenceReview("not-json")).toEqual({ passed: false, reason: "grounded_reviewer_invalid_json" });
    expect(parseGroundedEvidenceReview('{"passed":true}')).toEqual({ passed: false, reason: "grounded_reviewer_invalid_shape" });
    expect(parseGroundedEvidenceReview('{"reason":"supported"}')).toEqual({ passed: false, reason: "grounded_reviewer_invalid_shape" });
  });
});
