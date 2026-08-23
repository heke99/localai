"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
