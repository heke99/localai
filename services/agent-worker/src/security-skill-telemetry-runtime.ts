import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import {
  planPentestCapabilities,
  securityCapabilityIdsForSkill,
  SECURITY_OPERATION_IDS,
  type PentestCapabilityPlan,
  type SecurityOperationId
} from "./pentest-capability-planner";

export type SecuritySkillTelemetryStage = "selected" | "execution_aligned" | "execution_blocked";

export interface SecuritySkillTelemetryEvent {
  schemaVersion: 1;
  attributionBasis: "runtime_execution_correlation_not_chain_of_thought";
  stage: SecuritySkillTelemetryStage;
  skill: string;
  capabilityIds: string[];
  selected: true;
  materiallyUsed: boolean;
  useful: boolean | null;
  capabilityGap: boolean;
  supportedOperations: SecurityOperationId[];
  operation?: SecurityOperationId;
  evidenceStatus?: string;
  errorCode?: string;
}

export type SecuritySkillTelemetrySink = (run: ClaimedRun, event: SecuritySkillTelemetryEvent) => Promise<void>;
export type SecuritySkillNamesResolver = (run: ClaimedRun) => Promise<readonly string[]>;

const ATTRIBUTION_BASIS = "runtime_execution_correlation_not_chain_of_thought" as const;
const MAX_SELECTION_SIGNATURES = 512;

function securitySkillNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name === "authorized-pentest" || name.startsWith("external-security:")))];
}

function uniqueOperations(values: readonly SecurityOperationId[]): SecurityOperationId[] {
  const selected = new Set(values);
  return SECURITY_OPERATION_IDS.filter((operation) => selected.has(operation));
}

function skillAssessment(plan: PentestCapabilityPlan, skill: string) {
  const capabilityIds = securityCapabilityIdsForSkill(skill, plan.intent);
  const matched = plan.assessments.filter((assessment) => capabilityIds.includes(assessment.id));
  const supportedOperations = uniqueOperations(matched.flatMap((assessment) => assessment.supportedOperations));
  const genericAuthorized = skill === "authorized-pentest";
  return {
    capabilityIds,
    supportedOperations: genericAuthorized ? plan.allowedOperations : supportedOperations,
    capabilityGap: matched.some((assessment) => assessment.status !== "available")
      || plan.skillCapabilityMismatches.some((mismatch) => mismatch.skill === skill)
  };
}

function selectedEvents(plan: PentestCapabilityPlan): SecuritySkillTelemetryEvent[] {
  return securitySkillNames(plan.selectedSkills).map((skill) => {
    const assessment = skillAssessment(plan, skill);
    return {
      schemaVersion: 1,
      attributionBasis: ATTRIBUTION_BASIS,
      stage: "selected",
      skill,
      capabilityIds: assessment.capabilityIds,
      selected: true,
      materiallyUsed: false,
      useful: null,
      capabilityGap: assessment.capabilityGap,
      supportedOperations: assessment.supportedOperations
    };
  });
}

function executionEvidence(output: unknown): { useful: boolean; evidenceStatus: string } {
  if (!output || typeof output !== "object" || Array.isArray(output)) return { useful: false, evidenceStatus: "unstructured" };
  const value = output as Record<string, unknown>;
  const status = typeof value.status === "string" ? value.status : value.ok === true ? "completed" : "unknown";
  if (status === "executor_error") return { useful: false, evidenceStatus: status };
  const evidence = value.evidence;
  const structuredEvidence = Boolean(evidence && typeof evidence === "object" && !Array.isArray(evidence));
  const observedResult = typeof value.durationMs === "number" || value.ok === true || typeof value.exitCode === "number";
  return { useful: structuredEvidence && observedResult, evidenceStatus: status };
}

function executionEvents(
  plan: PentestCapabilityPlan,
  operation: SecurityOperationId,
  output: unknown,
  blockedError?: string
): SecuritySkillTelemetryEvent[] {
  const evidence = executionEvidence(output);
  return securitySkillNames(plan.selectedSkills).flatMap((skill) => {
    const assessment = skillAssessment(plan, skill);
    if (!assessment.supportedOperations.includes(operation)) return [];
    return [{
      schemaVersion: 1,
      attributionBasis: ATTRIBUTION_BASIS,
      stage: blockedError ? "execution_blocked" : "execution_aligned",
      skill,
      capabilityIds: assessment.capabilityIds,
      selected: true,
      materiallyUsed: !blockedError,
      useful: blockedError ? false : evidence.useful,
      capabilityGap: assessment.capabilityGap,
      supportedOperations: assessment.supportedOperations,
      operation,
      evidenceStatus: blockedError ? "blocked" : evidence.evidenceStatus,
      ...(blockedError ? { errorCode: blockedError } : {})
    } satisfies SecuritySkillTelemetryEvent];
  });
}

function operationFromCall(call: ModelToolCall): SecurityOperationId | null {
  const operation = typeof call.input.tool === "string" ? call.input.tool : "";
  return SECURITY_OPERATION_IDS.includes(operation as SecurityOperationId) ? operation as SecurityOperationId : null;
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "security_tool_failed"))
    .replace(/[^a-zA-Z0-9_:-]+/g, "_")
    .slice(0, 160);
}

export class SecuritySkillTelemetryRuntime implements WorkerToolRuntime {
  private readonly selectionSignatures = new Map<string, string>();

  constructor(
    private readonly inner: WorkerToolRuntime,
    private readonly selectedSkills: SecuritySkillNamesResolver,
    private readonly sink: SecuritySkillTelemetrySink
  ) {}

  private rememberSelection(runId: string, signature: string): boolean {
    if (this.selectionSignatures.get(runId) === signature) return false;
    this.selectionSignatures.set(runId, signature);
    while (this.selectionSignatures.size > MAX_SELECTION_SIGNATURES) {
      const oldest = this.selectionSignatures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.selectionSignatures.delete(oldest);
    }
    return true;
  }

  private async plan(run: ClaimedRun, definitions: readonly ModelToolDefinition[]): Promise<PentestCapabilityPlan | null> {
    if (run.mode !== "lab" || !definitions.some((definition) => definition.name === "security_scan")) return null;
    let selectedSkills: readonly string[] = [];
    try {
      selectedSkills = await this.selectedSkills(run);
    } catch {
      selectedSkills = [];
    }
    return planPentestCapabilities({ mode: run.mode, prompt: run.prompt, selectedSkills, toolDefinitions: definitions });
  }

  private async emit(run: ClaimedRun, event: SecuritySkillTelemetryEvent): Promise<void> {
    try {
      await this.sink(run, event);
    } catch {
      // Telemetry is deliberately non-authoritative and must never change execution semantics.
    }
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = await this.inner.list(run);
    const plan = await this.plan(run, definitions);
    if (!plan) return definitions;
    const events = selectedEvents(plan);
    const signature = JSON.stringify(events.map((event) => [event.skill, event.capabilityIds, event.supportedOperations, event.capabilityGap]));
    if (this.rememberSelection(run.runId, signature)) {
      await Promise.all(events.map((event) => this.emit(run, event)));
    }
    return definitions;
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (call.name !== "security_scan") return this.inner.execute(run, call);
    const operation = operationFromCall(call);
    const definitions = await this.inner.list(run);
    const plan = await this.plan(run, definitions);
    try {
      const output = await this.inner.execute(run, call);
      if (plan && operation) await Promise.all(executionEvents(plan, operation, output).map((event) => this.emit(run, event)));
      return output;
    } catch (error) {
      if (plan && operation) {
        await Promise.all(executionEvents(plan, operation, null, errorCode(error)).map((event) => this.emit(run, event)));
      }
      throw error;
    }
  }
}

export const securitySkillTelemetry = Object.freeze({
  selectedEvents,
  executionEvents,
  executionEvidence
});
