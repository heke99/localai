import { describe, expect, it } from "vitest";
import { compactToolOutput } from "./tool-output";

describe("compactToolOutput", () => {
  it("keeps structured failure evidence while dropping excessive output", () => {
    const output = compactToolOutput({ status: "failed", command: "npm test", failedTests: ["auth.test.ts:83", "session.test.ts:112"], stdout: "x".repeat(50_000) });
    expect(output).toContain('"status":"failed"');
    expect(output).toContain("auth.test.ts:83");
    expect(output.length).toBeLessThanOrEqual(12_001);
  });

  it("bounds large arrays deterministically", () => {
    const output = compactToolOutput({ results: Array.from({ length: 500 }, (_, i) => ({ id: i, value: `v${i}` })) });
    const parsed = JSON.parse(output) as { results: unknown[]; __truncated?: unknown };
    expect(parsed.results.length).toBeLessThanOrEqual(40);
  });

  it("returns a safe marker for circular results", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(compactToolOutput(value)).toContain("tool_result_cycle");
  });
});
