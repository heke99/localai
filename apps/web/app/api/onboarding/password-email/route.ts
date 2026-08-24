import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

function json(body: Record<string, unknown>, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) return json({ error: "invalid_origin" }, 403);

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return json({ error: "authentication_required" }, 401);
  if (!user.email_confirmed_at) return json({ error: "email_confirmation_required" }, 403);

  const admin = createSupabaseAdminClient();
  const { data: grant, error: grantError } = await admin
    .from("access_requests")
    .select("id,email,status,password_email_sent_at,onboarding_completed_at,access_mode,billing_checkout_url")
    .eq("invited_user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();

  if (grantError) return json({ error: "grant_lookup_failed" }, 500);
  if (!grant) return json({ error: "approved_access_grant_required" }, 403);
  const billingCheckoutUrl = grant.access_mode === "paid" ? grant.billing_checkout_url : null;
  if (grant.onboarding_completed_at) return json({ completed: true, billingCheckoutUrl, accessMode: grant.access_mode });

  if (grant.password_email_sent_at) {
    const { error: completionError } = await supabase.rpc("complete_user_onboarding");
    if (!completionError) return json({ completed: true, recovered: true, billingCheckoutUrl, accessMode: grant.access_mode });
    if (!completionError.message.includes("password_required")) {
      console.error("onboarding_completion_recovery_failed", { code: completionError.code });
      return json({ error: "onboarding_completion_failed" }, 500);
    }

    return json({ sent: true, alreadySent: true, billingCheckoutUrl, accessMode: grant.access_mode });
  }

  const { error: emailError } = await admin.auth.resetPasswordForEmail(grant.email, {
    redirectTo: `${requestUrl.origin}/auth/set-password?mode=onboarding`
  });
  if (emailError) return json({ error: "password_email_failed" }, 502);

  const { error: updateError } = await admin
    .from("access_requests")
    .update({ password_email_sent_at: new Date().toISOString() })
    .eq("id", grant.id)
    .is("password_email_sent_at", null);
  if (updateError) return json({ error: "password_email_state_failed" }, 500);

  return json({ sent: true, billingCheckoutUrl, accessMode: grant.access_mode });
}
