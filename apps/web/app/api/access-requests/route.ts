import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const read = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const form = await request.formData();
  const honeypot = read(form, "company_website");
  if (honeypot) return NextResponse.redirect(new URL("/request-access?submitted=1", request.url), 303);

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
  if (invalid) return NextResponse.redirect(new URL("/request-access?error=invalid", request.url), 303);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("access_requests").insert(payload);
  if (error?.code === "23505") return NextResponse.redirect(new URL("/request-access?submitted=1", request.url), 303);
  if (error) return NextResponse.redirect(new URL("/request-access?error=save", request.url), 303);

  return NextResponse.redirect(new URL("/request-access?submitted=1", request.url), 303);
}
