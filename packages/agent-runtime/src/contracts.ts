import type { GenerateRequest, GenerateResult, ModelAdapter, ModelAlias, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";

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

export type ToolExecutionErrorCode = "TOOL_TIMEOUT" | "TOOL_UNAVAILABLE" | "TOOL_EXECUTION_FAILED";

export interface AgentExecutionCapabilities {
  httpRequests: boolean;
  dns: boolean;
  shell: boolean;
  curl: boolean;
  sandbox: boolean;
  networkEgress: boolean;
  targetAuthorizationContext: boolean;
}

export interface AgentToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: ToolExecutionErrorCode;
  detail?: string;
}

export interface AgentToolExecutionContext {
  request: AgentRunRequest;
  runId: string;
}

export interface AgentToolRuntime {
  definitions(context: AgentToolExecutionContext): readonly ModelToolDefinition[] | Promise<readonly ModelToolDefinition[]>;
  capabilities?(context: AgentToolExecutionContext): Partial<AgentExecutionCapabilities> | Promise<Partial<AgentExecutionCapabilities>>;
  execute(call: ModelToolCall, context: AgentToolExecutionContext, signal: AbortSignal): Promise<AgentToolExecutionResult>;
}

export interface RuntimeDependencies {
  model: ModelAdapter;
  runs: RunRepository;
  tools?: AgentToolRuntime;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxToolIterations?: number;
  now?: () => Date;
}

export interface PreparedModelRequest extends GenerateRequest {
  alias: ModelAlias;
}
