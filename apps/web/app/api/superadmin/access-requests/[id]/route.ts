import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import {
  grantAccessRequestById,
  reviewAccessRequestById,
  type AccessGrantMode
} from "../../../../../lib/superadmin/access-requests";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function redirectTo(request: Request, target: string) {
  const response = NextResponse.redirect(new URL(target, request.url), 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

function revalidateApplicationPaths(targetId: string) {
  revalidatePath("/superadmin");
  revalidatePath("/superadmin/applications");
  revalidatePath(`/superadmin/applications/${targetId}`);
  revalidatePath("/superadmin/manage");
}

function accessGrantFromForm(form: FormData) {
  const mode = String(form.get("access_mode") ?? "paid") as AccessGrantMode;
  if (!new Set<AccessGrantMode>(["paid", "free", "trial"]).has(mode)) throw new Error("access_mode_not_allowed");
  if (mode !== "trial") return { mode };

  const trialDays = Number(form.get("trial_days") ?? 3);
  const trialTokenLimit = Number(form.get("trial_token_limit") ?? 100000);
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90) throw new Error("trial_days_invalid");
  if (!Number.isSafeInteger(trialTokenLimit) || trialTokenLimit < 1000 || trialTokenLimit > 1_000_000_000) throw new Error("trial_token_limit_invalid");
  return { mode, trialDays, trialTokenLimit };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  const { id } = await params;
  if (!uuidPattern.test(id)) return redirectTo(request, "/superadmin/applications?error=invalid_application");

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return redirectTo(request, `/sign-in?next=${encodeURIComponent(`/superadmin/applications/${id}`)}`);
  if (user.app_metadata.system_role !== "superadmin") return redirectTo(request, "/dashboard");

  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) {
    return redirectTo(request, "/verify-email");
  }

  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  try {
    if (action === "reviewing") {
      await reviewAccessRequestById(supabase, id, "reviewing");
      revalidateApplicationPaths(id);
      return redirectTo(request, `/superadmin/applications/${id}?updated=reviewing`);
    }

    if (action === "rejected") {
      await reviewAccessRequestById(supabase, id, "rejected");
      revalidateApplicationPaths(id);
      return redirectTo(request, `/superadmin/applications/${id}?updated=rejected`);
    }

    if (action === "approve") {
      const grant = accessGrantFromForm(form);
      const result = await grantAccessRequestById(supabase, id, requestUrl.origin, grant);
      revalidateApplicationPaths(id);
      const state = result.checkoutError ? "approved-billing-pending" : result.alreadyApproved ? "already-approved" : "approved";
      return redirectTo(request, `/superadmin/applications/${id}?updated=${state}`);
    }

    return redirectTo(request, `/superadmin/applications/${id}?error=invalid_action`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    console.error("access_request_admin_action_failed", { action, code });
    const reason = encodeURIComponent(code);
    return redirectTo(request, `/superadmin/applications/${id}?error=action_failed&reason=${reason}`);
  }
}
