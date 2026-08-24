import { parseAgentExportBundle } from "@div3rsa/platform-core";
import { loadPortabilitySource, portabilityHash, recordImport, runPortabilitySelfTests } from "../../../../../lib/platform/portability";
import { jsonBody, superadminV1, v1Error, v1Success } from "../../../../../lib/api/v1";

export async function POST(request: Request) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  const body = await jsonBody<{ bundle?: unknown; expectedBundleHash?: unknown }>(request, 2_000_000);
  if (!body || body.bundle == null) return v1Error("invalid_request", auth.requestId, 400);
  try {
    const bundle = parseAgentExportBundle(body.bundle);
    const hash = portabilityHash(bundle);
    if (body.expectedBundleHash != null && body.expectedBundleHash !== hash) return v1Error("conflict", auth.requestId, 409, "bundle_hash_mismatch");
    const source = await loadPortabilitySource(auth.supabase);
    const evidence = runPortabilitySelfTests(bundle, source);
    const staged = await recordImport(auth.supabase, bundle, hash, evidence);
    return v1Success({ importId: staged.id, status: staged.status, bundleHash: hash, validation: evidence.validation, selfTests: evidence.selfTests, activation: evidence.activation }, auth.requestId, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "portability_import_failed";
    const invalid = /invalid_|unsupported_|nonportable_|secret_like|bundle/i.test(message);
    return v1Error(invalid ? "portability_bundle_invalid" : "portability_operation_failed", auth.requestId, invalid ? 400 : 500, message);
  }
}
