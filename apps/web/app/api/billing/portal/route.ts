import { NextResponse } from "next/server";
import { StripeClient } from "../../../../lib/billing/stripe";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

function redirectTo(request: Request, target: string) {
  const response = NextResponse.redirect(new URL(target, request.url), 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return redirectTo(request, "/sign-in?next=/billing");
  if (user.app_metadata.system_role === "superadmin") return redirectTo(request, "/dashboard");

  const { data: workspaces } = await supabase.from("workspaces").select("id,organization_id").order("created_at", { ascending: true }).limit(1);
  if (!workspaces?.[0]) return redirectTo(request, "/billing?error=workspace");

  const admin = createSupabaseAdminClient();
  const { data: subscription } = await admin
    .from("organization_subscriptions")
    .select("provider_customer_id,access_mode")
    .eq("organization_id", workspaces[0].organization_id)
    .maybeSingle();
  if (!subscription || subscription.access_mode !== "paid" || !subscription.provider_customer_id) return redirectTo(request, "/billing?error=portal");

  try {
    const session = await StripeClient.fromEnv().createCustomerPortal(subscription.provider_customer_id, `${requestUrl.origin}/billing`);
    const response = NextResponse.redirect(session.url, 303);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    console.error("billing_portal_create_failed", { code: error instanceof Error ? error.message : "unknown" });
    return redirectTo(request, "/billing?error=portal");
  }
}
