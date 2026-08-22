import { createHash } from "node:crypto";

export interface CanaryMetric { key: string; baseline: number; candidate: number; maximumRegression: number; critical: boolean }
export function evaluateCanary(input: { previousDeploymentId: string; candidateDeploymentId: string; metrics: CanaryMetric[] }): { promote: boolean; rollbackTo?: string; blockers: string[] } {
  const blockers = input.metrics.filter((metric) => metric.critical && metric.baseline - metric.candidate > metric.maximumRegression).map((metric) => `critical_regression:${metric.key}`);
  return blockers.length ? { promote: false, rollbackTo: input.previousDeploymentId, blockers } : { promote: true, blockers: [] };
}

export interface TrainingPlanInput { method: "lora" | "qlora"; baseModelRevision: string; baseArtifactSha256: string; datasetHash: string; datasetStatus: "draft" | "verified" | "frozen"; seed: number; epochs: number; learningRate: number; computePool: "inference" | "training"; outputUri: string }
export function buildTrainingPlan(input: TrainingPlanInput): { command: string[]; manifestHash: string } {
  if (!/^[a-f0-9]{40}$/.test(input.baseModelRevision) || !/^[a-f0-9]{64}$/.test(input.baseArtifactSha256) || !/^[a-f0-9]{64}$/.test(input.datasetHash)) throw new Error("training_inputs_not_pinned");
  if (input.datasetStatus !== "frozen" || input.computePool !== "training") throw new Error("training_boundary_violation");
  if (!Number.isInteger(input.seed) || input.epochs < 1 || input.learningRate <= 0 || !input.outputUri) throw new Error("invalid_training_recipe");
  const command = ["accelerate", "launch", "train_adapter.py", "--model_revision", input.baseModelRevision, "--model_sha256", input.baseArtifactSha256, "--dataset_sha256", input.datasetHash, "--seed", String(input.seed), "--epochs", String(input.epochs), "--learning_rate", String(input.learningRate), "--output_uri", input.outputUri, ...(input.method === "qlora" ? ["--load_in_4bit"] : [])];
  return { command, manifestHash: createHash("sha256").update(JSON.stringify({ ...input, command })).digest("hex") };
}

const sensitiveKeys = /token|secret|password|authorization|prompt|content|output/i;
export function redactTelemetry(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, sensitiveKeys.test(key) ? "[REDACTED]" : value])); }
export function traceEvent<T extends { traceId: string; runId: string; service: string; name: string; at: string; attributes: Record<string, unknown> }>(event: T): T { if (!event.traceId || !event.runId || !event.service || !event.name) throw new Error("invalid_trace_event"); return { ...event, attributes: redactTelemetry(event.attributes) }; }

export function planGpuReconciliation(input: { minimumWarm: number; maximumWorkers: number; ready: number; provisioning: number; queueDepth: number; averageUtilization: number }): { action: "provision" | "drain" | "hold"; count: number } {
  const total = input.ready + input.provisioning;
  if (input.queueDepth > 0 && total < input.maximumWorkers && input.provisioning === 0) return { action: "provision", count: 1 };
  if (input.queueDepth === 0 && input.averageUtilization < 20 && input.ready > input.minimumWarm) return { action: "drain", count: 1 };
  return { action: "hold", count: 0 };
}
