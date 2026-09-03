import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedEgressTarget {
  host: string;
  address: string;
  family: 4 | 6;
  port: number;
}

export type EgressDnsResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

const defaultResolver: EgressDnsResolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

export function normalizeEgressHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

export function isBlockedEgressHostname(host: string): boolean {
  const normalized = normalizeEgressHost(host);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized === "metadata.google.internal";
}

export function isBlockedEgressAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) {
    const [a, b] = v4;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }

  if (isIP(address) === 6) {
    const value = normalizeEgressHost(address);
    if (value === "::" || value === "::1") return true;
    if (/^f[cd]/i.test(value) || /^fe[89ab]/i.test(value) || /^ff/i.test(value)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)?.[1];
    return mapped ? isBlockedEgressAddress(mapped) : false;
  }

  return true;
}

export function assertEgressPort(port: number): void {
  if (!Number.isInteger(port) || (port !== 80 && port !== 443)) throw new Error("egress_port_not_allowed");
}

export async function resolvePublicEgressTarget(
  hostInput: string,
  port: number,
  resolver: EgressDnsResolver = defaultResolver
): Promise<ResolvedEgressTarget> {
  assertEgressPort(port);
  const host = normalizeEgressHost(hostInput);
  if (!host || isBlockedEgressHostname(host)) throw new Error("egress_host_blocked");

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await resolver(host);
  if (!addresses.length) throw new Error("egress_dns_failed");
  for (const entry of addresses) {
    if (isBlockedEgressAddress(entry.address)) throw new Error("egress_address_blocked");
  }
  const ordered = [...addresses].sort((left, right) => right.family - left.family || left.address.localeCompare(right.address));
  const selected = ordered[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new Error("egress_dns_failed");
  return { host, address: selected.address, family: selected.family, port };
}
