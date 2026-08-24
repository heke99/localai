import { parseAgentExportBundle } from "@div3rsa/platform-core";
import { extractPortabilityBundle } from "../../../../../lib/platform/portability-artifact";
import { loadPortabilitySource, portabilityHash, recordImport, runPortabilitySelfTests } from "../../../../../lib/platform/portability";
import { jsonBody, superadminV1, v1Error, v1Success } from "../../../../../lib/api/v1";

function expectedHash(input: unknown): string | null {
  if (!input || Array.isArray(input) || typeof input !== "object") return null;
  const root = input as Record<string, unknown>;
  if (typeof root.expectedBundleHash === "string") return root.expectedBundleHash;
  if (root.data && !Array.isArray(root.data) && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    if (typeof data.bundleHash === "string") return data.bundleHash;
  }
  return null;
}

export async function POST(request: Request) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  const body = await jsonBody<unknown>(request, 2_000_000);
  if (body == null) return v1Error("invalid_request", auth.requestId, 400);
  try {
    const bundle = parseAgentExportBundle(extractPortabilityBundle(body));
    const hash = portabilityHash(bundle);
    const expected = expectedHash(body);
    if (expected && expected !== hash) return v1Error("conflict", auth.requestId, 409, "bundle_hash_mismatch");
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
