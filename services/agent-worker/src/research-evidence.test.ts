import { describe, expect, it } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { evaluateResearchEvidence } from "./research-evidence";
import type { WorkerToolTrace } from "./worker-verification";

function task(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    primaryCategory: "research",
    categories: ["research"],
    risk: "low",
    complexity: "small",
    reasoningLevel: "standard",
    informationFreshness: "current",
    researchDepth: "standard",
    requiresCurrentInformation: true,
    requiresLiveData: false,
    affectedDomains: ["research"],
    requiresRepository: false,
    requiresBrowser: false,
    requiresDatabase: false,
    requiresDeployment: false,
    requiresSecurityReview: false,
    verificationRequirements: ["diff-review", "completion-proof"],
    project: {},
    ...overrides
  };
}

function trace(items: Array<Partial<WorkerToolTrace> & Pick<WorkerToolTrace, "name" | "output">>): WorkerToolTrace[] {
  return items.map((item, index) => ({ sequence: index + 1, input: {}, ...item })) as WorkerToolTrace[];
}

describe("current-information evidence gate", () => {
  it("does not require web evidence for stable information", () => {
    expect(evaluateResearchEvidence(task({ requiresCurrentInformation: false, informationFreshness: "stable", researchDepth: "none" }), [])).toMatchObject({ required: false, passed: true });
  });

  it("accepts deterministic current_time for a direct live clock request", () => {
    const report = evaluateResearchEvidence(task({ requiresLiveData: true, informationFreshness: "live", researchDepth: "fast" }), trace([
      { name: "current_time", output: { timezone: "Europe/Stockholm", localTime: "12:00:00" } }
    ]));
    expect(report).toMatchObject({ required: true, passed: true, blockers: [] });
    expect(report.evidence).toContain("deterministic-current-time");
  });

  it("requires search plus an opened source for changing facts", () => {
    const searchedOnly = evaluateResearchEvidence(task(), trace([
      { name: "web_search", output: { results: [{ url: "https://example.com/current", title: "Current" }] } }
    ]));
    expect(searchedOnly.passed).toBe(false);
    expect(searchedOnly.blockers).toContain("current-information:opened-source-required");

    const verified = evaluateResearchEvidence(task(), trace([
      { name: "web_search", output: { results: [{ url: "https://example.com/current", title: "Current" }] } },
      { name: "web_fetch", output: { url: "https://example.com/current", retrievedAt: "2026-08-27T10:00:00Z", text: "evidence" } }
    ]));
    expect(verified).toMatchObject({ passed: true });
    expect(verified.sources).toHaveLength(1);
  });

  it("requires corroboration and an authoritative source for high-risk current facts", () => {
    const report = evaluateResearchEvidence(task({ risk: "high", researchDepth: "deep" }), trace([
      { name: "web_search", output: { results: [
        { url: "https://www.skatteverket.se/rule", title: "Rule" },
        { url: "https://example.com/explainer", title: "Explainer" }
      ] } },
      { name: "web_fetch", output: { url: "https://www.skatteverket.se/rule", retrievedAt: "2026-08-27T10:00:00Z", text: "primary" } },
      { name: "web_fetch", output: { url: "https://example.com/explainer", retrievedAt: "2026-08-27T10:01:00Z", text: "secondary" } }
    ]));
    expect(report.passed).toBe(true);
    expect(report.sources.map((source) => source.authority)).toContain("primary");
  });
});
