import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const read = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const maxFormBytes = 16 * 1024;

function redirect(request: Request, target: string) {
  const response = NextResponse.redirect(new URL(target, request.url), 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxFormBytes) return redirect(request, "/request-access?error=invalid");

  const form = await request.formData();
  const honeypot = read(form, "company_website");
  if (honeypot) return redirect(request, "/request-access?submitted=1");

  const payload = {
    name: read(form, "name"),
    email: read(form, "email").toLowerCase(),
    organization_name: read(form, "organization") || null,
    use_case: read(form, "use_case")
  };

  const invalid = payload.name.length < 2
    || payload.name.length > 120
    || !emailPattern.test(payload.email)
    || payload.email.length > 320
    || (payload.organization_name?.length ?? 0) > 160
    || payload.use_case.length < 20
    || payload.use_case.length > 3000;
  if (invalid) return redirect(request, "/request-access?error=invalid");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("submit_access_request", {
    target_name: payload.name,
    target_email: payload.email,
    target_organization_name: payload.organization_name,
    target_use_case: payload.use_case
  });

  if (error || typeof data !== "string") {
    console.error("access_request_submission_failed", { code: error?.code ?? "invalid_rpc_response" });
    return redirect(request, "/request-access?error=save");
  }

  return redirect(request, "/request-access?submitted=1");
}
