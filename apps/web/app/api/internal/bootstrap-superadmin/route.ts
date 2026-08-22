import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAppUrl } from "../../../../lib/app-url";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";

const SUPERADMIN_EMAIL = "hekmat.h@div3rsa.com";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (token.length < 40 || token.length > 256) {
    return NextResponse.json({ error: "bootstrap_not_authorized" }, { status: 401 });
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return NextResponse.json({ error: "admin_configuration_missing" }, { status: 503 });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  let invitedUserId: string | null = null;
  let createdUser = false;

  try {
    const { data: usersPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (listError) throw listError;

    let user = usersPage.users.find((candidate) => candidate.email?.toLowerCase() === SUPERADMIN_EMAIL);

    if (!user) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(SUPERADMIN_EMAIL, {
        redirectTo: `${getAppUrl()}/auth/set-password`,
        data: {
          display_name: "Hekmat",
          account_type: "initial_superadmin"
        }
      });
      if (error || !data.user) throw error ?? new Error("superadmin_invite_failed");
      user = data.user;
      createdUser = true;
    }

    invitedUserId = user.id;
    const { error: bootstrapError } = await admin.rpc("bootstrap_initial_superadmin", {
      provided_token_hash: tokenHash,
      target_user_id: user.id,
      target_email: SUPERADMIN_EMAIL
    });
    if (bootstrapError) throw bootstrapError;

    return NextResponse.json({ ok: true, email: SUPERADMIN_EMAIL, invite_sent: createdUser });
  } catch (error) {
    if (createdUser && invitedUserId) {
      await admin.auth.admin.deleteUser(invitedUserId).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "bootstrap_failed";
    return NextResponse.json({ error: message.includes("invalid_or_expired") ? "bootstrap_not_authorized" : "bootstrap_failed" }, { status: message.includes("invalid_or_expired") ? 401 : 500 });
  }
}
