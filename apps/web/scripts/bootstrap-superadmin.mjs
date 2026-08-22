import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "https://eaebyxwedmwhctoqrvji.supabase.co";
const secretKey = process.env.SUPABASE_SECRET_KEY;
const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
const appUrl = (process.env.APP_URL ?? "https://system.div3rsa.com").replace(/\/$/, "");

if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is required");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("SUPERADMIN_EMAIL is required and must be valid");

const supabase = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

const { data: usersPage, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw listError;

let user = usersPage.users.find((candidate) => candidate.email?.toLowerCase() === email) ?? null;

if (!user) {
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appUrl}/auth/set-password`,
    data: { bootstrap: "superadmin" }
  });
  if (error || !data.user) throw error ?? new Error("superadmin_invite_failed");
  user = data.user;
}

const { error: metadataError } = await supabase.auth.admin.updateUserById(user.id, {
  app_metadata: {
    ...(user.app_metadata ?? {}),
    system_role: "superadmin"
  }
});
if (metadataError) throw metadataError;

console.log(`Superadmin bootstrap prepared for ${email}. Complete the invite, set a password, then enroll MFA.`);
