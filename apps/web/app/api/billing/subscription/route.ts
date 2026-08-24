import { NextResponse } from "next/server";
import { StripeClient } from "../../../../lib/billing/stripe";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type SubscriptionAction = "pause" | "resume" | "cancel" | "disable_auto_renew" | "reactivate";
type RequestResult = {
  changed?: boolean;
  subscriptionId?: string;
  providerSubscriptionId?: string;
};

const allowedActions = new Set<SubscriptionAction>(["pause", "resume", "cancel", "disable_auto_renew", "reactivate"]);
const allowedReasons = new Set(["too_expensive", "missing_features", "unused", "switched_service", "customer_service", "low_quality", "too_complex", "other"]);

function redirectTo(request: Request, target: string) {
  const response = NextResponse.redirect(new URL(target, request.url), 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

async function clearFailedRequest(subscriptionId: string | undefined, action: SubscriptionAction, code: string) {
  if (!subscriptionId) return;
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();

  if (action === "pause" || action === "resume") {
    await admin.from("organization_subscriptions").update({
      requested_action: null,
      requested_by: null,
      requested_at: null,
      last_error_code: code,
      updated_at: now
    }).eq("id", subscriptionId).eq("requested_action", action);
    return;
  }

  await admin.from("organization_subscriptions").update({
    renewal_action_requested: null,
    renewal_action_requested_at: null,
    renewal_action_requested_by: null,
    last_error_code: code,
    updated_at: now
  }).eq("id", subscriptionId).eq("renewal_action_requested", action);
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return redirectTo(request, "/sign-in?next=/billing");
  if (user.app_metadata.system_role === "superadmin") return redirectTo(request, "/dashboard");

  const form = await request.formData();
  const rawAction = String(form.get("action") ?? "").trim().toLowerCase();
  if (!allowedActions.has(rawAction as SubscriptionAction)) return redirectTo(request, "/billing?error=invalid_action");
  const action = rawAction as SubscriptionAction;

  const rawReason = String(form.get("reason") ?? "").trim().toLowerCase();
  const reason = rawReason && allowedReasons.has(rawReason) ? rawReason : null;

  const { data: workspaces, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1);
  if (workspaceError || !workspaces?.[0]) return redirectTo(request, "/billing?error=workspace");
  const workspaceId = workspaces[0].id;

  let requestResult: RequestResult;
  try {
    if (action === "pause" || action === "resume") {
      const { data, error } = await supabase.rpc("request_my_subscription_action", {
        target_workspace_id: workspaceId,
        target_action: action
      });
      if (error) throw new Error(error.message);
      requestResult = (data ?? {}) as RequestResult;
    } else {
      const { data, error } = await supabase.rpc("request_my_subscription_renewal_action", {
        target_workspace_id: workspaceId,
        target_action: action,
        target_reason: action === "cancel" ? reason : null
      });
      if (error) throw new Error(error.message);
      requestResult = (data ?? {}) as RequestResult;
    }
  } catch (error) {
    console.error("billing_subscription_request_rejected", { action, code: error instanceof Error ? error.message : "unknown" });
    return redirectTo(request, "/billing?error=action_not_allowed");
  }

  if (!requestResult.changed) return redirectTo(request, `/billing?action=${encodeURIComponent(`${action}_unchanged`)}`);
  if (!requestResult.providerSubscriptionId) {
    await clearFailedRequest(requestResult.subscriptionId, action, "provider_subscription_missing");
    return redirectTo(request, "/billing?error=subscription");
  }

  try {
    const stripe = StripeClient.fromEnv();
    if (action === "pause") await stripe.pauseSubscription(requestResult.providerSubscriptionId);
    else if (action === "resume") await stripe.resumeSubscription(requestResult.providerSubscriptionId);
    else if (action === "reactivate") await stripe.setCancelAtPeriodEnd(requestResult.providerSubscriptionId, false);
    else await stripe.setCancelAtPeriodEnd(requestResult.providerSubscriptionId, true);

    return redirectTo(request, `/billing?action=${encodeURIComponent(`${action}_requested`)}`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "stripe_request_failed";
    console.error("billing_subscription_provider_update_failed", { action, code });
    await clearFailedRequest(requestResult.subscriptionId, action, code);
    return redirectTo(request, "/billing?error=provider_update_failed");
  }
}
