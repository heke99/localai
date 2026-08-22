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
    const { error: codeError } = await supabase.auth.reauthenticate();
    redirect(codeError ? "/verify-email?error=send" : "/verify-email?sent=1");
  }

  redirect("/dashboard");
}
