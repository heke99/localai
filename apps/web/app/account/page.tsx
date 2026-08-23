import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { pauseMyAccount, pauseMySubscription, resumeMySubscription } from "./actions";

type SubscriptionSnapshot = {
  configured?: boolean;
  provider?: string | null;
  status?: string | null;
  requestedAction?: string | null;
  requestedAt?: string | null;
  pauseEffectiveAt?: string | null;
  currentPeriodEnd?: string | null;
};

function subscriptionLabel(status?: string | null) {
  const labels: Record<string,string> = {
    inactive: "Inaktivt",
    trialing: "Testperiod",
    active: "Aktivt",
    pause_requested: "Paus begärd",
    paused: "Pausat",
    resume_requested: "Återaktivering begärd",
    past_due: "Betalning försenad",
    canceled: "Avslutat"
  };
  return labels[status ?? ""] ?? status ?? "Okänt";
}

function dateText(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium" }).format(date) : null;
}

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/sign-in");

  const { data: profile } = await supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle();
  const { data: lifecycle, error: lifecycleError } = await supabase
    .from("profiles")
    .select("account_status,account_paused_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const lifecycleReady = !lifecycleError;
  const accountStatus = lifecycleReady ? String(lifecycle?.account_status ?? "active") : "active";
  if (accountStatus === "paused") redirect("/account-paused");

  const { data: workspaces } = await supabase.from("workspaces").select("id,name").order("created_at", { ascending: true }).limit(1);
  const workspace = workspaces?.[0] ?? null;

  let subscription: SubscriptionSnapshot = { configured: false, status: "inactive" };
  if (lifecycleReady && workspace) {
    const { data } = await supabase.rpc("my_subscription_snapshot", { target_workspace_id: workspace.id });
    if (data && typeof data === "object" && !Array.isArray(data)) subscription = data as SubscriptionSnapshot;
  }

  const isSuperadmin = user.app_metadata.system_role === "superadmin";
  const status = subscription.status ?? "inactive";
  const canPauseSubscription = Boolean(subscription.configured && ["active", "trialing"].includes(status));
  const canResumeSubscription = Boolean(subscription.configured && status === "paused");
  const subscriptionPending = ["pause_requested", "resume_requested"].includes(status);

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/dashboard">DIV3RSA</Link><div className="actions"><Link href="/dashboard?section=settings">Till dashboard</Link></div></nav>
    <section className="hero">
      <div className="eyebrow">Account & billing</div>
      <h1>Konto och abonnemang.</h1>
      <p className="lead">Alla livscykelåtgärder har ett tydligt tillstånd. En paus förstör aldrig projekt, chattar eller rättigheter, och en abonnemangspaus räknas inte som klar förrän betalprovidern har bekräftat den.</p>

      <div className="form">
        <div className="field"><span>Konto</span><strong>{profile?.display_name ?? user.email?.split("@")[0] ?? "Konto"}</strong><small>{user.email ?? ""}</small></div>
        <div className="field"><span>Status</span><strong>{accountStatus === "paused" ? "Pausat" : "Aktivt"}</strong><small>{lifecycleReady ? "Kontostatus styr åtkomst på databasskiktet." : "Lifecycle-migrationen är ännu inte aktiv i den här miljön."}</small></div>
        <div className="actions"><Link className="button" href="/auth/set-password?mode=change">Ändra lösenord</Link></div>
        {!isSuperadmin && lifecycleReady ? <form action={pauseMyAccount}>
          <button className="button" type="submit">Pausa konto</button>
          <p className="muted">Paus stoppar åtkomst men behåller projekt, chattar, integrationer och medlemskap för en exakt återaktivering.</p>
        </form> : isSuperadmin ? <p className="muted">Superadmin-kontot kan inte självpausas för att undvika administrativ lockout.</p> : null}
      </div>

      <div className="form">
        <div className="field"><span>Abonnemang</span><strong>{subscription.configured ? subscriptionLabel(status) : "Inget kopplat abonnemang"}</strong><small>{subscription.configured ? `Provider: ${subscription.provider ?? "okänd"}` : "När billing är kopplat visas providerbekräftad status här."}</small></div>
        {subscription.currentPeriodEnd ? <p className="muted">Nuvarande period slutar {dateText(subscription.currentPeriodEnd)}.</p> : null}
        {subscription.pauseEffectiveAt ? <p className="muted">Paus gäller från {dateText(subscription.pauseEffectiveAt)}.</p> : null}
        {subscriptionPending ? <p className="muted">Begäran är registrerad. UI visar inte “klart” förrän providern har bekräftat ändringen.</p> : null}
        {workspace && canPauseSubscription ? <form action={pauseMySubscription}><input type="hidden" name="workspaceId" value={workspace.id}/><button className="button" type="submit">Pausa abonnemang</button></form> : null}
        {workspace && canResumeSubscription ? <form action={resumeMySubscription}><input type="hidden" name="workspaceId" value={workspace.id}/><button className="button primary" type="submit">Återuppta abonnemang</button></form> : null}
      </div>
    </section>
  </main>;
}
