import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { getAppUrl } from "../../../../lib/app-url";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../../../../lib/supabase/config";

const SUPERADMIN_EMAIL = "hekmat.h@div3rsa.com";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (token.length < 40 || token.length > 256) {
    return NextResponse.json({ error: "bootstrap_not_authorized" }, { status: 401 });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  try {
    const provisionalPassword = randomBytes(36).toString("base64url");
    const { error: signupError } = await supabase.auth.signUp({
      email: SUPERADMIN_EMAIL,
      password: provisionalPassword,
      options: {
        emailRedirectTo: `${getAppUrl()}/auth/set-password`,
        data: {
          display_name: "Hekmat",
          account_type: "initial_superadmin"
        }
      }
    });

    if (signupError && !/already|registered|exists/i.test(signupError.message)) {
      throw signupError;
    }

    const { error: bootstrapError } = await supabase.rpc("bootstrap_initial_superadmin_from_email", {
      provided_token_hash: tokenHash,
      target_email: SUPERADMIN_EMAIL
    });
    if (bootstrapError) throw bootstrapError;

    return NextResponse.json({ ok: true, email: SUPERADMIN_EMAIL, confirmation_email_requested: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "bootstrap_failed";
    const unauthorized = /invalid_or_expired|not_authorized/i.test(message);
    return NextResponse.json({ error: unauthorized ? "bootstrap_not_authorized" : "bootstrap_failed" }, { status: unauthorized ? 401 : 500 });
  }
}
