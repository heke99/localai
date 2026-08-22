"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export async function signIn(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email.includes("@") || password.length < 8) redirect("/sign-in?error=credentials");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) redirect("/sign-in?error=credentials");

  if (data.user.app_metadata.system_role === "superadmin") {
    const { data: status } = await supabase.rpc("superadmin_email_step_up_status");
    if ((status as { locked_until?: string | null } | null)?.locked_until) redirect("/verify-email?error=locked");

    const { error: codeError } = await supabase.auth.reauthenticate();
    if (codeError) redirect("/verify-email?error=send");

    const { data: begun, error: beginError } = await supabase.rpc("superadmin_begin_email_step_up");
    if (beginError) redirect("/verify-email?error=send");
    const beginResult = begun as { started?: boolean; reason?: string } | null;
    if (!beginResult?.started) redirect(beginResult?.reason === "locked" ? "/verify-email?error=locked" : "/verify-email?error=send");

    redirect("/verify-email?sent=1");
  }

  redirect("/dashboard");
}
