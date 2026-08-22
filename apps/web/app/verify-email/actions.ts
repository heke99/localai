"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

type StepUpResult = {
  verified?: boolean;
  reason?: "invalid_code" | "expired" | "locked" | "not_authorized";
  remaining_attempts?: number;
};

async function requirePrivilegedSession() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  return supabase;
}

export async function sendVerificationCode() {
  const supabase = await requirePrivilegedSession();
  const { data: status } = await supabase.rpc("superadmin_email_step_up_status");
  if ((status as { verified?: boolean } | null)?.verified) redirect("/superadmin");

  const { error } = await supabase.auth.reauthenticate();
  if (error) redirect("/verify-email?error=send");
  redirect("/verify-email?sent=1");
}

export async function verifyEmailCode(formData: FormData) {
  const supabase = await requirePrivilegedSession();
  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  if (code.length !== 6) redirect("/verify-email?error=invalid_code");

  const { data, error } = await supabase.rpc("superadmin_verify_email_code", { code });
  if (error) redirect("/verify-email?error=verification_failed");

  const result = (data ?? {}) as StepUpResult;
  if (result.verified) redirect("/superadmin");

  if (result.reason === "locked") redirect("/verify-email?error=locked");
  if (result.reason === "expired") redirect("/verify-email?error=expired");
  if (result.reason === "not_authorized") redirect("/sign-in");

  const attempts = Number.isInteger(result.remaining_attempts) ? `&remaining=${result.remaining_attempts}` : "";
  redirect(`/verify-email?error=invalid_code${attempts}`);
}
