import type { AgentRunRecord, Checkpoint, RunRepository } from "./contracts";

export class InMemoryRunRepository implements RunRepository {
  readonly records = new Map<string, AgentRunRecord>();
  readonly checkpoints: Checkpoint[] = [];
  readonly cancelled = new Set<string>();
  async create(record: AgentRunRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
  async update(record: AgentRunRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
  async checkpoint(checkpoint: Checkpoint): Promise<void> { this.checkpoints.push(structuredClone(checkpoint)); }
  async isCancellationRequested(runId: string): Promise<boolean> { return this.cancelled.has(runId); }
}
