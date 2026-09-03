import type { AgentMode } from "@div3rsa/agent-runtime";

export type ToolRisk = "read" | "active" | "write" | "destructive";
export type ToolScopePolicy = "exact-host" | "explicit-subdomains" | "cidr" | "resource";
export type ToolEvidenceType = "research" | "security" | "repository" | "deployment" | "database" | "none";

export interface ToolPolicy {
  name: string;
  allowedModes: AgentMode[];
  capability: string;
  risk: ToolRisk;
  mutating: boolean;
  destructive: boolean;
  reversible: boolean;
  idempotent: boolean;
  cancellable: boolean;
  timeoutMs: number;
  scopePolicy?: ToolScopePolicy;
  evidenceType: ToolEvidenceType;
  directExposure: boolean;
}

const LAB_READ: AgentMode[] = ["lab"];
const ALL_MODES: AgentMode[] = ["chat", "code", "lab"];

const policies: ToolPolicy[] = [
  { name: "web_search", allowedModes: ALL_MODES, capability: "research.search", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "exact-host", evidenceType: "research", directExposure: true },
  { name: "web_fetch", allowedModes: ALL_MODES, capability: "research.fetch", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "exact-host", evidenceType: "research", directExposure: true },
  { name: "dns_lookup", allowedModes: LAB_READ, capability: "security.recon", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 20_000, scopePolicy: "exact-host", evidenceType: "security", directExposure: true },
  { name: "http_probe", allowedModes: LAB_READ, capability: "security.http", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "exact-host", evidenceType: "security", directExposure: true },
  { name: "tls_probe", allowedModes: LAB_READ, capability: "security.tls", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "exact-host", evidenceType: "security", directExposure: true },
  { name: "port_scan", allowedModes: LAB_READ, capability: "security.active", risk: "active", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 90_000, scopePolicy: "cidr", evidenceType: "security", directExposure: true },
  { name: "security_scan", allowedModes: LAB_READ, capability: "security.active", risk: "active", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 120_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "content_discovery", allowedModes: LAB_READ, capability: "security.active", risk: "active", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 120_000, scopePolicy: "exact-host", evidenceType: "security", directExposure: true },
  { name: "browser_navigate", allowedModes: LAB_READ, capability: "security.browser", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: false, cancellable: true, timeoutMs: 45_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "browser_read", allowedModes: LAB_READ, capability: "security.browser", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "browser_screenshot", allowedModes: LAB_READ, capability: "security.browser", risk: "read", mutating: false, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 30_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "browser_click", allowedModes: LAB_READ, capability: "security.active", risk: "active", mutating: true, destructive: false, reversible: false, idempotent: false, cancellable: true, timeoutMs: 45_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "browser_type", allowedModes: LAB_READ, capability: "security.active", risk: "active", mutating: true, destructive: false, reversible: false, idempotent: false, cancellable: true, timeoutMs: 30_000, scopePolicy: "resource", evidenceType: "security", directExposure: true },
  { name: "github_run_action", allowedModes: ["code", "lab"], capability: "github.actions.write", risk: "write", mutating: true, destructive: false, reversible: false, idempotent: true, cancellable: true, timeoutMs: 90_000, scopePolicy: "resource", evidenceType: "repository", directExposure: true },
  { name: "github_write_file", allowedModes: ["code", "lab"], capability: "github.contents.write", risk: "write", mutating: true, destructive: false, reversible: true, idempotent: true, cancellable: true, timeoutMs: 90_000, scopePolicy: "resource", evidenceType: "repository", directExposure: true },
  { name: "github_delete_file", allowedModes: ["code", "lab"], capability: "github.contents.write", risk: "destructive", mutating: true, destructive: true, reversible: true, idempotent: true, cancellable: true, timeoutMs: 90_000, scopePolicy: "resource", evidenceType: "repository", directExposure: true }
];

const registry = new Map(policies.map((policy) => [policy.name, Object.freeze(policy)]));

export function toolPolicy(name: string): ToolPolicy | undefined {
  return registry.get(name);
}

export function isMutatingTool(name: string): boolean {
  return registry.get(name)?.mutating === true;
}

export function isDirectTool(name: string, mode: AgentMode): boolean {
  const policy = registry.get(name);
  return policy?.directExposure === true && policy.allowedModes.includes(mode);
}

export function toolTimeoutMs(name: string, fallback = 90_000): number {
  return registry.get(name)?.timeoutMs ?? fallback;
}

export function canonicalToolPolicies(): readonly ToolPolicy[] {
  return policies;
}
