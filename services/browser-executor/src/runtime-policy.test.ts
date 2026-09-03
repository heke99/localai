import { describe, expect, it } from "vitest";
import { resolveBrowserIsolationConfig } from "./runtime-policy";

describe("browser runtime isolation policy", () => {
  it("keeps Chromium's internal sandbox enabled by default", () => {
    expect(resolveBrowserIsolationConfig({
      listenHost: "127.0.0.1",
      proxyUrl: "http://127.0.0.1:7318",
      uid: 10001
    })).toEqual({ mode: "chromium", chromiumSandbox: true });
  });

  it("allows the GPUHub uid-firewall fallback only for a non-root loopback executor and proxy", () => {
    expect(resolveBrowserIsolationConfig({
      mode: "uid-firewall",
      listenHost: "127.0.0.1",
      proxyUrl: "http://127.0.0.1:7318",
      uid: 10001
    })).toEqual({ mode: "uid-firewall", chromiumSandbox: false });
  });

  it("rejects uid-firewall isolation as root", () => {
    expect(() => resolveBrowserIsolationConfig({
      mode: "uid-firewall",
      listenHost: "127.0.0.1",
      proxyUrl: "http://127.0.0.1:7318",
      uid: 0
    })).toThrow("browser_outer_isolation_requires_non_root");
  });

  it("rejects uid-firewall isolation on a public listener", () => {
    expect(() => resolveBrowserIsolationConfig({
      mode: "uid-firewall",
      listenHost: "0.0.0.0",
      proxyUrl: "http://127.0.0.1:7318",
      uid: 10001
    })).toThrow("browser_outer_isolation_requires_loopback_bind");
  });

  it("rejects uid-firewall isolation through a non-loopback proxy", () => {
    expect(() => resolveBrowserIsolationConfig({
      mode: "uid-firewall",
      listenHost: "127.0.0.1",
      proxyUrl: "http://10.0.0.4:7318",
      uid: 10001
    })).toThrow("browser_outer_isolation_requires_loopback_proxy");
  });

  it("rejects unknown isolation modes", () => {
    expect(() => resolveBrowserIsolationConfig({
      mode: "off",
      listenHost: "127.0.0.1",
      proxyUrl: "http://127.0.0.1:7318",
      uid: 10001
    })).toThrow("browser_invalid_isolation_mode");
  });
});
