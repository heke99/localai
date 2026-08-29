import { createHash } from "node:crypto";

export type AgentMemoryTier = "working" | "episodic" | "semantic" | "procedural" | "verified_experience";

export interface AgentMemoryRecord {
  readonly id: string;
  readonly tier: AgentMemoryTier;
  readonly scope: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceRunId: string;
  readonly createdAt: string;
  readonly verified: boolean;
  readonly confidence: number;
}

export interface ExperienceCandidate {
  readonly sourceRunId: string;
  readonly scope: string;
  readonly problem: string;
  readonly successfulStrategy: string;
  readonly evidenceRefs: readonly string[];
  readonly verificationPassed: boolean;
  readonly regressionFree: boolean;
  readonly sourceQuality?: number;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function idFor(input: ExperienceCandidate): string {
  return createHash("sha256")
    .update(JSON.stringify({ run: input.sourceRunId, scope: input.scope, problem: normalize(input.problem), strategy: normalize(input.successfulStrategy), evidence: [...input.evidenceRefs].sort() }))
    .digest("hex");
}

export function promoteVerifiedExperience(candidate: ExperienceCandidate): AgentMemoryRecord | null {
  const problem = normalize(candidate.problem);
  const strategy = normalize(candidate.successfulStrategy);
  if (!problem || !strategy || candidate.evidenceRefs.length === 0) return null;
  if (!candidate.verificationPassed || !candidate.regressionFree) return null;
  const sourceQuality = Math.max(0, Math.min(1, candidate.sourceQuality ?? 1));
  if (sourceQuality < 0.5) return null;
  return {
    id: idFor(candidate),
    tier: "verified_experience",
    scope: normalize(candidate.scope) || "global",
    summary: `Problem: ${problem}\nSuccessful strategy: ${strategy}`,
    evidenceRefs: [...new Set(candidate.evidenceRefs)].sort(),
    sourceRunId: candidate.sourceRunId,
    createdAt: new Date().toISOString(),
    verified: true,
    confidence: Math.round(sourceQuality * 1000) / 1000
  };
}

export function proceduralMemory(input: { sourceRunId: string; scope: string; procedure: string; evidenceRefs?: readonly string[]; verified?: boolean }): AgentMemoryRecord | null {
  const procedure = normalize(input.procedure);
  if (!procedure) return null;
  const verified = input.verified === true;
  const createdAt = new Date().toISOString();
  return {
    id: createHash("sha256").update(JSON.stringify({ sourceRunId: input.sourceRunId, scope: input.scope, procedure, evidenceRefs: input.evidenceRefs ?? [] })).digest("hex"),
    tier: "procedural",
    scope: normalize(input.scope) || "global",
    summary: procedure,
    evidenceRefs: [...new Set(input.evidenceRefs ?? [])].sort(),
    sourceRunId: input.sourceRunId,
    createdAt,
    verified,
    confidence: verified ? 1 : 0.5
  };
}

export function memoryIsEligibleForPlanning(memory: AgentMemoryRecord): boolean {
  if (memory.tier === "verified_experience") return memory.verified && memory.evidenceRefs.length > 0 && memory.confidence >= 0.5;
  if (memory.tier === "procedural") return memory.verified;
  return memory.tier === "semantic" || memory.tier === "episodic" || memory.tier === "working";
}
