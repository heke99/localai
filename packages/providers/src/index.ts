export type WorkerState = "provisioning" | "warming" | "ready" | "draining" | "stopped" | "failed";
export type GpuProfileId = "large_96gb";

export interface GpuProfile { id: GpuProfileId; minimumVramGb: number; preferredArchitecture: string[] }
export const GPU_PROFILES: Record<GpuProfileId, GpuProfile> = {
  large_96gb: { id: "large_96gb", minimumVramGb: 90, preferredArchitecture: ["RTX PRO 6000 Blackwell", "H100", "H200"] }
};

export interface Worker { id: string; provider: string; profile: GpuProfileId; state: WorkerState; modelVersionId?: string }
export interface Capacity { profile: GpuProfileId; available: number; region: string }
export interface WorkerMetrics { utilization: number; vramUsedBytes: number; tokensPerSecond: number; activeGenerations: number }

export interface GpuProvider {
  listCapacity(profile: GpuProfileId): Promise<Capacity[]>;
  getPricing(profile: GpuProfileId, region?: string): Promise<{ currency: "USD"; hourly: number }>;
  provisionWorker(profile: GpuProfileId, modelVersionId: string): Promise<Worker>;
  getWorker(id: string): Promise<Worker>;
  listWorkers(): Promise<Worker[]>;
  startWorker(id: string): Promise<Worker>;
  drainWorker(id: string): Promise<Worker>;
  stopWorker(id: string): Promise<Worker>;
  terminateWorker(id: string): Promise<void>;
  getStatus(id: string): Promise<WorkerState>;
  getMetrics(id: string): Promise<WorkerMetrics>;
}
