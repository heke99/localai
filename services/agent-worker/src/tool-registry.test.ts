import { describe, expect, it } from "vitest";
import { canonicalToolPolicies, isDirectTool, isMutatingTool } from "./tool-registry";

describe("canonical tool registry", () => {
  it("has unique names and valid lifecycle policy", () => {
    const policies = canonicalToolPolicies();
    expect(new Set(policies.map((policy) => policy.name)).size).toBe(policies.length);
    for (const policy of policies) {
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(policy.allowedModes.length).toBeGreaterThan(0);
      if (policy.destructive) expect(policy.mutating).toBe(true);
      if (policy.risk === "write" || policy.risk === "destructive") expect(policy.mutating).toBe(true);
    }
  });

  it("forces fundamental Lab tools into direct exposure", () => {
    for (const name of ["dns_lookup", "http_probe", "tls_probe", "port_scan", "security_scan", "content_discovery"]) {
      expect(isDirectTool(name, "lab")).toBe(true);
    }
  });

  it("classifies github_run_action as mutating without regex inference", () => {
    expect(isMutatingTool("github_run_action")).toBe(true);
  });
});
