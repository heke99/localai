import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (entries) => {
        try { entries.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server Components cannot write cookies; proxy/route handlers refresh them. */ }
      }
    }
  });

  // Legacy server-side control pages previously asked Supabase Auth for an authenticator-app
  // AAL2 level. Privileged access now uses a session-bound email step-up instead. Keep this
  // compatibility adapter server-only so existing protected pages/RPC callers remain fail-closed
  // while the user-facing authentication flow no longer depends on TOTP or an authenticator app.
  const nativeGetAssurance = supabase.auth.mfa.getAuthenticatorAssuranceLevel.bind(supabase.auth.mfa);
  const mfa = supabase.auth.mfa as typeof supabase.auth.mfa & {
    getAuthenticatorAssuranceLevel: typeof supabase.auth.mfa.getAuthenticatorAssuranceLevel;
  };

  mfa.getAuthenticatorAssuranceLevel = (async () => {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user || user.app_metadata.system_role !== "superadmin") {
      return nativeGetAssurance();
    }

    const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
    if (stepUpError) return nativeGetAssurance();

    const verified = Boolean((stepUp as { verified?: boolean } | null)?.verified);
    return {
      data: {
        currentLevel: verified ? "aal2" : "aal1",
        nextLevel: "aal2",
        currentAuthenticationMethods: []
      },
      error: null
    } as Awaited<ReturnType<typeof nativeGetAssurance>>;
  }) as typeof mfa.getAuthenticatorAssuranceLevel;

  return supabase;
}
