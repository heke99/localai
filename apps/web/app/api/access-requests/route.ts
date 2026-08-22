import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const read = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

export async function POST(request: Request) {
  const form = await request.formData();
  const payload = {
    name: read(form, "name"),
    email: read(form, "email").toLowerCase(),
    organization_name: read(form, "organization") || null,
    use_case: read(form, "use_case")
  };
  if (payload.name.length < 2 || !payload.email.includes("@") || payload.use_case.length < 20) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("access_requests").insert(payload);
  if (error) return NextResponse.json({ error: "request_not_saved" }, { status: 500 });
  return NextResponse.redirect(new URL("/request-access?submitted=1", request.url), 303);
}
