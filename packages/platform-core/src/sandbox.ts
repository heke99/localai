export type SandboxProfile = "code" | "lab" | "browser";
export interface NetworkPolicy { default: "deny"; allowHosts: string[]; allowCidrs: string[] }
export interface SandboxRequest { runId: string; profile: SandboxProfile; cpuLimit: number; memoryMb: number; ttlSeconds: number; network: NetworkPolicy }

const limits: Record<SandboxProfile, { maxCpu: number; maxMemoryMb: number; maxTtlSeconds: number }> = {
  code: { maxCpu: 8, maxMemoryMb: 16384, maxTtlSeconds: 3600 },
  lab: { maxCpu: 16, maxMemoryMb: 32768, maxTtlSeconds: 3600 },
  browser: { maxCpu: 4, maxMemoryMb: 8192, maxTtlSeconds: 1800 }
};

export function validateSandboxRequest(request: SandboxRequest): void {
  const limit = limits[request.profile];
  if (request.network.default !== "deny") throw new Error("sandbox_default_deny_required");
  if (request.cpuLimit <= 0 || request.cpuLimit > limit.maxCpu) throw new Error("sandbox_cpu_limit_invalid");
  if (request.memoryMb <= 0 || request.memoryMb > limit.maxMemoryMb) throw new Error("sandbox_memory_limit_invalid");
  if (request.ttlSeconds <= 0 || request.ttlSeconds > limit.maxTtlSeconds) throw new Error("sandbox_ttl_invalid");
  if (request.network.allowHosts.some((host) => host === "*" || host === "0.0.0.0")) throw new Error("sandbox_wildcard_egress_forbidden");
}
