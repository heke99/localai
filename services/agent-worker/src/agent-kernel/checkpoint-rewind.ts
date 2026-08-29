import { createHash } from "node:crypto";
import type { KernelCheckpoint, KernelPlan, KernelStepResult, KernelVerificationReport } from "./contracts";
import { AGENT_KERNEL_PROTOCOL_VERSION } from "./contracts";

export interface KernelExternalSnapshot {
  readonly kind: "repository" | "database" | "deployment" | "composite";
  readonly locator: string;
  readonly revision: string;
  readonly digest?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface KernelCheckpointStateRuntime {
  capture(input: { runId: string; label: string }): Promise<readonly KernelExternalSnapshot[]>;
  restore(input: { runId: string; snapshots: readonly KernelExternalSnapshot[] }): Promise<void>;
}

export interface VerifiedKernelCheckpoint extends KernelCheckpoint {
  readonly checkpointId: string;
  readonly label: string;
  readonly snapshots: readonly KernelExternalSnapshot[];
  readonly verification: KernelVerificationReport | null;
  readonly verified: boolean;
}

function checkpointId(runId: string, label: string, createdAt: string, snapshots: readonly KernelExternalSnapshot[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ runId, label, createdAt, snapshots: snapshots.map((snapshot) => [snapshot.kind, snapshot.locator, snapshot.revision, snapshot.digest ?? null]) }))
    .digest("hex");
}

export class KernelCheckpointRewindController {
  private readonly checkpoints = new Map<string, VerifiedKernelCheckpoint[]>();
  private readonly rewindCount = new Map<string, number>();

  constructor(private readonly state: KernelCheckpointStateRuntime, private readonly maxRewindsPerRun = 2) {
    if (!Number.isInteger(maxRewindsPerRun) || maxRewindsPerRun < 1) throw new Error("invalid_kernel_max_rewinds");
  }

  async checkpoint(input: {
    runId: string;
    label: string;
    plan: KernelPlan;
    results: readonly KernelStepResult[];
    verification: KernelVerificationReport | null;
    allowUnverifiedBaseline?: boolean;
  }): Promise<VerifiedKernelCheckpoint> {
    const label = input.label.trim();
    if (!label) throw new Error("kernel_checkpoint_label_required");
    const verified = input.verification?.passed === true || input.allowUnverifiedBaseline === true;
    const snapshots = await this.state.capture({ runId: input.runId, label });
    if (!snapshots.length) throw new Error("kernel_checkpoint_external_snapshot_required");
    const createdAt = new Date().toISOString();
    const checkpoint: VerifiedKernelCheckpoint = {
      protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
      runId: input.runId,
      plan: input.plan,
      results: [...input.results],
      createdAt,
      checkpointId: checkpointId(input.runId, label, createdAt, snapshots),
      label,
      snapshots: [...snapshots],
      verification: input.verification,
      verified
    };
    const list = this.checkpoints.get(input.runId) ?? [];
    list.push(checkpoint);
    this.checkpoints.set(input.runId, list);
    return checkpoint;
  }

  latestVerified(runId: string): VerifiedKernelCheckpoint | null {
    const list = this.checkpoints.get(runId) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.verified) return list[index] ?? null;
    }
    return null;
  }

  async rewind(runId: string, checkpointIdToRestore?: string): Promise<VerifiedKernelCheckpoint> {
    const used = this.rewindCount.get(runId) ?? 0;
    if (used >= this.maxRewindsPerRun) throw new Error("kernel_rewind_budget_exhausted");
    const list = this.checkpoints.get(runId) ?? [];
    const checkpoint = checkpointIdToRestore
      ? list.find((candidate) => candidate.checkpointId === checkpointIdToRestore) ?? null
      : this.latestVerified(runId);
    if (!checkpoint) throw new Error("kernel_verified_checkpoint_not_found");
    if (!checkpoint.verified) throw new Error("kernel_unverified_checkpoint_restore_denied");
    await this.state.restore({ runId, snapshots: checkpoint.snapshots });
    this.rewindCount.set(runId, used + 1);
    return checkpoint;
  }

  release(runId: string): void {
    this.checkpoints.delete(runId);
    this.rewindCount.delete(runId);
  }
}
