import { describe, expect, it } from "vitest";
import {
  AGENT_MANIFEST_SCHEMA_VERSION,
  canonicalizeAgentExport,
  createAgentExport,
  evaluatePortabilityActivation,
  parseAgentExportBundle,
  validateAgentImport
} from "./portability";

const bundle = createAgentExport({
  manifest: {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    platformVersion: "0.1.0",
    runtimeVersion: "0.1.0",
    model: { provider: "model-gateway", modelId: "qwen3.8-v2-q8", quantization: "Q8", requiredCapabilities: ["coding", "tools"] },
    skills: [{ name: "code-review", version: "1.0.0", sha256: "a".repeat(64) }],
    agents: [{ name: "primary", version: "1.0.0" }],
    requiredTools: ["div3rsa_repository_search"],
    requiredProviders: ["database", "git", "deployment", "compute", "object-storage", "vector-store", "model"],
    knowledge: [{ scope: "GLOBAL", version: "abc123", reference: "knowledge://global/abc123" }],
    evalProfile: { version: "1", suites: ["baseline", "portability"] },
    capabilities: { repoIngestion: true, codeEditing: true, e2e: true, consequenceAnalysis: true, verificationGate: true, knowledgeIngestion: true, exportImport: true }
  },
  configurationReferences: [{ key: "git.default", reference: "resource://git/default", providerType: "git" }]
});

const environment = {
  platformVersion: "0.1.9",
  runtimeVersion: "0.1.7",
  availableSkills: [{ name: "code-review", version: "1.0.0" }],
  availableTools: ["div3rsa_repository_search"],
  providers: { database: "supabase", git: "github", deployment: "vercel", compute: "gpu", "object-storage": "supabase-storage", "vector-store": "pgvector", model: "model-gateway" },
  modelCapabilities: ["coding", "tools"]
} as const;

describe("agent portability", () => {
  it("round-trips a strict export bundle", () => {
    const parsed = parseAgentExportBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed).toEqual(bundle);
    expect(canonicalizeAgentExport(parsed)).toBe(canonicalizeAgentExport(bundle));
  });

  it("rejects secret-like configuration references", () => {
    const unsafe = JSON.parse(JSON.stringify(bundle));
    unsafe.configurationReferences[0].reference = "vault://token/sk-abcdefghijklmnop";
    expect(() => parseAgentExportBundle(unsafe)).toThrow("secret_like_reference_rejected");
  });

  it("requires compatible environment and every self-test before activation", () => {
    const validation = validateAgentImport(bundle, environment);
    expect(validation.compatible).toBe(true);
    expect(evaluatePortabilityActivation(validation, validation.requiredSelfTests.map((kind) => ({ kind: kind as never, status: "passed" as const, summary: "ok" }))).toEqual({ ready: true, blockers: [] });
    expect(evaluatePortabilityActivation(validation, [])).toEqual(expect.objectContaining({ ready: false }));
  });

  it("blocks imports when a required tool is missing", () => {
    const validation = validateAgentImport(bundle, { ...environment, availableTools: [] });
    expect(validation.compatible).toBe(false);
    expect(validation.errors).toContain("missing_tool:div3rsa_repository_search");
  });
});
