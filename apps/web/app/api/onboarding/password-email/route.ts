import { NextResponse } from "next/server";
import { getAppUrl } from "../../../../lib/app-url";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!user.email_confirmed_at) return NextResponse.json({ error: "email_confirmation_required" }, { status: 403 });

  const admin = createSupabaseAdminClient();
  const { data: grant, error: grantError } = await admin
    .from("access_requests")
    .select("id,email,status,password_email_sent_at,onboarding_completed_at")
    .eq("invited_user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();

  if (grantError) return NextResponse.json({ error: "grant_lookup_failed" }, { status: 500 });
  if (!grant) return NextResponse.json({ error: "approved_access_grant_required" }, { status: 403 });
  if (grant.onboarding_completed_at) return NextResponse.json({ completed: true });
  if (grant.password_email_sent_at) return NextResponse.json({ sent: true, alreadySent: true });

  const { error: emailError } = await admin.auth.resetPasswordForEmail(grant.email, {
    redirectTo: `${getAppUrl()}/auth/set-password?mode=onboarding`
  });
  if (emailError) return NextResponse.json({ error: "password_email_failed" }, { status: 502 });

  const { error: updateError } = await admin
    .from("access_requests")
    .update({ password_email_sent_at: new Date().toISOString() })
    .eq("id", grant.id)
    .is("password_email_sent_at", null);
  if (updateError) return NextResponse.json({ error: "password_email_state_failed" }, { status: 500 });

  return NextResponse.json({ sent: true });
}
