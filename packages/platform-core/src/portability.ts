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

export interface AgentExportBundle {
  manifest: AgentManifestV1;
  createdAt: string;
  configuration: Record<string, unknown>;
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

export function createAgentExport(input: Omit<AgentExportBundle, "createdAt">): AgentExportBundle {
  if (input.manifest.schemaVersion !== AGENT_MANIFEST_SCHEMA_VERSION) throw new Error("unsupported_agent_manifest_schema");
  if (input.manifest.knowledge.some((item) => item.scope !== "GLOBAL" && item.scope !== "ORGANIZATION")) throw new Error("nonportable_knowledge_scope");
  return { ...input, createdAt: new Date().toISOString() };
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
