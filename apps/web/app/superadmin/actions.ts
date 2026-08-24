"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import {
  grantAccessRequestById,
  reviewAccessRequestById,
  type AccessReviewDecision
} from "../../lib/superadmin/access-requests";

async function requireSuperadmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");
  return supabase;
}

function revalidateApplicationPaths(targetId: string) {
  revalidatePath("/superadmin");
  revalidatePath("/superadmin/applications");
  revalidatePath(`/superadmin/applications/${targetId}`);
}

export async function reviewAccessRequest(formData: FormData) {
  const supabase = await requireSuperadmin();
  const targetId = String(formData.get("requestId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId) || !["reviewing", "rejected"].includes(decision)) throw new Error("invalid_access_review");

  await reviewAccessRequestById(supabase, targetId, decision as AccessReviewDecision);
  revalidateApplicationPaths(targetId);
}

export async function grantAccess(formData: FormData) {
  const supabase = await requireSuperadmin();
  const targetId = String(formData.get("requestId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new Error("invalid_access_request");

  await grantAccessRequestById(supabase, targetId);
  revalidateApplicationPaths(targetId);
}

export async function enqueueOperation(formData: FormData) {
  const supabase = await requireSuperadmin();
  const queue = String(formData.get("queue") ?? "");
  const resource = String(formData.get("resource") ?? "").trim();
  const allowed = new Set(["knowledge-ingestion", "repository-index", "eval", "training", "gpu-reconcile", "rollback"]);
  if (!allowed.has(queue) || !resource || resource.length > 2048) throw new Error("invalid_operation");
  const operationKey = `${queue}:${resource}`;
  const { error } = await supabase.rpc("superadmin_enqueue_operation", {
    target_queue: queue,
    operation_payload: { resource, requestedAt: new Date().toISOString() },
    operation_key: operationKey
  });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin");
}

export async function setModelAlias(formData: FormData) {
  const supabase = await requireSuperadmin();
  const alias = String(formData.get("alias") ?? "");
  const modelVersionId = String(formData.get("modelVersionId") ?? "");
  const allowedAliases = new Set(["general-prod", "code-prod", "lab-prod", "research-prod", "reasoner-prod", "verifier-prod"]);
  if (!allowedAliases.has(alias) || !/^[0-9a-f-]{36}$/i.test(modelVersionId)) throw new Error("invalid_model_alias_change");

  const { error } = await supabase.rpc("superadmin_set_model_alias", {
    target_alias: alias,
    target_model_version_id: modelVersionId
  });
  if (error) throw new Error(error.message);
  revalidatePath("/superadmin");
  revalidatePath("/dashboard");
}
