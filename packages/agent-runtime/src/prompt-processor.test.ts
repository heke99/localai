import { describe, expect, it } from "vitest";
import { processPrompt, withSelectedSkills } from "./prompt-processor";

describe("prompt processor", () => {
  it("normalizes free text into a machine-readable execution contract", () => {
    const contract = processPrompt("code", "  Fix   the login bug in this repository. Must run targeted tests. Do not deploy.  ");
    expect(contract.normalizedPrompt).toBe("Fix the login bug in this repository. Must run targeted tests. Do not deploy.");
    expect(contract.intent).toBe("bugfix");
    expect(contract.requires.repo).toBe(true);
    expect(contract.requires.tests).toBe(true);
    expect(contract.constraints.join(" ")).toMatch(/Do not deploy/i);
    expect(contract.requirements.join(" ")).toMatch(/Must run targeted tests/i);
    expect(contract.execution.tier).toBe("STANDARD");
    expect(contract.contextBudget).toBe(16_000);
  });

  it("detects freshness independently of the explicit research mode", () => {
    const contract = processPrompt("chat", "Vilka visumregler gäller i Japan just nu?");
    expect(contract.freshness).toBe("current");
    expect(contract.requires.web).toBe(true);
    expect(contract.researchDepth).toBe("standard");
  });

  it("marks production database deployment work critical and mutation-sensitive", () => {
    const contract = processPrompt("code", "Update the production database RLS policy and deploy the migration");
    expect(contract.risk).toBe("critical");
    expect(contract.requires.database).toBe(true);
    expect(contract.requires.deployment).toBe(true);
    expect(contract.requires.mutation).toBe(true);
    expect(contract.execution.tier).toBe("CRITICAL");
  });

  it("enriches the contract with only the skills selected by the next routing layer", () => {
    const contract = withSelectedSkills(processPrompt("chat", "Explain a queue"), ["using-skills", "reasoning-router"]);
    expect(contract.skills).toEqual(["using-skills", "reasoning-router"]);
  });

  it("surfaces obvious contradictory execution constraints instead of silently guessing", () => {
    const contract = processPrompt("code", "Deploy this change to production but do not deploy anything");
    expect(contract.contradictions.detected).toBe(true);
    expect(contract.contradictions.reasons).toContain("deploy_and_do_not_deploy");
  });
});
