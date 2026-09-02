import { describe, expect, it } from "vitest";
import { processPrompt, withSelectedSkills } from "./prompt-processor";

describe("prompt processor", () => {
  it("normalizes outer whitespace into a machine-readable execution contract without rewriting internal prompt text", () => {
    const contract = processPrompt("code", "  Fix   the login bug in this repository. Must run targeted tests. Do not deploy.  ");
    expect(contract.normalizedPrompt).toBe("Fix   the login bug in this repository. Must run targeted tests. Do not deploy.");
    expect(contract.intent).toBe("bugfix");
    expect(contract.requires.repo).toBe(true);
    expect(contract.requires.tests).toBe(true);
    expect(contract.constraints.join(" ")).toMatch(/Do not deploy/i);
    expect(contract.requirements.join(" ")).toMatch(/Must run targeted tests/i);
    expect(contract.execution.tier).toBe("STANDARD");
    expect(contract.contextBudget).toBe(16_000);
  });

  it("preserves newlines, indentation and fenced code while normalizing line endings", () => {
    const contract = processPrompt(
      "code",
      "\r\nImplement this exactly:\r\n```ts\r\nconst config = {\r\n  nested: true\r\n};\r\n```\r\nDo not deploy.\r\n"
    );

    expect(contract.normalizedPrompt).toBe(
      "Implement this exactly:\n```ts\nconst config = {\n  nested: true\n};\n```\nDo not deploy."
    );
    expect(contract.constraints.join(" ")).toMatch(/Do not deploy/i);
  });

  it("detects freshness independently of the explicit research mode", () => {
    const contract = processPrompt("chat", "Vilka visumregler gäller i Japan just nu?");
    expect(contract.freshness).toBe("current");
    expect(contract.requires.web).toBe(true);
    expect(contract.researchDepth).toBe("standard");
  });

  it("routes direct current date questions to deterministic live time", () => {
    const contract = processPrompt("chat", "What is today's date in Europe/Stockholm right now?");
    expect(contract.freshness).toBe("live");
    expect(contract.analysis.requiresLiveData).toBe(true);
    expect(contract.analysis.liveDataKind).toBe("time");
  });

  it("does not treat a supplied internal policy as current web information", () => {
    const contract = processPrompt("chat", "A service has 8 workers. Each worker can safely process 3 simultaneous requests, but production policy reserves 25% of total capacity for recovery traffic. What is the maximum normal concurrent request count?");
    expect(contract.freshness).toBe("stable");
    expect(contract.requires.web).toBe(false);
    expect(contract.analysis.requiresCurrentInformation).toBe(false);
    expect(contract.analysis.requiresDeployment).toBe(false);
    expect(contract.researchDepth).toBe("none");
  });

  it("does not classify an informational software release question as deployment", () => {
    const contract = processPrompt("research", "Find the current latest Node.js release from official Node.js information.");
    expect(contract.freshness).toBe("current");
    expect(contract.analysis.requiresDeployment).toBe(false);
    expect(contract.risk).toBe("low");
  });

  it("keeps intrinsically changeable domains current even without the word latest", () => {
    const visa = processPrompt("chat", "How do I get a work visa for Japan?");
    const vat = processPrompt("chat", "What is the standard VAT rate in Sweden?");
    expect(visa.freshness).toBe("current");
    expect(visa.requires.web).toBe(true);
    expect(vat.freshness).toBe("current");
    expect(vat.requires.web).toBe(true);
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