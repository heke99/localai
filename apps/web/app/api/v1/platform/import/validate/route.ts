import { parseAgentExportBundle } from "@div3rsa/platform-core";
import { loadPortabilitySource, portabilityHash, runPortabilitySelfTests } from "../../../../../../lib/platform/portability";
import { jsonBody, superadminV1, v1Error, v1Success } from "../../../../../../lib/api/v1";

export async function POST(request: Request) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  const body = await jsonBody<{ bundle?: unknown }>(request, 2_000_000);
  if (!body || body.bundle == null) return v1Error("invalid_request", auth.requestId, 400);
  try {
    const bundle = parseAgentExportBundle(body.bundle);
    const source = await loadPortabilitySource(auth.supabase);
    const evidence = runPortabilitySelfTests(bundle, source);
    return v1Success({ bundleHash: portabilityHash(bundle), validation: evidence.validation, selfTests: evidence.selfTests, activation: evidence.activation }, auth.requestId, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return v1Error("portability_bundle_invalid", auth.requestId, 400, error instanceof Error ? error.message : "invalid_bundle");
  }
}
