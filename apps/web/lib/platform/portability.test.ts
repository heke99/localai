import { describe, expect, it } from "vitest";
import { parseAgentExportBundle } from "@div3rsa/platform-core";
import { extractPortabilityBundle } from "./portability-artifact";
import { buildLiveAgentExport, portabilityHash, runPortabilitySelfTests, type PortabilitySource } from "./portability";

const source: PortabilitySource = {
  model: { id: "00000000-0000-4000-8000-000000000001", version_key: "qwen-v2-q8", repository: "models/qwen", revision: "a".repeat(40), capabilities: ["coding", "tools"], quantization: "Q8" },
  knowledge: [
    { id: "00000000-0000-4000-8000-000000000002", scope_type: "GLOBAL", scope_id: null, source_uri: "knowledge://global/security", content_hash: "b".repeat(64), created_at: new Date().toISOString() },
    { id: "00000000-0000-4000-8000-000000000003", scope_type: "GLOBAL", scope_id: null, source_uri: "https://example.test/token/private", content_hash: "c".repeat(64), created_at: new Date().toISOString() }
  ],
  model_health: [{ ok: true, latency_ms: 42, observed_at: new Date().toISOString(), environment: "production" }],
  evals: [{ id: "00000000-0000-4000-8000-000000000004", status: "completed", created_at: new Date().toISOString(), finished_at: new Date().toISOString(), suite_key: "baseline", suite_version: 1 }]
};

describe("web portability service", () => {
  it("exports only safe references and produces a stable hash", () => {
    const bundle = buildLiveAgentExport(source);
    expect(bundle.manifest.model.modelId).toBe("qwen-v2-q8");
    expect(bundle.manifest.knowledge).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toContain("token/private");
    expect(portabilityHash(bundle)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts the downloaded v1 export envelope as the next import artifact", () => {
    const bundle = buildLiveAgentExport(source);
    const envelope = { apiVersion: "v1", requestId: "request", data: { bundleHash: portabilityHash(bundle), bundle } };
    expect(parseAgentExportBundle(extractPortabilityBundle(envelope))).toEqual(bundle);
  });

  it("allows activation only with health and baseline eval evidence", () => {
    const bundle = buildLiveAgentExport(source);
    expect(runPortabilitySelfTests(bundle, source).activation).toEqual({ ready: true, blockers: [] });
    const blocked = runPortabilitySelfTests(bundle, { ...source, model_health: [], evals: [] });
    expect(blocked.activation.ready).toBe(false);
    expect(blocked.activation.blockers).toContain("self_test_not_passed:model-health");
    expect(blocked.activation.blockers).toContain("self_test_not_passed:baseline-evals");
  });
});
