import { authenticatedV1, v1Success } from "../../../../../lib/api/v1";
import { AGENT_RUNTIME_VERSION, PLATFORM_VERSION, PORTABLE_TOOL_CONTRACTS } from "../../../../../lib/platform/portability";

export async function GET(request: Request) {
  const auth = await authenticatedV1(request);
  if (!auth.ok) return auth.response;
  return v1Success({
    platformVersion: PLATFORM_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    modes: ["chat", "code", "lab", "research"],
    limits: { promptCharacters: 100000, selectedResources: 20, portabilityBundleBytes: 2000000 },
    endpoints: {
      startRun: "/api/v1/agents/run",
      run: "/api/v1/runs/{runId}",
      exportPlatform: "/api/v1/platform/export",
      validateImport: "/api/v1/platform/import/validate",
      stageImport: "/api/v1/platform/import",
      importStatus: "/api/v1/platform/imports/{importId}",
      activateImport: "/api/v1/platform/imports/{importId}/activate"
    },
    portability: { schemaVersion: 1, superadminOnly: true, activationRequiresSelfTests: true },
    toolContracts: PORTABLE_TOOL_CONTRACTS
  }, auth.requestId, 200, { "Cache-Control": "private, max-age=60" });
}
