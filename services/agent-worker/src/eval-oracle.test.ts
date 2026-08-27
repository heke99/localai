import { describe, expect, it, vi } from "vitest";
import {
  extractNodeCurrentRelease,
  resolveLiveEvalOracle,
  validateLiveOracleOutput,
  type OracleFetch
} from "./eval-oracle";

describe("live eval oracle", () => {
  it("extracts Latest Release without confusing it with Latest LTS", () => {
    const html = `
      <main>
        <span>v24.20.0 Latest LTS</span>
        <span>v26.8.1 Current</span>
        <footer><strong>v24.20.0</strong> Latest LTS <strong>v26.8.1</strong> Latest Release</footer>
      </main>
    `;
    expect(extractNodeCurrentRelease(html)).toBe("v26.8.1");
  });

  it("fails closed when official current markers disagree", () => {
    expect(extractNodeCurrentRelease("v26.8.1 Current v26.9.0 Latest Release")).toBeNull();
  });

  it("requires the answer to contain exactly the oracle semver", () => {
    const oracle = {
      kind: "node-current-release" as const,
      expectedValue: "v26.8.1",
      sourceUrl: "https://nodejs.org/en/download/current",
      checkedAt: "2026-08-27T17:00:00.000Z"
    };
    expect(validateLiveOracleOutput("Latest Release: v26.8.1.", oracle)).toEqual([]);
    expect(validateLiveOracleOutput("Latest Release: v24.18.0.", oracle)[0]).toContain("live_oracle_version_mismatch");
    expect(validateLiveOracleOutput("Current is v26.8.1; LTS is v24.20.0.", oracle)[0]).toContain("live_oracle_version_mismatch");
  });

  it("resolves the oracle only from the official live page", async () => {
    const fetchImpl = vi.fn(async () => new Response("<div>v26.8.1 Current</div>", {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as unknown as OracleFetch;
    const result = await resolveLiveEvalOracle("node-current-release", fetchImpl);
    expect(result.expectedValue).toBe("v26.8.1");
    expect(result.sourceUrl).toBe("https://nodejs.org/en/download/current");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
