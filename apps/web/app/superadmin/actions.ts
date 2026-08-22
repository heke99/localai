"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppUrl } from "../../lib/app-url";
import { createSupabaseAdminClient } from "../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../lib/supabase/server";

async function requireSuperadmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!user || user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  return supabase;
}

function organizationSlug(value: string, userId: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  return `${normalized.slice(0, 50).replace(/-+$/g, "")}-${userId.slice(0, 8)}`;
}

export async function reviewAccessRequest(formData: FormData) {
  const supabase = await requireSuperadmin();
  const targetId = String(formData.get("requestId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId) || !["reviewing", "rejected"].includes(decision)) throw new Error("invalid_access_review");
  const { error } = await supabase.rpc("superadmin_review_access_request", { target_id: targetId, decision: decision as "reviewing" | "rejected" });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin");
}

export async function grantAccess(formData: FormData) {
  const supabase = await requireSuperadmin();
  const targetId = String(formData.get("requestId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new Error("invalid_access_request");

  const { data: request, error: requestError } = await supabase
    .from("access_requests")
    .select("id,email,name,organization_name,status,invited_user_id,organization_id,workspace_id")
    .eq("id", targetId)
    .single();
  if (requestError || !request) throw new Error("access_request_not_found");
  if (request.status === "rejected") throw new Error("access_request_rejected");
  if (request.status === "approved" && request.invited_user_id && request.organization_id && request.workspace_id) {
    revalidatePath("/superadmin");
    return;
  }

  if (request.status === "pending") {
    const { error: reviewingError } = await supabase.rpc("superadmin_review_access_request", { target_id: targetId, decision: "reviewing" });
    if (reviewingError) throw new Error(reviewingError.message);
  }

  const admin = createSupabaseAdminClient();
  let invitedUserId = request.invited_user_id as string | null;
  let invitedUserMetadata: Record<string, unknown> = {};

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

    const { error: associationError } = await admin
      .from("access_requests")
      .update({ invited_user_id: invitedUserId, invited_at: new Date().toISOString() })
      .eq("id", targetId)
      .is("invited_user_id", null);
    if (associationError) throw new Error(associationError.message);
  }

  const { error: metadataError } = await admin.auth.admin.updateUserById(invitedUserId, {
    app_metadata: {
      ...invitedUserMetadata,
      system_role: "user",
      onboarding_access_request_id: targetId
    }
  });
  if (metadataError) throw new Error(metadataError.message);

  const slug = organizationSlug(request.organization_name || request.name, invitedUserId);
  const { error: provisionError } = await supabase.rpc("superadmin_provision_access_grant", {
    target_id: targetId,
    target_user_id: invitedUserId,
    target_slug: slug
  });
  if (provisionError) throw new Error(provisionError.message);

  revalidatePath("/superadmin");
}

export async function enqueueOperation(formData: FormData) {
  const supabase = await requireSuperadmin();
  const queue = String(formData.get("queue") ?? "");
  const resource = String(formData.get("resource") ?? "").trim();
  const allowed = new Set(["knowledge-ingestion", "repository-index", "eval", "training", "gpu-reconcile", "rollback"]);
  if (!allowed.has(queue) || !resource || resource.length > 2048) throw new Error("invalid_operation");
  const operationKey = `${queue}:${resource}`;
  const { error } = await supabase.rpc("superadmin_enqueue_operation", { target_queue: queue, operation_payload: { resource, requestedAt: new Date().toISOString() }, operation_key: operationKey });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin");
}
