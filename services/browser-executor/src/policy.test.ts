import { describe, expect, it } from "vitest";
import { assertBrowserUrlAllowed, scopeFingerprint } from "./policy";

const scope = {
  scopeId: "scope-1",
  allowHosts: ["example.test"],
  allowIpv4Cidrs: []
};

describe("browser scope policy", () => {
  it("allows the exact authorized host and its subdomains when DNS is public", async () => {
    const resolver = (async () => [{ address: "1.1.1.1", family: 4 as const }]) as typeof import("node:dns/promises").lookup;
    await expect(assertBrowserUrlAllowed("https://example.test/path", scope, resolver)).resolves.toBeInstanceOf(URL);
    await expect(assertBrowserUrlAllowed("https://app.example.test/path", scope, resolver)).resolves.toBeInstanceOf(URL);
  });

  it("blocks a host outside the attached scope before navigation", async () => {
    const resolver = (async () => [{ address: "1.1.1.1", family: 4 as const }]) as typeof import("node:dns/promises").lookup;
    await expect(assertBrowserUrlAllowed("https://outside.test", scope, resolver)).rejects.toThrow("browser_target_out_of_scope");
  });

  it("blocks metadata, loopback and private DNS rebinding unless the private CIDR is explicit", async () => {
    const privateResolver = (async () => [{ address: "10.10.2.3", family: 4 as const }]) as typeof import("node:dns/promises").lookup;
    await expect(assertBrowserUrlAllowed("https://example.test", scope, privateResolver)).rejects.toThrow("browser_private_resolution_out_of_scope");
    await expect(assertBrowserUrlAllowed("http://127.0.0.1", { ...scope, allowIpv4Cidrs: ["127.0.0.0/8"] }, privateResolver)).rejects.toThrow("browser_target_blocked");
    await expect(assertBrowserUrlAllowed("http://169.254.169.254", { ...scope, allowIpv4Cidrs: ["169.254.0.0/16"] }, privateResolver)).rejects.toThrow("browser_target_blocked");
  });

  it("allows an explicitly scoped RFC1918 target at the browser policy layer", async () => {
    const privateResolver = (async () => [{ address: "10.10.2.3", family: 4 as const }]) as typeof import("node:dns/promises").lookup;
    await expect(assertBrowserUrlAllowed("https://internal.example.test", {
      scopeId: "scope-private",
      allowHosts: ["internal.example.test"],
      allowIpv4Cidrs: ["10.10.0.0/16"]
    }, privateResolver)).resolves.toBeInstanceOf(URL);
  });

  it("fingerprints scope deterministically", () => {
    expect(scopeFingerprint({ scopeId: "s", allowHosts: ["B.test", "a.test"], allowIpv4Cidrs: ["10.0.0.0/8"] }))
      .toBe(scopeFingerprint({ scopeId: "s", allowHosts: ["a.test", "b.test"], allowIpv4Cidrs: ["10.0.0.0/8"] }));
  });
});
