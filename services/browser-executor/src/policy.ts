import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface BrowserScope {
  scopeId: string;
  allowHosts: string[];
  allowIpv4Cidrs: string[];
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const ip = ipv4Number(address);
  const base = ipv4Number(network ?? "");
  const prefix = Number(prefixRaw);
  if (ip == null || base == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

function infrastructureBlocked(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || /^fe[89ab]/.test(value) || /^ff/.test(value);
  }
  const host = normalizeHost(address);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host === "metadata.google.internal";
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

function privateIpv6(address: string): boolean {
  return /^f[cd]/i.test(address);
}

function hostAllowed(host: string, scope: BrowserScope): boolean {
  if (isIP(host) === 4) return scope.allowIpv4Cidrs.some((cidr) => ipv4InCidr(host, cidr));
  if (isIP(host) !== 0) return false;
  return scope.allowHosts.map(normalizeHost).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function scopeFingerprint(scope: BrowserScope): string {
  return JSON.stringify({
    scopeId: scope.scopeId,
    allowHosts: [...new Set(scope.allowHosts.map(normalizeHost))].sort(),
    allowIpv4Cidrs: [...new Set(scope.allowIpv4Cidrs)].sort()
  });
}

export async function assertBrowserUrlAllowed(
  rawUrl: string,
  scope: BrowserScope,
  resolver: typeof lookup = lookup
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("browser_invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("browser_protocol_not_allowed");
  if (url.username || url.password) throw new Error("browser_url_userinfo_blocked");
  const host = normalizeHost(url.hostname);
  if (!scope.scopeId || infrastructureBlocked(host)) throw new Error("browser_target_blocked");
  if (!hostAllowed(host, scope)) throw new Error("browser_target_out_of_scope");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port !== 80 && port !== 443) throw new Error("browser_port_not_allowed");

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("browser_target_dns_failed");
  for (const entry of addresses) {
    const address = normalizeHost(entry.address);
    if (infrastructureBlocked(address)) throw new Error("browser_target_blocked");
    if (isIP(address) === 4 && privateIpv4(address) && !scope.allowIpv4Cidrs.some((cidr) => ipv4InCidr(address, cidr))) {
      throw new Error("browser_private_resolution_out_of_scope");
    }
    if (isIP(address) === 6 && privateIpv6(address)) throw new Error("browser_private_resolution_out_of_scope");
  }
  return url;
}
