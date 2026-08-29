import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "../processor";
import type { PreparedRepositoryWorkspace, WorkerRepositoryRuntime } from "../repository-runtime";

type RollbackOperation = { kind: string; execute: () => Promise<void> };
type RunState = { operations: RollbackOperation[]; rewinds: number; rewinding: boolean };

const unsafeWithoutGenericRollback = new Set([
  "github_create_branch",
  "github_create_pull_request",
  "github_merge_pull_request",
  "github_run_action",
  "supabase_write_database",
  "supabase_apply_migration",
  "supabase_deploy_function"
]);

function deploymentId(value: unknown): string | null {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? ((value as Record<string, unknown>).deployments as unknown[] | undefined) ?? ((value as Record<string, unknown>).result as unknown[] | undefined) ?? []
      : [];
  for (const item of candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.uid === "string" ? record.uid : typeof record.id === "string" ? record.id : "";
    if (id) return id;
  }
  return null;
}

function repositoryFile(workspace: PreparedRepositoryWorkspace, path: string) {
  const normalized = path.replace(/^\.\//, "");
  return workspace.index.files.find((file) => file.path === normalized) ?? null;
}

/**
 * Coordinates externally reversible mutations. It never attempts to invent a
 * rollback for a resource type that cannot be restored deterministically.
 */
export class AgentKernelRewindCoordinator {
  private readonly states = new Map<string, RunState>();

  constructor(
    private readonly repositories: WorkerRepositoryRuntime,
    private readonly tools: WorkerToolRuntime,
    private readonly maxRewindsPerRun = 2
  ) {}

  private state(runId: string) {
    let state = this.states.get(runId);
    if (!state) {
      state = { operations: [], rewinds: 0, rewinding: false };
      this.states.set(runId, state);
    }
    return state;
  }

  async checkpointMutation(run: ClaimedRun, call: ModelToolCall): Promise<void> {
    const state = this.state(run.runId);
    if (state.rewinding) return;

    if (call.name === "github_write_file") {
      const branch = typeof call.input.branch === "string" ? call.input.branch.trim() : "";
      const path = typeof call.input.path === "string" ? call.input.path.trim() : "";
      const resourceId = typeof call.input.resourceId === "string" ? call.input.resourceId : "";
      if (!branch || !path || !resourceId) throw new Error("kernel_rewind_github_write_snapshot_input_invalid");
      const workspace = await this.repositories.prepare(run, branch);
      if (!workspace) throw new Error("kernel_rewind_repository_snapshot_unavailable");
      try {
        const original = repositoryFile(workspace, path);
        if (!original) {
          // Deleting a newly-created path is not yet an allowed internal tool;
          // deny the mutation rather than pretending an empty file is a rewind.
          throw new Error("kernel_rewind_new_file_requires_delete_primitive");
        }
        const originalContent = original.content;
        state.operations.push({
          kind: "github_file",
          execute: async () => {
            await this.tools.execute(run, {
              id: `${call.id}:rewind`,
              name: "github_write_file",
              input: {
                resourceId,
                path,
                branch,
                content: originalContent,
                message: `Restore verified checkpoint for ${run.runId}`
              }
            });
          }
        });
      } finally {
        await this.repositories.release(workspace).catch(() => undefined);
      }
      return;
    }

    if (call.name === "vercel_create_deployment") {
      const resourceId = typeof call.input.resourceId === "string" ? call.input.resourceId : "";
      if (!resourceId) throw new Error("kernel_rewind_vercel_resource_required");
      const current = await this.tools.execute(run, { id: `${call.id}:checkpoint`, name: "vercel_read_deployments", input: { resourceId } });
      const previousDeploymentId = deploymentId(current);
      if (!previousDeploymentId) throw new Error("kernel_rewind_vercel_checkpoint_unavailable");
      state.operations.push({
        kind: "vercel_deployment",
        execute: async () => {
          await this.tools.execute(run, { id: `${call.id}:rewind`, name: "vercel_rollback_deployment", input: { resourceId, deploymentId: previousDeploymentId } });
        }
      });
      return;
    }

    if (unsafeWithoutGenericRollback.has(call.name)) {
      throw new Error(`kernel_rewind_unsupported_mutation:${call.name}`);
    }
  }

  async rewind(runId: string): Promise<boolean> {
    const state = this.states.get(runId);
    if (!state || state.operations.length === 0) return false;
    if (state.rewinds >= this.maxRewindsPerRun) throw new Error("kernel_rewind_budget_exhausted");
    if (state.rewinding) return false;
    state.rewinding = true;
    try {
      for (const operation of [...state.operations].reverse()) await operation.execute();
      state.operations = [];
      state.rewinds += 1;
      return true;
    } finally {
      state.rewinding = false;
    }
  }

  complete(runId: string) { this.states.delete(runId); }
}

export class RewindAwareToolRuntime implements WorkerToolRuntime {
  constructor(private readonly base: WorkerToolRuntime, private readonly coordinator: AgentKernelRewindCoordinator, private readonly enabled: boolean) {}
  list(run: ClaimedRun): Promise<ModelToolDefinition[]> { return this.base.list(run); }
  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (this.enabled) await this.coordinator.checkpointMutation(run, call);
    return this.base.execute(run, call);
  }
}

export class RewindAwareAgentQueue implements AgentQueue {
  constructor(private readonly base: AgentQueue, private readonly coordinator: AgentKernelRewindCoordinator, private readonly enabled: boolean) {}
  claim(workerId: string) { return this.base.claim(workerId); }
  async step(runId: string, kind: string, status: string, summary: string, state?: Record<string, unknown>) {
    if (this.enabled && kind === "verify" && summary === "Verification failed; return blockers to agent") {
      const rewound = await this.coordinator.rewind(runId);
      state = { ...(state ?? {}), rewindAttempted: true, rewound };
    }
    return this.base.step(runId, kind, status, summary, state);
  }
  stream(runId: string, delta: string, reset?: boolean) { return this.base.stream(runId, delta, reset); }
  recordRunIntelligence(runId: string, task: Parameters<AgentQueue["recordRunIntelligence"]>[1], skills: string[]) { return this.base.recordRunIntelligence(runId, task, skills); }
  recordRepositoryIndex(...args: Parameters<AgentQueue["recordRepositoryIndex"]>) { return this.base.recordRepositoryIndex(...args); }
  recordImpactAnalysis(...args: Parameters<AgentQueue["recordImpactAnalysis"]>) { return this.base.recordImpactAnalysis(...args); }
  recordVerificationRun(...args: Parameters<AgentQueue["recordVerificationRun"]>) { return this.base.recordVerificationRun(...args); }
  async complete(run: ClaimedRun, output: Parameters<AgentQueue["complete"]>[1]) {
    await this.base.complete(run, output);
    this.coordinator.complete(run.runId);
  }
  async fail(run: ClaimedRun, errorCode: string, retryable: boolean) {
    if (this.enabled) await this.coordinator.rewind(run.runId);
    await this.base.fail(run, errorCode, retryable);
    this.coordinator.complete(run.runId);
  }
  isCancelled(runId: string) { return this.base.isCancelled(runId); }
}
