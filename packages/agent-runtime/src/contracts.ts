import type { GenerateRequest, GenerateResult, ModelAdapter, ModelAlias } from "@div3rsa/model-sdk";

export type AgentMode = "chat" | "code" | "lab" | "research";
export type RunStatus = "queued" | "planning" | "running" | "waiting_for_user" | "waiting_for_tool" | "verifying" | "retrying" | "completed" | "failed" | "cancelled" | "timed_out";
export type StepKind = "plan" | "skill" | "model" | "tool" | "review" | "verify";

export interface ActorContext {
  userId: string;
  organizationId: string;
  workspaceId: string;
  permissions: ReadonlySet<string>;
  assuranceLevel: "aal1" | "aal2";
  systemRole?: "superadmin";
}

export interface AgentRunRequest {
  requestId: string;
  traceId: string;
  conversationId: string;
  mode: AgentMode;
  prompt: string;
  actor: ActorContext;
  authorization?: { target: string; scope: string; expiresAt: string };
}

export interface AgentStep {
  sequence: number;
  kind: StepKind;
  status: RunStatus;
  skill?: string;
  summary: string;
}

export interface AgentRunRecord {
  id: string;
  request: AgentRunRequest;
  alias: ModelAlias;
  status: RunStatus;
  steps: AgentStep[];
  attempts: number;
  output?: GenerateResult;
  failureCode?: string;
}

export interface Checkpoint {
  runId: string;
  sequence: number;
  status: RunStatus;
  state: Record<string, unknown>;
  artifactRefs: string[];
}

export interface RunRepository {
  create(record: AgentRunRecord): Promise<void>;
  update(record: AgentRunRecord): Promise<void>;
  checkpoint(checkpoint: Checkpoint): Promise<void>;
  isCancellationRequested(runId: string): Promise<boolean>;
}

export interface RuntimeDependencies {
  model: ModelAdapter;
  runs: RunRepository;
  now?: () => Date;
}

export interface PreparedModelRequest extends GenerateRequest {
  alias: ModelAlias;
}
