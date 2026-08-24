import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppUrl } from "../app-url";
import { StripeClient } from "../billing/stripe";
import { createSupabaseAdminClient } from "../supabase/admin";

export type AccessReviewDecision = "reviewing" | "rejected";
export type AccessGrantMode = "paid" | "free" | "trial";
export type AccessGrantOptions = {
  mode: AccessGrantMode;
  trialDays?: number | null;
  trialTokenLimit?: number | null;
};

function organizationSlug(value: string, userId: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  return `${normalized.slice(0, 50).replace(/-+$/g, "")}-${userId.slice(0, 8)}`;
}

export async function reviewAccessRequestById(
  supabase: SupabaseClient,
  targetId: string,
  decision: AccessReviewDecision
) {
  const { data: reviewed, error } = await supabase.rpc("superadmin_review_access_request", {
    target_id: targetId,
    decision
  });
  if (error) throw new Error(error.message);
  if (reviewed !== true) throw new Error("access_request_not_reviewable");
}

function normalizedGrantOptions(options?: AccessGrantOptions): AccessGrantOptions {
  const mode = options?.mode ?? "paid";
  if (!new Set<AccessGrantMode>(["paid", "free", "trial"]).has(mode)) throw new Error("access_mode_not_allowed");
  if (mode !== "trial") return { mode, trialDays: null, trialTokenLimit: null };
  const trialDays = Number(options?.trialDays ?? 3);
  const trialTokenLimit = Number(options?.trialTokenLimit ?? 100_000);
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90) throw new Error("trial_days_invalid");
  if (!Number.isSafeInteger(trialTokenLimit) || trialTokenLimit < 1000 || trialTokenLimit > 1_000_000_000) throw new Error("trial_token_limit_invalid");
  return { mode, trialDays, trialTokenLimit };
}

async function configureAccessAfterProvision(input: {
  supabase: SupabaseClient;
  targetId: string;
  userId: string;
  email: string;
  organizationId: string;
  appOrigin: string;
  options: AccessGrantOptions;
}) {
  const { supabase, targetId, userId, email, organizationId, appOrigin } = input;
  const options = normalizedGrantOptions(input.options);
  const admin = createSupabaseAdminClient();

  const { error: accessError } = await supabase.rpc("superadmin_configure_organization_access", {
    target_organization_id: organizationId,
    target_access_mode: options.mode,
    target_trial_days: options.mode === "trial" ? options.trialDays : null,
    target_trial_token_limit: options.mode === "trial" ? options.trialTokenLimit : null
  });
  if (accessError) throw new Error(accessError.message);

  let checkoutUrl: string | null = null;
  let checkoutSessionId: string | null = null;
  let checkoutError: string | null = null;

  if (options.mode === "paid") {
    try {
      const session = await StripeClient.fromEnv().createSubscriptionCheckout({
        email,
        organizationId,
        accessRequestId: targetId,
        appOrigin,
        idempotencyKey: `access-approval:${targetId}`
      });
      checkoutUrl = session.url ?? null;
      checkoutSessionId = session.id;

      const { error: subscriptionUpdateError } = await admin
        .from("organization_subscriptions")
        .update({ checkout_session_id: checkoutSessionId, checkout_url: checkoutUrl, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("access_mode", "paid");
      if (subscriptionUpdateError) throw new Error(subscriptionUpdateError.message);
    } catch (error) {
      checkoutError = error instanceof Error ? error.message : "stripe_checkout_failed";
      console.error("approved_access_checkout_creation_failed", { targetId, code: checkoutError });
    }
  }

  const { error: requestUpdateError } = await admin
    .from("access_requests")
    .update({
      access_mode: options.mode,
      trial_days: options.mode === "trial" ? options.trialDays : null,
      trial_token_limit: options.mode === "trial" ? options.trialTokenLimit : null,
      billing_checkout_session_id: checkoutSessionId,
      billing_checkout_url: checkoutUrl,
      billing_configured_at: new Date().toISOString()
    })
    .eq("id", targetId);
  if (requestUpdateError) throw new Error(requestUpdateError.message);

  const { data: currentUser } = await admin.auth.admin.getUserById(userId);
  const currentMetadata = currentUser.user?.user_metadata ?? {};
  const { error: userMetadataError } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...currentMetadata,
      billing_access_mode: options.mode,
      billing_checkout_url: checkoutUrl,
      trial_days: options.mode === "trial" ? options.trialDays : null,
      trial_token_limit: options.mode === "trial" ? options.trialTokenLimit : null
    }
  });
  if (userMetadataError) throw new Error(userMetadataError.message);

  return { accessMode: options.mode, checkoutUrl, checkoutSessionId, checkoutError };
}

export async function grantAccessRequestById(
  supabase: SupabaseClient,
  targetId: string,
  appOrigin = getAppUrl(),
  grantOptions: AccessGrantOptions = { mode: "paid" }
) {
  const options = normalizedGrantOptions(grantOptions);
  const { data: request, error: requestError } = await supabase
    .from("access_requests")
    .select("id,email,name,organization_name,status,invited_user_id,organization_id,workspace_id")
    .eq("id", targetId)
    .single();
  if (requestError || !request) throw new Error("access_request_not_found");
  if (request.status === "rejected") throw new Error("access_request_rejected");

  const admin = createSupabaseAdminClient();
  let invitedUserId = request.invited_user_id as string | null;
  let organizationId = request.organization_id as string | null;
  let workspaceId = request.workspace_id as string | null;
  let alreadyApproved = request.status === "approved" && Boolean(invitedUserId && organizationId && workspaceId);
  let invitedUserMetadata: Record<string, unknown> = {};
  let createdInviteUser = false;

  const rollbackCreatedInvite = async () => {
    if (!createdInviteUser || !invitedUserId) return;
    const rollbackUserId = invitedUserId;
    await admin
      .from("access_requests")
      .update({ invited_user_id: null, invited_at: null })
      .eq("id", targetId)
      .eq("invited_user_id", rollbackUserId)
      .eq("status", "reviewing");
    await admin.auth.admin.deleteUser(rollbackUserId);
  };

  if (!alreadyApproved) {
    if (request.status === "pending") {
      await reviewAccessRequestById(supabase, targetId, "reviewing");
    } else if (request.status !== "reviewing") {
      throw new Error("access_request_not_reviewable");
    }

    if (invitedUserId) {
      const { data, error } = await admin.auth.admin.getUserById(invitedUserId);
      if (error || !data.user) throw new Error("invited_user_not_found");
      invitedUserMetadata = data.user.app_metadata ?? {};
    } else {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(request.email, {
        redirectTo: `${appOrigin.replace(/\/$/, "")}/auth/accepted`,
        data: {
          display_name: request.name,
          organization_name: request.organization_name ?? null,
          access_request_id: targetId,
          billing_access_mode: options.mode
        }
      });
      if (error || !data.user) throw new Error(error?.message ?? "invite_email_failed");

      invitedUserId = data.user.id;
      invitedUserMetadata = data.user.app_metadata ?? {};
      createdInviteUser = true;

      const { data: association, error: associationError } = await admin
        .from("access_requests")
        .update({ invited_user_id: invitedUserId, invited_at: new Date().toISOString() })
        .eq("id", targetId)
        .eq("status", "reviewing")
        .is("invited_user_id", null)
        .select("id")
        .maybeSingle();

      if (associationError || !association) {
        await rollbackCreatedInvite();
        throw new Error(associationError?.message ?? "access_request_invite_race");
      }
    }

    const { error: metadataError } = await admin.auth.admin.updateUserById(invitedUserId!, {
      app_metadata: {
        ...invitedUserMetadata,
        system_role: "user",
        onboarding_access_request_id: targetId
      }
    });
    if (metadataError) {
      await rollbackCreatedInvite();
      throw new Error(metadataError.message);
    }

    const slug = organizationSlug(request.organization_name || request.name, invitedUserId!);
    const { error: provisionError } = await supabase.rpc("superadmin_provision_access_grant", {
      target_id: targetId,
      target_user_id: invitedUserId,
      target_slug: slug
    });
    if (provisionError) {
      await rollbackCreatedInvite();
      throw new Error(provisionError.message);
    }

    const { data: provisioned, error: provisionedError } = await admin
      .from("access_requests")
      .select("organization_id,workspace_id")
      .eq("id", targetId)
      .single();
    if (provisionedError || !provisioned?.organization_id || !provisioned?.workspace_id) throw new Error("access_grant_provision_result_missing");
    organizationId = provisioned.organization_id;
    workspaceId = provisioned.workspace_id;
  }

  if (!invitedUserId || !organizationId || !workspaceId) throw new Error("approved_access_grant_incomplete");

  const billing = await configureAccessAfterProvision({
    supabase,
    targetId,
    userId: invitedUserId,
    email: request.email,
    organizationId,
    appOrigin,
    options
  });

  return { alreadyApproved, organizationId, workspaceId, ...billing };
}
