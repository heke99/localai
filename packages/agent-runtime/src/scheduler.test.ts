import { describe, expect, it } from "vitest";
import { analyzeTask } from "./task-analyzer";
import { compareQueueCandidates, queueSchedulingFor } from "./scheduler";

describe("agent queue scheduling", () => {
  it("routes short interactive work ahead of deep work by default", () => {
    expect(queueSchedulingFor(analyzeTask("chat", "Förklara en kö kort."))).toMatchObject({ lane: "interactive", basePriority: 10 });
    expect(queueSchedulingFor(analyzeTask("code", "Analyze the entire architecture end-to-end and all affected code"))).toMatchObject({ lane: "deep", basePriority: 90 });
  });

  it("keeps normal code work separate from interactive chat", () => {
    expect(queueSchedulingFor(analyzeTask("code", "Fix login in this repository"))).toMatchObject({ lane: "normal", basePriority: 50 });
  });

  it("penalizes owners already consuming capacity", () => {
    const now = Date.parse("2026-08-27T14:00:00.000Z");
    const idle = { basePriority: 10, createdAt: new Date(now).toISOString(), activeForOwner: 0 };
    const busy = { ...idle, activeForOwner: 2 };
    expect(compareQueueCandidates(idle, busy, now)).toBeLessThan(0);
  });

  it("ages deep work until it can no longer starve behind new interactive requests", () => {
    const now = Date.parse("2026-08-27T14:20:00.000Z");
    const oldDeep = { basePriority: 90, createdAt: "2026-08-27T14:00:00.000Z", activeForOwner: 0 };
    const newInteractive = { basePriority: 10, createdAt: new Date(now).toISOString(), activeForOwner: 0 };
    expect(compareQueueCandidates(oldDeep, newInteractive, now)).toBeLessThanOrEqual(0);
  });
});
