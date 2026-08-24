import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppUrl } from "../app-url";
import { createSupabaseAdminClient } from "../supabase/admin";

export type AccessReviewDecision = "reviewing" | "rejected";

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

export async function grantAccessRequestById(supabase: SupabaseClient, targetId: string) {
  const { data: request, error: requestError } = await supabase
    .from("access_requests")
    .select("id,email,name,organization_name,status,invited_user_id,organization_id,workspace_id")
    .eq("id", targetId)
    .single();
  if (requestError || !request) throw new Error("access_request_not_found");
  if (request.status === "rejected") throw new Error("access_request_rejected");
  if (request.status === "approved" && request.invited_user_id && request.organization_id && request.workspace_id) {
    return { alreadyApproved: true };
  }

  if (request.status === "pending") {
    await reviewAccessRequestById(supabase, targetId, "reviewing");
  } else if (request.status !== "reviewing") {
    throw new Error("access_request_not_reviewable");
  }

  const admin = createSupabaseAdminClient();
  let invitedUserId = request.invited_user_id as string | null;
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

  if (invitedUserId) {
    const { data, error } = await admin.auth.admin.getUserById(invitedUserId);
    if (error || !data.user) throw new Error("invited_user_not_found");
    invitedUserMetadata = data.user.app_metadata ?? {};
  } else {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(request.email, {
      redirectTo: `${getAppUrl()}/auth/accepted`,
      data: {
        display_name: request.name,
        organization_name: request.organization_name ?? null,
        access_request_id: targetId
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

  const { error: metadataError } = await admin.auth.admin.updateUserById(invitedUserId, {
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

  const slug = organizationSlug(request.organization_name || request.name, invitedUserId);
  const { error: provisionError } = await supabase.rpc("superadmin_provision_access_grant", {
    target_id: targetId,
    target_user_id: invitedUserId,
    target_slug: slug
  });
  if (provisionError) {
    await rollbackCreatedInvite();
    throw new Error(provisionError.message);
  }

  return { alreadyApproved: false };
}
