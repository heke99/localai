"use server";

import { redirect } from "next/navigation";
import { getAppUrl } from "../../lib/app-url";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!email.includes("@") || email.length > 320) {
    redirect("/forgot-password?error=invalid_email");
  }

  const supabase = await createSupabaseServerClient();

  // Deliberately do not expose whether an account exists for this address.
  // Supabase applies its Auth email rate limits to this endpoint.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${getAppUrl()}/auth/set-password?mode=recovery`
  });

  redirect("/forgot-password?sent=1");
}
