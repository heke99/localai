import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { resumeMyAccount } from "../account/actions";

export default async function AccountPausedPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/sign-in");

  const { data: lifecycle, error: lifecycleError } = await supabase
    .from("profiles")
    .select("account_status,account_paused_at")
    .eq("user_id", user.id)
    .maybeSingle();

  // Backward-compatible during rolling deploys: if the lifecycle schema is not
  // active yet, never strand the user on the paused screen.
  if (lifecycleError || lifecycle?.account_status !== "paused") redirect("/dashboard");

  const pausedAt = lifecycle.account_paused_at
    ? new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(lifecycle.account_paused_at))
    : null;

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Account paused</div>
      <h1>Ditt konto är pausat.</h1>
      <p className="lead">Projekt, chattar, integrationer och behörigheter ligger kvar oförändrade. Agentkörningar och workspace-åtkomst är blockerade tills kontot återaktiveras.</p>
      {pausedAt ? <p className="muted">Pausat {pausedAt}.</p> : null}
      <form className="form" action={resumeMyAccount}>
        <button className="button primary" type="submit">Återaktivera konto</button>
      </form>
      <div className="actions"><form action="/auth/signout" method="post"><button className="button" type="submit">Logga ut</button></form></div>
    </section>
  </main>;
}
