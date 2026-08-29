import { describe, expect, it } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { buildSpecialistPlan } from "./specialist-context";

const base = { categories: ["analysis"], risk: "medium", complexity: "moderate", reasoningLevel: "standard", informationFreshness: "stable", researchDepth: "none", requiresCurrentInformation: false, requiresRepository: true, requiresDatabase: false, requiresDeployment: false, requiresSecurityReview: false, verificationRequirements: ["tests"] } as unknown as TaskAnalysis;

describe("buildSpecialistPlan", () => {
  it("keeps planner and verifier, serializes coder, and bounds request context", () => {
    const plan = buildSpecialistPlan({ task: base, prompt: `fix repo ${"x".repeat(20_000)}`, selectedSkills: ["repository-analysis"], maxSubagents: 4, maxPromptChars: 8_000 });
    expect(plan.map((entry) => entry.role)).toEqual(["planner", "verifier", "coder", "tester"]);
    expect(plan.find((entry) => entry.role === "coder")?.execution).toBe("serial");
    expect(String(plan[0]?.context.request).length).toBeLessThanOrEqual(8_000);
    expect(plan.find((entry) => entry.role === "verifier")?.context).not.toHaveProperty("selectedSkills");
  });

  it("adds research and performance specialists only when required", () => {
    const plan = buildSpecialistPlan({ task: { ...base, requiresRepository: false, requiresCurrentInformation: true, researchDepth: "deep", verificationRequirements: [] } as unknown as TaskAnalysis, prompt: "benchmark latest runtime latency", selectedSkills: [], maxSubagents: 6, maxPromptChars: 8_000 });
    expect(plan.map((entry) => entry.role)).toEqual(expect.arrayContaining(["planner", "verifier", "researcher", "performance"]));
  });
});
