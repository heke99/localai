"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { StripeClient } from "../../../lib/billing/stripe";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

async function requireSuperadmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");
  return { supabase, user };
}

function uuid(value: FormDataEntryValue | null) {
  const text = String(value ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(text)) throw new Error("invalid_uuid");
  return text;
}

export async function setAccountLifecycleStatus(formData: FormData) {
  const { supabase, user } = await requireSuperadmin();
  const userId = uuid(formData.get("userId"));
  const status = String(formData.get("status") ?? "");
  if (!new Set(["active", "paused"]).has(status)) throw new Error("invalid_account_status");

  const { error } = await supabase.rpc("superadmin_set_account_status", {
    target_user_id: userId,
    target_status: status
  });
  if (error) throw new Error(error.message);

  if (userId === user.id && status === "paused") {
    const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
    if (signOutError) throw new Error("superadmin_pause_other_sessions_revoke_failed");
    redirect("/account-paused");
  }

  revalidatePath("/superadmin");
  revalidatePath("/superadmin/manage");
  revalidatePath("/dashboard");
}

export async function setSubscriptionLifecycleAction(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const workspaceId = uuid(formData.get("workspaceId"));
  const action = String(formData.get("action") ?? "");
  if (!new Set(["pause", "resume"]).has(action)) throw new Error("invalid_subscription_action");

  const { error } = await supabase.rpc("request_my_subscription_action", {
    target_workspace_id: workspaceId,
    target_action: action
  });
  if (error) throw new Error(error.message);

  revalidatePath("/superadmin");
  revalidatePath("/superadmin/manage");
  revalidatePath("/account");
  revalidatePath("/dashboard");
}

export async function setOrganizationBillingAccess(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const organizationId = uuid(formData.get("organizationId"));
  const mode = String(formData.get("accessMode") ?? "");
  if (!new Set(["paid", "free", "trial"]).has(mode)) throw new Error("invalid_access_mode");

  const trialDays = mode === "trial" ? Number(formData.get("trialDays") ?? 3) : null;
  const trialTokenLimit = mode === "trial" ? Number(formData.get("trialTokenLimit") ?? 100000) : null;
  if (mode === "trial" && (!Number.isInteger(trialDays) || trialDays! < 1 || trialDays! > 90)) throw new Error("trial_days_invalid");
  if (mode === "trial" && (!Number.isSafeInteger(trialTokenLimit) || trialTokenLimit! < 1000 || trialTokenLimit! > 1_000_000_000)) throw new Error("trial_token_limit_invalid");

  const admin = createSupabaseAdminClient();
  const { data: current, error: currentError } = await admin
    .from("organization_subscriptions")
    .select("id,access_mode,status,provider_subscription_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (currentError) throw new Error(currentError.message);

  if (mode !== "paid" && current?.access_mode === "paid" && current.provider_subscription_id && current.status !== "canceled") {
    await StripeClient.fromEnv().cancelSubscription(current.provider_subscription_id);
    const { error: cancelStateError } = await admin.from("organization_subscriptions").update({
      status: "canceled",
      provider_status: "canceled",
      last_error_code: null,
      updated_at: new Date().toISOString()
    }).eq("id", current.id).eq("access_mode", "paid");
    if (cancelStateError) throw new Error(cancelStateError.message);
  }

  const { error } = await supabase.rpc("superadmin_configure_organization_access", {
    target_organization_id: organizationId,
    target_access_mode: mode,
    target_trial_days: trialDays,
    target_trial_token_limit: trialTokenLimit
  });
  if (error) throw new Error(error.message);

  revalidatePath("/superadmin");
  revalidatePath("/superadmin/manage");
  revalidatePath("/billing");
  revalidatePath("/dashboard");
}

export async function setMembershipStatus(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const organizationId = uuid(formData.get("organizationId"));
  const userId = uuid(formData.get("userId"));
  const status = String(formData.get("status") ?? "");
  if (!new Set(["active", "suspended"]).has(status)) throw new Error("invalid_membership_status");
  const { error } = await supabase.rpc("superadmin_set_membership_status", { target_organization_id: organizationId, target_user_id: userId, target_status: status });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin"); revalidatePath("/superadmin/manage");
}

export async function createPolicySet(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const organizationRaw = String(formData.get("organizationId") ?? "").trim();
  const organizationId = organizationRaw ? uuid(organizationRaw) : null;
  const key = String(formData.get("key") ?? "").trim().toLowerCase();
  const effect = String(formData.get("effect") ?? "");
  const action = String(formData.get("action") ?? "").trim();
  const resourcePattern = String(formData.get("resourcePattern") ?? "").trim();
  const conditionsRaw = String(formData.get("conditions") ?? "{}").trim() || "{}";
  let conditions: Record<string, unknown>;
  try { const parsed = JSON.parse(conditionsRaw) as unknown; if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not_object"); conditions = parsed as Record<string, unknown>; } catch { throw new Error("policy_conditions_must_be_json_object"); }
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key)) throw new Error("invalid_policy_key");
  if (!new Set(["allow", "deny"]).has(effect)) throw new Error("invalid_policy_effect");
  if (!action || action.length > 160 || !resourcePattern || resourcePattern.length > 1024) throw new Error("invalid_policy_rule");
  const { error } = await supabase.rpc("superadmin_create_policy_set", { target_organization_id: organizationId, target_key: key, target_effect: effect, target_action: action, target_resource_pattern: resourcePattern, target_conditions: conditions });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin"); revalidatePath("/superadmin/manage");
}

export async function setPolicyStatus(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const policySetId = uuid(formData.get("policySetId"));
  const status = String(formData.get("status") ?? "");
  if (!new Set(["draft", "registered", "verified", "production", "retired"]).has(status)) throw new Error("invalid_policy_status");
  const { error } = await supabase.rpc("superadmin_set_policy_status", { target_policy_set_id: policySetId, target_status: status });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin"); revalidatePath("/superadmin/manage");
}

export async function setGpuProviderEnabled(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const providerId = uuid(formData.get("providerId"));
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  const { error } = await supabase.rpc("superadmin_set_gpu_provider_enabled", { target_provider_id: providerId, target_enabled: enabled });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin"); revalidatePath("/superadmin/manage");
}

export async function enqueueSkillSync(formData: FormData) {
  const { supabase } = await requireSuperadmin();
  const resource = String(formData.get("resource") ?? "").trim();
  if (!resource || resource.length > 2048) throw new Error("invalid_skill_source");
  const { error } = await supabase.rpc("superadmin_enqueue_operation", { target_queue: "skill-sync", operation_payload: { resource, requestedAt: new Date().toISOString() }, operation_key: `skill-sync:${resource}` });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin"); revalidatePath("/superadmin/manage");
}
