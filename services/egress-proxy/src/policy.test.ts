import { describe, expect, it } from "vitest";
import { isBlockedEgressAddress, isBlockedEgressHostname, resolvePublicEgressTarget } from "./policy";

describe("egress proxy policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1"
  ])("blocks non-public address %s", (address) => {
    expect(isBlockedEgressAddress(address)).toBe(true);
  });

  it("allows representative public addresses", () => {
    expect(isBlockedEgressAddress("1.1.1.1")).toBe(false);
    expect(isBlockedEgressAddress("2606:4700:4700::1111")).toBe(false);
  });

  it.each(["localhost", "api.localhost", "host.local", "service.internal", "metadata.google.internal"])("blocks infrastructure hostname %s", (host) => {
    expect(isBlockedEgressHostname(host)).toBe(true);
  });

  it("fails closed if any DNS answer resolves to a blocked address", async () => {
    const resolver = (async () => [
      { address: "1.1.1.1", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const }
    ]) as typeof import("node:dns/promises").lookup;

    await expect(resolvePublicEgressTarget("example.test", 443, resolver)).rejects.toThrow("egress_address_blocked");
  });

  it("pins a public DNS answer and only allows web ports", async () => {
    const resolver = (async () => [{ address: "1.1.1.1", family: 4 as const }]) as typeof import("node:dns/promises").lookup;
    await expect(resolvePublicEgressTarget("example.test", 443, resolver)).resolves.toEqual({
      host: "example.test",
      address: "1.1.1.1",
      family: 4,
      port: 443
    });
    await expect(resolvePublicEgressTarget("example.test", 22, resolver)).rejects.toThrow("egress_port_not_allowed");
  });
});
