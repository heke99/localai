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

  const { data: workspaces, error: workspaceError } = await supabase.from("workspaces").select("id,organization_id").order("created_at", { ascending: true }).limit(1);
  if (workspaceError || !workspaces?.[0]) return redirectTo(request, "/billing?error=workspace");
  const workspace = workspaces[0];

  const admin = createSupabaseAdminClient();
  const { data: subscription, error: subscriptionError } = await admin
    .from("organization_subscriptions")
    .select("id,access_mode,status,checkout_session_id")
    .eq("organization_id", workspace.organization_id)
    .maybeSingle();
  if (subscriptionError || !subscription) return redirectTo(request, "/billing?error=subscription");
  if (subscription.access_mode !== "paid") return redirectTo(request, "/billing?error=admin_required");
  if (["active", "trialing"].includes(subscription.status)) return redirectTo(request, "/dashboard");

  try {
    const session = await StripeClient.fromEnv().createSubscriptionCheckout({
      email: user.email ?? "",
      organizationId: workspace.organization_id,
      appOrigin: requestUrl.origin,
      idempotencyKey: `billing-checkout:${workspace.organization_id}:${subscription.checkout_session_id ?? "new"}`
    });

    const { error: updateError } = await admin.from("organization_subscriptions").update({
      checkout_session_id: session.id,
      checkout_url: session.url,
      updated_at: new Date().toISOString()
    }).eq("id", subscription.id).eq("access_mode", "paid");
    if (updateError) throw new Error(updateError.message);

    const currentMetadata = user.user_metadata ?? {};
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...currentMetadata, billing_access_mode: "paid", billing_checkout_url: session.url }
    });

    const response = NextResponse.redirect(session.url!, 303);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    console.error("billing_checkout_create_failed", { code: error instanceof Error ? error.message : "unknown" });
    return redirectTo(request, "/billing?error=checkout");
  }
}
