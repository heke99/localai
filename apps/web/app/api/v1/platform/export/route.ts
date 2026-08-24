import { buildLiveAgentExport, loadPortabilitySource, portabilityHash, recordExport } from "../../../../../lib/platform/portability";
import { jsonBody, superadminV1, v1Error, v1Success } from "../../../../../lib/api/v1";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function ids(values: unknown): string[] | null {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 200 || values.some((value) => typeof value !== "string" || !uuid.test(value))) return null;
  return [...new Set(values as string[])];
}

async function exportBundle(request: Request, selection: { projectIds?: string[]; repositoryIds?: string[] }) {
  const auth = await superadminV1(request);
  if (!auth.ok) return auth.response;
  try {
    const source = await loadPortabilitySource(auth.supabase);
    const bundle = buildLiveAgentExport(source, selection);
    const hash = portabilityHash(bundle);
    const exportId = await recordExport(auth.supabase, bundle, hash);
    return v1Success({ exportId, bundleHash: hash, bundle }, auth.requestId, 200, { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="div3rsa-agent-${hash.slice(0, 12)}.json"` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "portability_export_failed";
    return v1Error(message === "portable_model_route_missing" ? "portability_model_missing" : "portability_operation_failed", auth.requestId, message === "portable_model_route_missing" ? 409 : 500);
  }
}

export async function GET(request: Request) { return exportBundle(request, {}); }

export async function POST(request: Request) {
  const body = await jsonBody<{ selectedProjectIds?: unknown; selectedRepositoryIds?: unknown }>(request, 64_000);
  if (!body) {
    const auth = await superadminV1(request);
    return auth.ok ? v1Error("invalid_request", auth.requestId, 400) : auth.response;
  }
  const projectIds = ids(body.selectedProjectIds);
  const repositoryIds = ids(body.selectedRepositoryIds);
  if (!projectIds || !repositoryIds) {
    const auth = await superadminV1(request);
    return auth.ok ? v1Error("invalid_request", auth.requestId, 400) : auth.response;
  }
  return exportBundle(request, { projectIds, repositoryIds });
}
