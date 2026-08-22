import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { MfaForm } from "./mfa-form";

export default async function MfaPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance?.currentLevel === "aal2") redirect("/dashboard");
  return <main className="shell"><section className="hero"><div className="eyebrow">Security check</div><h1>Verify MFA.</h1><p className="lead">Ange den sexsiffriga koden från din autentiseringsapp.</p><MfaForm /></section></main>;
}
