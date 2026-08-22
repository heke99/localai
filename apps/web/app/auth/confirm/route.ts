import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const ALLOWED_EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "invite",
  "recovery",
  "email",
  "email_change"
]);

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

function noStoreRedirect(url: URL) {
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const rawType = request.nextUrl.searchParams.get("type");
  const type = rawType as EmailOtpType | null;
  const next = safeNext(request, request.nextUrl.searchParams.get("next"));

  if (!tokenHash || !type || !ALLOWED_EMAIL_OTP_TYPES.has(type)) {
    return noStoreRedirect(new URL("/auth/accepted?error=missing_token", request.url));
  }

  // Cross-device by design: verification is based only on the signed one-time token in the
  // email. No existing browser session, localStorage value, PKCE verifier or originating
  // device cookie is required, so a link requested on desktop may safely be opened on mobile
  // (and vice versa). Successful verification establishes the session on the device that
  // actually opened the link.
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    return noStoreRedirect(new URL("/auth/accepted?error=invalid_token", request.url));
  }

  return noStoreRedirect(new URL(next, request.url));
}
