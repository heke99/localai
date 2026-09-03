export type BrowserIsolationMode = "chromium" | "uid-firewall";

export interface BrowserIsolationConfig {
  mode: BrowserIsolationMode;
  chromiumSandbox: boolean;
}

function normalizeLoopbackHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(value: string): boolean {
  const host = normalizeLoopbackHost(value);
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function resolveBrowserIsolationConfig(input: {
  mode?: string;
  uid?: number;
  listenHost: string;
  proxyUrl: string;
}): BrowserIsolationConfig {
  const mode = (input.mode?.trim() || "chromium") as BrowserIsolationMode;
  if (mode !== "chromium" && mode !== "uid-firewall") throw new Error("browser_invalid_isolation_mode");

  if (mode === "chromium") return { mode, chromiumSandbox: true };

  if (!Number.isInteger(input.uid) || input.uid === 0) throw new Error("browser_outer_isolation_requires_non_root");
  if (!isLoopbackHost(input.listenHost)) throw new Error("browser_outer_isolation_requires_loopback_bind");

  let proxy: URL;
  try {
    proxy = new URL(input.proxyUrl);
  } catch {
    throw new Error("browser_outer_isolation_invalid_proxy");
  }
  if (proxy.protocol !== "http:" || !isLoopbackHost(proxy.hostname)) {
    throw new Error("browser_outer_isolation_requires_loopback_proxy");
  }

  return { mode, chromiumSandbox: false };
}
