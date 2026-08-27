import { describe, expect, it } from "vitest";
import type { ClaimedRun } from "./processor";
import { requiresRepositorySnapshot } from "./repository-runtime";

function run(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    jobId: "job",
    runId: "run",
    mode: "chat",
    modelAlias: "general-prod",
    prompt: "Vad är klockan just nu i Stockholm?",
    requestId: "request",
    traceId: "trace",
    resourceContext: [],
    ...overrides
  };
}

describe("repository snapshot routing", () => {
  it("skips repository snapshots for ordinary current-information chat", () => {
    expect(requiresRepositorySnapshot(run())).toBe(false);
    expect(requiresRepositorySnapshot(run({ prompt: "Vad är senaste stabila versionen av Node.js just nu?" }))).toBe(false);
  });

  it("keeps repository snapshots for code and lab modes", () => {
    expect(requiresRepositorySnapshot(run({ mode: "code", prompt: "förklara detta" }))).toBe(true);
    expect(requiresRepositorySnapshot(run({ mode: "lab", prompt: "analysera målet" }))).toBe(true);
  });

  it("keeps repository snapshots for explicit repository work in chat", () => {
    expect(requiresRepositorySnapshot(run({ prompt: "Läs repot och fixa buggen i API endpointen" }))).toBe(true);
  });

  it("always re-indexes an explicit post-change ref", () => {
    expect(requiresRepositorySnapshot(run(), "refs/heads/fix/current-info")).toBe(true);
  });
});
