export type ProviderHealth = { ok: boolean; detail?: string; latencyMs?: number };

export interface DatabaseProvider {
  readonly key: string;
  health(): Promise<ProviderHealth>;
  query<T = unknown>(statement: string, parameters?: readonly unknown[]): Promise<T[]>;
  execute(statement: string, parameters?: readonly unknown[]): Promise<{ affectedRows?: number }>;
  transaction<T>(work: (database: DatabaseProvider) => Promise<T>): Promise<T>;
}

export interface GitProvider {
  readonly key: string;
  health(): Promise<ProviderHealth>;
  clone(repository: string, destination: string, revision?: string): Promise<void>;
  fetch(repositoryPath: string, revision?: string): Promise<void>;
  checkout(repositoryPath: string, revision: string): Promise<void>;
  diff(repositoryPath: string, baseRevision: string, headRevision: string): Promise<string>;
}

export interface DeploymentProvider {
  readonly key: string;
  health(): Promise<ProviderHealth>;
  deploy(input: { project: string; revision: string; environment: string }): Promise<{ deploymentId: string; url?: string }>;
  status(deploymentId: string): Promise<{ state: "queued" | "building" | "ready" | "failed" | "cancelled"; detail?: string }>;
  logs(deploymentId: string, since?: Date): Promise<string[]>;
  rollback(input: { project: string; deploymentId: string }): Promise<{ deploymentId: string }>;
}

export interface ObjectStorageProvider {
  readonly key: string;
  health(): Promise<ProviderHealth>;
  put(key: string, value: Uint8Array, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number): Promise<string[]>;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorStoreProvider {
  readonly key: string;
  health(): Promise<ProviderHealth>;
  upsert(namespace: string, records: readonly VectorRecord[]): Promise<void>;
  query(namespace: string, vector: readonly number[], limit: number, filter?: Record<string, unknown>): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>>;
  delete(namespace: string, ids: readonly string[]): Promise<void>;
}

export type WorkerState = "provisioning" | "warming" | "ready" | "draining" | "stopped" | "failed";
export type GpuProfileId = "large_96gb";

export interface GpuProfile { id: GpuProfileId; minimumVramGb: number; preferredArchitecture: string[] }
export const GPU_PROFILES: Record<GpuProfileId, GpuProfile> = {
  large_96gb: { id: "large_96gb", minimumVramGb: 90, preferredArchitecture: ["RTX PRO 6000 Blackwell", "H100", "H200"] }
};

export interface Worker { id: string; provider: string; profile: GpuProfileId; state: WorkerState; modelVersionId?: string }
export interface Capacity { profile: GpuProfileId; available: number; region: string }
export interface WorkerMetrics { utilization: number; vramUsedBytes: number; tokensPerSecond: number; activeGenerations: number }

export interface ComputeDeployment {
  id: string;
  profile: string;
  state: WorkerState;
  endpoint?: string;
  modelVersionId?: string;
}

export interface ComputeProvider {
  readonly key: string;
  start(deploymentId: string): Promise<ComputeDeployment>;
  stop(deploymentId: string): Promise<ComputeDeployment>;
  scale(input: { profile: string; desired: number; modelVersionId?: string }): Promise<ComputeDeployment[]>;
  health(deploymentId?: string): Promise<ProviderHealth>;
  endpoint(deploymentId: string): Promise<string>;
  capacity(profile: string): Promise<Array<{ region: string; available: number }>>;
}

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
