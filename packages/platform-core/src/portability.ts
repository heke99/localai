export const AGENT_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface AgentManifestV1 {
  schemaVersion: typeof AGENT_MANIFEST_SCHEMA_VERSION;
  platformVersion: string;
  runtimeVersion: string;
  model: { provider: string; modelId: string; quantization?: string; requiredCapabilities: string[] };
  skills: Array<{ name: string; version: string; sha256?: string }>;
  agents: Array<{ name: string; version: string }>;
  requiredTools: string[];
  requiredProviders: Array<"database" | "git" | "deployment" | "compute" | "object-storage" | "vector-store" | "model">;
  knowledge: Array<{ scope: "GLOBAL" | "ORGANIZATION"; version: string; reference: string }>;
  evalProfile: { version: string; suites: string[] };
  capabilities: {
    repoIngestion: boolean;
    codeEditing: boolean;
    e2e: boolean;
    consequenceAnalysis: boolean;
    verificationGate: boolean;
    knowledgeIngestion: boolean;
    exportImport: boolean;
  };
}

export interface ConfigurationReference {
  key: string;
  reference: string;
  providerType: AgentManifestV1["requiredProviders"][number];
}

export interface AgentExportBundle {
  manifest: AgentManifestV1;
  createdAt: string;
  configurationReferences: ConfigurationReference[];
  selectedProjectIds?: string[];
  selectedRepositoryIds?: string[];
}

export interface ImportEnvironment {
  platformVersion: string;
  runtimeVersion: string;
  availableSkills: Array<{ name: string; version: string }>;
  availableTools: string[];
  providers: Partial<Record<AgentManifestV1["requiredProviders"][number], string>>;
  modelCapabilities: string[];
}

export interface ImportValidation {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  requiredSelfTests: string[];
}

export type PortabilitySelfTestKind = "provider-health" | "model-health" | "tool-contracts" | "skill-resolution" | "baseline-evals" | "portability-eval";
export interface PortabilitySelfTestResult { kind: PortabilitySelfTestKind; status: "passed" | "failed" | "blocked"; summary: string; evidence?: string[] }
export interface PortabilityActivationDecision { ready: boolean; blockers: string[] }

const providerTypes = new Set<AgentManifestV1["requiredProviders"][number]>(["database", "git", "deployment", "compute", "object-storage", "vector-store", "model"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const secretLike = /(?:^|[/:._-])(token|secret|password|authorization|api[-_]?key|private[-_]?key)(?:$|[/:._-])|bearer\s|\bsk-[a-z0-9_-]{12,}/i;

function text(value: unknown, name: string, maximum = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`invalid_${name}`);
  return value.trim();
}
function array(value: unknown, name: string, maximum = 500): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`invalid_${name}`);
  return value;
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`invalid_${name}`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, name: string, maximum = 500): string[] { return array(value, name, maximum).map((item) => text(item, name, 512)); }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`invalid_${name}`); return value; }
function uuidArray(value: unknown, name: string): string[] {
  return array(value ?? [], name, 200).map((item) => text(item, name, 36)).filter((item, index, values) => uuidPattern.test(item) && values.indexOf(item) === index);
}

export function createAgentExport(input: Omit<AgentExportBundle, "createdAt">): AgentExportBundle {
  if (input.manifest.schemaVersion !== AGENT_MANIFEST_SCHEMA_VERSION) throw new Error("unsupported_agent_manifest_schema");
  if (input.manifest.knowledge.some((item) => item.scope !== "GLOBAL" && item.scope !== "ORGANIZATION")) throw new Error("nonportable_knowledge_scope");
  if (input.configurationReferences.some((item) => !item.key.trim() || !item.reference.trim())) throw new Error("invalid_configuration_reference");
  return { ...input, createdAt: new Date().toISOString() };
}

export function parseAgentExportBundle(input: unknown): AgentExportBundle {
  const root = record(input, "agent_export_bundle");
  const manifestInput = record(root.manifest, "manifest");
  if (manifestInput.schemaVersion !== AGENT_MANIFEST_SCHEMA_VERSION) throw new Error("unsupported_agent_manifest_schema");
  const modelInput = record(manifestInput.model, "model");
  const capabilitiesInput = record(manifestInput.capabilities, "capabilities");
  const evalInput = record(manifestInput.evalProfile, "eval_profile");
  const skills = array(manifestInput.skills, "skills").map((item) => {
    const value = record(item, "skill");
    const sha256 = value.sha256 == null ? undefined : text(value.sha256, "skill_sha256", 64);
    if (sha256 && !shaPattern.test(sha256)) throw new Error("invalid_skill_sha256");
    return { name: text(value.name, "skill_name", 160), version: text(value.version, "skill_version", 80), ...(sha256 ? { sha256 } : {}) };
  });
  const agents = array(manifestInput.agents, "agents", 100).map((item) => { const value = record(item, "agent"); return { name: text(value.name, "agent_name", 160), version: text(value.version, "agent_version", 80) }; });
  const requiredProviders = strings(manifestInput.requiredProviders, "required_providers", 20).map((item) => {
    if (!providerTypes.has(item as AgentManifestV1["requiredProviders"][number])) throw new Error("invalid_required_provider");
    return item as AgentManifestV1["requiredProviders"][number];
  });
  const knowledge = array(manifestInput.knowledge, "knowledge", 500).map((item) => {
    const value = record(item, "knowledge_reference");
    const scope = text(value.scope, "knowledge_scope", 32);
    if (scope !== "GLOBAL" && scope !== "ORGANIZATION") throw new Error("nonportable_knowledge_scope");
    const reference = text(value.reference, "knowledge_reference", 2048);
    if (secretLike.test(reference)) throw new Error("secret_like_reference_rejected");
    return { scope, version: text(value.version, "knowledge_version", 160), reference } as AgentManifestV1["knowledge"][number];
  });
  const configurationReferences = array(root.configurationReferences, "configuration_references", 100).map((item) => {
    const value = record(item, "configuration_reference");
    const providerType = text(value.providerType, "configuration_provider", 32);
    if (!providerTypes.has(providerType as AgentManifestV1["requiredProviders"][number])) throw new Error("invalid_configuration_provider");
    const reference = text(value.reference, "configuration_reference", 2048);
    if (secretLike.test(reference)) throw new Error("secret_like_reference_rejected");
    return { key: text(value.key, "configuration_key", 160), reference, providerType: providerType as AgentManifestV1["requiredProviders"][number] };
  });
  const manifest: AgentManifestV1 = {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    platformVersion: text(manifestInput.platformVersion, "platform_version", 80),
    runtimeVersion: text(manifestInput.runtimeVersion, "runtime_version", 80),
    model: {
      provider: text(modelInput.provider, "model_provider", 160),
      modelId: text(modelInput.modelId, "model_id", 512),
      ...(modelInput.quantization == null ? {} : { quantization: text(modelInput.quantization, "model_quantization", 80) }),
      requiredCapabilities: strings(modelInput.requiredCapabilities, "model_capabilities", 100)
    },
    skills,
    agents,
    requiredTools: [...new Set(strings(manifestInput.requiredTools, "required_tools", 500))],
    requiredProviders: [...new Set(requiredProviders)],
    knowledge,
    evalProfile: { version: text(evalInput.version, "eval_version", 80), suites: [...new Set(strings(evalInput.suites, "eval_suites", 100))] },
    capabilities: {
      repoIngestion: boolean(capabilitiesInput.repoIngestion, "repo_ingestion"),
      codeEditing: boolean(capabilitiesInput.codeEditing, "code_editing"),
      e2e: boolean(capabilitiesInput.e2e, "e2e"),
      consequenceAnalysis: boolean(capabilitiesInput.consequenceAnalysis, "consequence_analysis"),
      verificationGate: boolean(capabilitiesInput.verificationGate, "verification_gate"),
      knowledgeIngestion: boolean(capabilitiesInput.knowledgeIngestion, "knowledge_ingestion"),
      exportImport: boolean(capabilitiesInput.exportImport, "export_import")
    }
  };
  const createdAt = text(root.createdAt, "created_at", 80);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("invalid_created_at");
  return {
    manifest,
    createdAt: new Date(createdAt).toISOString(),
    configurationReferences,
    ...(root.selectedProjectIds == null ? {} : { selectedProjectIds: uuidArray(root.selectedProjectIds, "selected_project_ids") }),
    ...(root.selectedRepositoryIds == null ? {} : { selectedRepositoryIds: uuidArray(root.selectedRepositoryIds, "selected_repository_ids") })
  };
}

export function validateAgentImport(bundle: AgentExportBundle, environment: ImportEnvironment): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (bundle.manifest.schemaVersion !== AGENT_MANIFEST_SCHEMA_VERSION) errors.push("manifest_schema_unsupported");
  if (bundle.manifest.platformVersion.split(".")[0] !== environment.platformVersion.split(".")[0]) errors.push("platform_major_version_mismatch");
  if (bundle.manifest.runtimeVersion.split(".")[0] !== environment.runtimeVersion.split(".")[0]) errors.push("runtime_major_version_mismatch");

  const skills = new Map(environment.availableSkills.map((skill) => [skill.name, skill.version]));
  for (const required of bundle.manifest.skills) {
    const available = skills.get(required.name);
    if (!available) errors.push(`missing_skill:${required.name}`);
    else if (available !== required.version) warnings.push(`skill_version_differs:${required.name}`);
  }
  const tools = new Set(environment.availableTools);
  for (const tool of bundle.manifest.requiredTools) if (!tools.has(tool)) errors.push(`missing_tool:${tool}`);
  for (const provider of bundle.manifest.requiredProviders) if (!environment.providers[provider]) errors.push(`missing_provider:${provider}`);
  const capabilities = new Set(environment.modelCapabilities);
  for (const capability of bundle.manifest.model.requiredCapabilities) if (!capabilities.has(capability)) errors.push(`model_capability_missing:${capability}`);
  if ((bundle.selectedProjectIds?.length ?? 0) > 0 || (bundle.selectedRepositoryIds?.length ?? 0) > 0) warnings.push("project_data_requires_explicit_import_authorization");

  return {
    compatible: errors.length === 0,
    errors,
    warnings,
    requiredSelfTests: ["provider-health", "model-health", "tool-contracts", "skill-resolution", "baseline-evals", "portability-eval"]
  };
}

export function evaluatePortabilityActivation(validation: ImportValidation, results: readonly PortabilitySelfTestResult[]): PortabilityActivationDecision {
  const blockers = [...validation.errors];
  const byKind = new Map(results.map((result) => [result.kind, result]));
  for (const required of validation.requiredSelfTests) {
    const result = byKind.get(required as PortabilitySelfTestKind);
    if (!result || result.status !== "passed") blockers.push(`self_test_not_passed:${required}`);
  }
  return { ready: validation.compatible && blockers.length === 0, blockers: [...new Set(blockers)] };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
}
export function canonicalizeAgentExport(bundle: AgentExportBundle): string { return JSON.stringify(sortValue(bundle)); }
