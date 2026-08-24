import { createHash } from "node:crypto";
import {
  AGENT_MANIFEST_SCHEMA_VERSION,
  canonicalizeAgentExport,
  createAgentExport,
  evaluatePortabilityActivation,
  parseAgentExportBundle,
  validateAgentImport,
  type AgentExportBundle,
  type ImportEnvironment,
  type PortabilitySelfTestResult
} from "@div3rsa/platform-core";
import { INTEGRATION_TOOL_DEFINITIONS } from "@div3rsa/integrations";
import runtimeManifest from "../../../../skills/runtime-manifest.json";

export const PLATFORM_VERSION = "0.1.0";
export const AGENT_RUNTIME_VERSION = "0.1.0";
const requiredProviders = ["database", "git", "deployment", "compute", "object-storage", "vector-store", "model"] as const;
const providers: ImportEnvironment["providers"] = {
  database: "supabase",
  git: "github",
  deployment: "vercel",
  compute: "gpu-provider",
  "object-storage": "supabase-storage",
  "vector-store": "supabase-pgvector",
  model: "model-gateway"
};
const coreTools = ["div3rsa_repository_search", "div3rsa_repository_read_indexed_file", "div3rsa_list_project_resources", "div3rsa_remember_resource_link"];
export const PORTABLE_TOOL_CONTRACTS = [...new Set([...coreTools, ...INTEGRATION_TOOL_DEFINITIONS.map((tool) => tool.name)])].sort();

type RpcClient = { rpc: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };
export type PortabilitySource = {
  model?: { id: string; version_key: string; repository: string; revision: string; capabilities: string[]; quantization: string | null } | null;
  knowledge?: Array<{ id: string; scope_type: "GLOBAL" | "ORGANIZATION"; scope_id: string | null; source_uri: string | null; content_hash: string; created_at: string }>;
  model_health?: Array<{ ok: boolean; latency_ms: number; observed_at: string; environment: string }>;
  evals?: Array<{ id: string; status: string; created_at: string; finished_at: string | null; suite_key: string; suite_version: number }>;
  recent_imports?: Array<{ id: string; bundle_hash: string; status: string; created_at: string; activated_at: string | null }>;
  recent_exports?: Array<{ id: string; bundle_hash: string; created_at: string }>;
};

export async function loadPortabilitySource(client: unknown): Promise<PortabilitySource> {
  const { data, error } = await (client as RpcClient).rpc<PortabilitySource>("superadmin_portability_source");
  if (error) throw new Error(error.message);
  return data ?? {};
}

export function portabilityEnvironment(source: PortabilitySource): ImportEnvironment {
  return {
    platformVersion: PLATFORM_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    availableSkills: runtimeManifest.skills.map((skill) => ({ name: skill.name, version: skill.version })),
    availableTools: PORTABLE_TOOL_CONTRACTS,
    providers,
    modelCapabilities: source.model?.capabilities ?? []
  };
}

export function buildLiveAgentExport(source: PortabilitySource, selection: { projectIds?: string[]; repositoryIds?: string[] } = {}): AgentExportBundle {
  if (!source.model) throw new Error("portable_model_route_missing");
  const knowledge = (source.knowledge ?? []).flatMap((item) => {
    if (!/^[a-f0-9]{64}$/.test(item.content_hash)) return [];
    const reference = item.source_uri?.trim() || `knowledge://source/${item.id}`;
    if (/(?:token|secret|password|authorization|api[-_]?key)|bearer\s|\bsk-[a-z0-9_-]{12,}/i.test(reference)) return [];
    return [{ scope: item.scope_type, version: item.content_hash, reference }];
  });
  return createAgentExport({
    manifest: {
      schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
      platformVersion: PLATFORM_VERSION,
      runtimeVersion: AGENT_RUNTIME_VERSION,
      model: { provider: "model-gateway", modelId: source.model.version_key, ...(source.model.quantization ? { quantization: source.model.quantization } : {}), requiredCapabilities: source.model.capabilities ?? [] },
      skills: runtimeManifest.skills.map((skill) => ({ name: skill.name, version: skill.version, sha256: skill.sha256 })),
      agents: [{ name: "primary", version: AGENT_RUNTIME_VERSION }, { name: "verifier", version: AGENT_RUNTIME_VERSION }],
      requiredTools: PORTABLE_TOOL_CONTRACTS,
      requiredProviders: [...requiredProviders],
      knowledge,
      evalProfile: { version: "1", suites: ["baseline", "portability"] },
      capabilities: { repoIngestion: true, codeEditing: true, e2e: true, consequenceAnalysis: true, verificationGate: true, knowledgeIngestion: true, exportImport: true }
    },
    configurationReferences: requiredProviders.map((providerType) => ({ key: `${providerType}.default`, providerType, reference: `provider://${providerType}/${providers[providerType]}` })),
    ...(selection.projectIds?.length ? { selectedProjectIds: selection.projectIds } : {}),
    ...(selection.repositoryIds?.length ? { selectedRepositoryIds: selection.repositoryIds } : {})
  });
}

export function portabilityHash(bundle: AgentExportBundle): string { return createHash("sha256").update(canonicalizeAgentExport(bundle)).digest("hex"); }

export function runPortabilitySelfTests(bundle: AgentExportBundle, source: PortabilitySource): { validation: ReturnType<typeof validateAgentImport>; selfTests: PortabilitySelfTestResult[]; activation: ReturnType<typeof evaluatePortabilityActivation> } {
  const environment = portabilityEnvironment(source);
  const validation = validateAgentImport(bundle, environment);
  const toolErrors = validation.errors.filter((error) => error.startsWith("missing_tool:"));
  const skillErrors = validation.errors.filter((error) => error.startsWith("missing_skill:"));
  const providerErrors = validation.errors.filter((error) => error.startsWith("missing_provider:"));
  const latestHealth = source.model_health?.[0];
  const baselineEval = source.evals?.find((item) => item.status === "completed" && /baseline/i.test(item.suite_key));
  let roundTripPassed = false;
  try { roundTripPassed = canonicalizeAgentExport(parseAgentExportBundle(JSON.parse(canonicalizeAgentExport(bundle)))) === canonicalizeAgentExport(bundle); } catch { roundTripPassed = false; }
  const selfTests: PortabilitySelfTestResult[] = [
    { kind: "provider-health", status: providerErrors.length ? "failed" : "passed", summary: providerErrors.length ? providerErrors.join(",") : "All required provider adapter contracts are available.", evidence: Object.entries(providers).map(([kind, provider]) => `${kind}:${provider}`) },
    { kind: "model-health", status: latestHealth?.ok ? "passed" : latestHealth ? "failed" : "blocked", summary: latestHealth?.ok ? `Latest model health check passed in ${latestHealth.environment}.` : latestHealth ? `Latest model health check failed in ${latestHealth.environment}.` : "No model health check exists for the active model.", evidence: latestHealth ? [`observed:${latestHealth.observed_at}`, `latency_ms:${latestHealth.latency_ms}`] : [] },
    { kind: "tool-contracts", status: toolErrors.length ? "failed" : "passed", summary: toolErrors.length ? toolErrors.join(",") : `${bundle.manifest.requiredTools.length} required tool contracts resolved.` },
    { kind: "skill-resolution", status: skillErrors.length ? "failed" : "passed", summary: skillErrors.length ? skillErrors.join(",") : `${bundle.manifest.skills.length} required skills resolved.` },
    { kind: "baseline-evals", status: baselineEval ? "passed" : "blocked", summary: baselineEval ? `Baseline eval ${baselineEval.id} completed.` : "No completed baseline eval exists for the active model.", evidence: baselineEval ? [`suite:${baselineEval.suite_key}@${baselineEval.suite_version}`, `finished:${baselineEval.finished_at ?? baselineEval.created_at}`] : [] },
    { kind: "portability-eval", status: roundTripPassed ? "passed" : "failed", summary: roundTripPassed ? "Bundle survives strict parse and canonical round-trip." : "Bundle failed strict portability round-trip." }
  ];
  return { validation, selfTests, activation: evaluatePortabilityActivation(validation, selfTests) };
}

export async function recordExport(client: unknown, bundle: AgentExportBundle, hash: string): Promise<string> {
  const { data, error } = await (client as RpcClient).rpc<string>("superadmin_record_platform_export", {
    target_bundle_hash: hash,
    target_manifest: bundle.manifest,
    target_configuration_references: bundle.configurationReferences,
    target_selected_project_ids: bundle.selectedProjectIds ?? [],
    target_selected_repository_ids: bundle.selectedRepositoryIds ?? []
  });
  if (error || !data) throw new Error(error?.message ?? "platform_export_record_failed");
  return data;
}

export async function recordImport(client: unknown, bundle: AgentExportBundle, hash: string, evidence: ReturnType<typeof runPortabilitySelfTests>): Promise<{ id: string; status: string }> {
  const { data, error } = await (client as RpcClient).rpc<{ id?: unknown; status?: unknown }>("superadmin_record_platform_import", {
    target_bundle_hash: hash,
    target_manifest: bundle.manifest,
    target_configuration_references: bundle.configurationReferences,
    target_selected_project_ids: bundle.selectedProjectIds ?? [],
    target_selected_repository_ids: bundle.selectedRepositoryIds ?? [],
    target_validation: evidence.validation,
    target_self_tests: evidence.selfTests
  });
  if (error || typeof data?.id !== "string" || typeof data.status !== "string") throw new Error(error?.message ?? "platform_import_record_failed");
  return { id: data.id, status: data.status };
}
