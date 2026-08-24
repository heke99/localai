import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../supabase/server";

export type ApiV1ErrorCode =
  | "authentication_required" | "superadmin_required" | "step_up_required" | "invalid_request" | "not_found" | "conflict"
  | "subscription_required" | "resource_or_access_denied" | "run_start_failed" | "run_not_found" | "run_not_cancellable"
  | "portability_model_missing" | "portability_bundle_invalid" | "portability_import_blocked" | "portability_operation_failed";

export function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,120}$/.test(candidate) ? candidate : crypto.randomUUID();
}
export function traceId(request: Request): string {
  const candidate = request.headers.get("x-trace-id")?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,160}$/.test(candidate) ? candidate : crypto.randomUUID();
}
export function v1Success<T>(data: T, id: string, status = 200, headers?: HeadersInit) {
  return NextResponse.json({ apiVersion: "v1", requestId: id, data }, { status, headers });
}
export function v1Error(code: ApiV1ErrorCode, id: string, status: number, detail?: string) {
  return NextResponse.json({ apiVersion: "v1", requestId: id, error: { code, ...(detail ? { detail } : {}) } }, { status });
}

export async function authenticatedV1(request: Request) {
  const id = requestId(request);
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { ok: false as const, response: v1Error("authentication_required", id, 401), requestId: id };
  return { ok: true as const, supabase, user, requestId: id };
}

export async function superadminV1(request: Request) {
  const auth = await authenticatedV1(request);
  if (!auth.ok) return auth;
  if (auth.user.app_metadata.system_role !== "superadmin") return { ok: false as const, response: v1Error("superadmin_required", auth.requestId, 403), requestId: auth.requestId };
  const { data, error } = await auth.supabase.rpc("superadmin_email_step_up_status");
  if (error || !(data as { verified?: boolean } | null)?.verified) return { ok: false as const, response: v1Error("step_up_required", auth.requestId, 403), requestId: auth.requestId };
  return auth;
}

export async function jsonBody<T>(request: Request, maximumBytes = 1_000_000): Promise<T | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maximumBytes) return null;
  try {
    const text = await request.text();
    if (!text || new TextEncoder().encode(text).byteLength > maximumBytes) return null;
    return JSON.parse(text) as T;
  } catch { return null; }
}
