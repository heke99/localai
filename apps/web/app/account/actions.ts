"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

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

export async function pauseMyAccount() {
  await setAccountStatus("paused");
  redirect("/account-paused");
}

export async function resumeMyAccount() {
  await setAccountStatus("active");
  redirect("/dashboard?section=settings");
}
