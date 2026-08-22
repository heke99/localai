"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

async function requireSuperadmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!user || user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  return supabase;
}

export async function reviewAccessRequest(formData: FormData) {
  const supabase = await requireSuperadmin();
  const targetId = String(formData.get("requestId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId) || !["reviewing", "approved", "rejected"].includes(decision)) throw new Error("invalid_access_review");
  const { error } = await supabase.rpc("superadmin_review_access_request", { target_id: targetId, decision: decision as "reviewing" | "approved" | "rejected" });
  if (error) throw new Error(error.message);
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
