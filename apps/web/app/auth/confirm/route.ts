import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeNext(request: NextRequest, rawNext: string | null) {
  if (!rawNext) return "/";
  try {
    const target = new URL(rawNext, request.nextUrl.origin);
    if (target.origin !== request.nextUrl.origin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(request, request.nextUrl.searchParams.get("next"));

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL("/auth/accepted?error=missing_token", request.url), 303);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    return NextResponse.redirect(new URL("/auth/accepted?error=invalid_token", request.url), 303);
  }

  return NextResponse.redirect(new URL(next, request.url), 303);
}
