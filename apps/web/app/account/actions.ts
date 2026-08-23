"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

function uuid(value: FormDataEntryValue | null) {
  const text = String(value ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(text)) throw new Error("invalid_workspace_id");
  return text;
}

async function setAccountStatus(status: "active" | "paused") {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/sign-in");

  const { error } = await supabase.rpc("set_my_account_status", { target_status: status });
  if (error) throw new Error(error.message);

  // A paused account should not keep reusable refresh sessions on other devices.
  // Keep the current session so the user can see the paused state and resume it.
  if (status === "paused") {
    const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
    if (signOutError) throw new Error("account_paused_other_sessions_revoke_failed");
  }

  revalidatePath("/dashboard");
  revalidatePath("/account");
  revalidatePath("/account-paused");
}

async function requestSubscriptionAction(formData: FormData, action: "pause" | "resume") {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/sign-in");
  const workspaceId = uuid(formData.get("workspaceId"));
  const { error } = await supabase.rpc("request_my_subscription_action", {
    target_workspace_id: workspaceId,
    target_action: action
  });
  if (error) throw new Error(error.message);
  revalidatePath("/account");
  revalidatePath("/dashboard");
}

export async function pauseMyAccount() {
  await setAccountStatus("paused");
  redirect("/account-paused");
}

export async function resumeMyAccount() {
  await setAccountStatus("active");
  redirect("/dashboard?section=settings");
}

export async function pauseMySubscription(formData: FormData) {
  await requestSubscriptionAction(formData, "pause");
}

export async function resumeMySubscription(formData: FormData) {
  await requestSubscriptionAction(formData, "resume");
}
