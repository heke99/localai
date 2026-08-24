import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

type AccessSnapshot = {
  allowed?: boolean;
  accessMode?: "paid" | "free" | "trial" | "superadmin";
  status?: string;
  requiresPayment?: boolean;
  priceSekMonthly?: number;
  checkoutUrl?: string | null;
  trialEndsAt?: string | null;
  trialTokenLimit?: number | null;
  trialTokensUsed?: number | null;
  trialTokensRemaining?: number | null;
  currentPeriodEnd?: string | null;
  providerCustomerId?: string | null;
};

type ManagementSnapshot = {
  configured?: boolean;
  canManage?: boolean;
  provider?: string | null;
  providerSubscriptionId?: string | null;
  status?: string;
  providerStatus?: string | null;
  requestedAction?: "pause" | "resume" | null;
  requestedAt?: string | null;
  pauseEffectiveAt?: string | null;
  pauseCollectionBehavior?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  autoRenew?: boolean;
  terminationIntent?: "cancel" | "auto_renew_off" | null;
  renewalActionRequested?: "cancel" | "disable_auto_renew" | "reactivate" | null;
  renewalActionRequestedAt?: string | null;
  cancellationReason?: string | null;
  canceledAt?: string | null;
  lastErrorCode?: string | null;
};

type SearchParams = Promise<{ checkout?: string; error?: string; action?: string; confirm?: string }>;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "long" }).format(date);
}

function actionNotice(action?: string) {
  if (!action) return null;
  if (action === "pause_requested") return "Pausen är skickad till Stripe. Agentåtkomsten stängs först när Stripe har bekräftat ändringen.";
  if (action === "resume_requested") return "Återupptagningen är skickad till Stripe. Åtkomsten öppnas när Stripe har bekräftat ändringen.";
  if (action === "cancel_requested") return "Uppsägningen är skickad till Stripe. Abonnemanget fortsätter till periodslut när Stripe har bekräftat den.";
  if (action === "disable_auto_renew_requested") return "Avstängning av automatisk förnyelse är skickad till Stripe.";
  if (action === "reactivate_requested") return "Återaktiveringen är skickad till Stripe. Automatisk förnyelse slås på när Stripe bekräftar ändringen.";
  if (action.endsWith("_unchanged")) return "Ingen ändring behövdes. Abonnemanget har redan den begärda inställningen.";
  return null;
}

function pendingActionLabel(management: ManagementSnapshot) {
  if (management.requestedAction === "pause") return "Paus inväntar Stripe-bekräftelse";
  if (management.requestedAction === "resume") return "Återupptagning inväntar Stripe-bekräftelse";
  if (management.renewalActionRequested === "cancel") return "Uppsägning inväntar Stripe-bekräftelse";
  if (management.renewalActionRequested === "disable_auto_renew") return "Auto-renew av inväntar Stripe-bekräftelse";
  if (management.renewalActionRequested === "reactivate") return "Återaktivering inväntar Stripe-bekräftelse";
  return null;
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/sign-in?next=/billing");
  if (user.app_metadata.system_role === "superadmin") redirect("/dashboard");

  const { data: workspaces, error: workspaceError } = await supabase.from("workspaces").select("id,name").order("created_at", { ascending: true }).limit(1);
  if (workspaceError || !workspaces?.[0]) redirect("/auth/accepted");
  const workspace = workspaces[0];

  const [{ data: accessData, error: accessError }, { data: managementData, error: managementError }] = await Promise.all([
    supabase.rpc("my_agent_access_snapshot", { target_workspace_id: workspace.id }),
    supabase.rpc("my_subscription_management_snapshot", { target_workspace_id: workspace.id })
  ]);
  if (accessError) throw new Error(accessError.message);
  if (managementError) console.warn("subscription_management_snapshot_unavailable", { code: managementError.message });

  const access = (accessData ?? {}) as AccessSnapshot;
  const management = (managementData ?? {}) as ManagementSnapshot;
  const status = management.status ?? access.status ?? "inactive";
  const paid = access.accessMode === "paid";
  const trial = access.accessMode === "trial";
  const free = access.accessMode === "free";
  const activePaid = paid && ["active", "trialing"].includes(status);
  const pausedPaid = paid && status === "paused";
  const needsPayment = paid && ["inactive", "canceled"].includes(status);
  const trialExhausted = trial && !access.allowed && (access.trialTokensRemaining ?? 0) <= 0;
  const trialExpired = trial && !access.allowed && Boolean(access.trialEndsAt) && new Date(access.trialEndsAt!).getTime() <= Date.now();
  const canManage = paid && Boolean(management.canManage) && Boolean(management.providerSubscriptionId);
  const cancelAtPeriodEnd = Boolean(management.cancelAtPeriodEnd);
  const periodEnd = management.currentPeriodEnd ?? access.currentPeriodEnd;
  const pendingLabel = pendingActionLabel(management);
  const notice = actionNotice(query.action);
  const priceSekMonthly = access.priceSekMonthly ?? 2000;

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link><Link href="/dashboard">Dashboard</Link></nav>
    <section className="hero" style={{ maxWidth: 860 }}>
      <div className="eyebrow">Subscription & billing</div>
      <h1>Ditt abonnemang.</h1>
      <p className="lead">Hantera plan, betalning, paus och förnyelse för {workspace.name}.</p>

      {query.checkout === "success" ? <div className="card" role="status"><strong>Betalningen behandlas.</strong><p>Stripe bekräftar abonnemanget via webhook. Åtkomsten öppnas automatiskt när betalningen är bekräftad.</p></div> : null}
      {query.checkout === "canceled" ? <div className="card" role="status"><strong>Betalningen avbröts.</strong><p>Inget abonnemang har aktiverats. Du kan starta betalningen igen när du vill.</p></div> : null}
      {notice ? <div className="card" role="status"><strong>Ändringen behandlas.</strong><p>{notice}</p></div> : null}
      {query.error ? <p className="error" role="alert">Billing-åtgärden kunde inte slutföras. Ingen provider-bekräftad abonnemangsstatus ändrades. Försök igen eller kontakta administratören.</p> : null}

      <div className="card">
        <strong>{free ? "Fri åtkomst" : trial ? "Trial" : pausedPaid ? "Pausat abonnemang" : activePaid ? "Aktivt abonnemang" : "DIV3RSA"}</strong>
        {free ? <p>Din åtkomst är administratörsgodkänd och kräver ingen betalning.</p> : null}
        {trial ? <>
          <p>Trial gäller till {formatDate(access.trialEndsAt)}.</p>
          <p><strong>{Math.max(access.trialTokensRemaining ?? 0, 0).toLocaleString("sv-SE")}</strong> av {(access.trialTokenLimit ?? 0).toLocaleString("sv-SE")} tokens återstår.</p>
          {trialExpired ? <p className="error">Trial-perioden har gått ut.</p> : null}
          {trialExhausted ? <p className="error">Trialens tokenbudget är förbrukad.</p> : null}
        </> : null}
        {paid ? <>
          <p><strong>{priceSekMonthly.toLocaleString("sv-SE")} kr/mån exkl. moms.</strong> Stripe beräknar tillämplig moms automatiskt utifrån kundens land och skatteuppgifter.</p>
          {periodEnd && !cancelAtPeriodEnd ? <p>Nästa period börjar efter {formatDate(periodEnd)}.</p> : null}
          {pausedPaid ? <p>Agentåtkomsten och abonnemangsdebiteringen är pausade. Konto, projekt och historik ligger kvar.</p> : null}
          {status === "past_due" ? <p className="error">Betalningen kunde inte genomföras. Agentåtkomsten är pausad tills betalningen är löst.</p> : null}
          {status === "canceled" ? <p className="error">Abonnemanget är avslutat.</p> : null}
          {cancelAtPeriodEnd ? <div style={{ marginTop: 18 }}>
            <strong>{management.terminationIntent === "auto_renew_off" ? "Automatisk förnyelse är avstängd." : "Abonnemanget är uppsagt."}</strong>
            <p>Nuvarande period löper till {formatDate(periodEnd)}. Ingen ny abonnemangsperiod startas efter det datumet.</p>
          </div> : null}
          {pendingLabel ? <p><strong>{pendingLabel}.</strong> Lokal access ändras inte förrän provider-eventet är bekräftat.</p> : null}
        </> : null}

        <div className="actions">
          {needsPayment ? <form action="/api/billing/checkout" method="post"><button className="button primary" type="submit">Aktivera · {priceSekMonthly.toLocaleString("sv-SE")} kr/mån exkl. moms</button></form> : null}
          {paid && access.providerCustomerId && management.canManage ? <form action="/api/billing/portal" method="post"><button className="button" type="submit">Betalningsmetod & fakturor</button></form> : null}
          {access.allowed ? <Link className="button primary" href="/dashboard">Öppna DIV3RSA</Link> : null}
        </div>
      </div>

      {canManage && status !== "canceled" ? <div className="card">
        <strong>Hantera abonnemang</strong>
        <p>Pausa, återuppta eller styr förnyelsen själv. Alla ändringar skickas till Stripe och blir aktiva först när providern har bekräftat dem.</p>

        <div className="actions" style={{ marginTop: 18 }}>
          {pausedPaid ? <form action="/api/billing/subscription" method="post"><input type="hidden" name="action" value="resume"/><button className="button primary" type="submit">Återuppta abonnemang</button></form> : null}
          {activePaid ? <form action="/api/billing/subscription" method="post"><input type="hidden" name="action" value="pause"/><button className="button" type="submit">Pausa abonnemang</button></form> : null}
          {cancelAtPeriodEnd ? <form action="/api/billing/subscription" method="post"><input type="hidden" name="action" value="reactivate"/><button className="button primary" type="submit">Slå på förnyelse igen</button></form> : null}
          {!cancelAtPeriodEnd && ["active", "trialing", "paused"].includes(status) ? <form action="/api/billing/subscription" method="post"><input type="hidden" name="action" value="disable_auto_renew"/><button className="button" type="submit">Stäng av auto-renew</button></form> : null}
          {!cancelAtPeriodEnd && ["active", "trialing", "paused"].includes(status) ? <Link className="button" href="/billing?confirm=cancel">Säg upp abonnemang</Link> : null}
        </div>

        <p style={{ marginTop: 18, fontSize: 14 }}>Paus raderar inte konto eller projekt. Uppsägning avslutar förnyelsen vid periodslut; den raderar inte automatiskt ditt konto eller din data.</p>
      </div> : null}

      {query.confirm === "cancel" && canManage && !cancelAtPeriodEnd && status !== "canceled" ? <div className="card">
        <strong>Bekräfta uppsägning</strong>
        <p>Nuvarande period behålls till {formatDate(periodEnd)} om abonnemanget är aktivt. Därefter startas ingen ny period och ingen ny abonnemangsdebitering görs.</p>
        <p>Ditt konto, dina projekt och historik raderas inte av själva uppsägningen.</p>
        <form action="/api/billing/subscription" method="post">
          <input type="hidden" name="action" value="cancel"/>
          <label style={{ display: "grid", gap: 8, marginTop: 18, maxWidth: 420 }}>
            <span>Anledning (valfritt)</span>
            <select name="reason" defaultValue="">
              <option value="">Välj inte</option>
              <option value="too_expensive">För dyrt</option>
              <option value="missing_features">Saknar funktioner</option>
              <option value="unused">Används inte</option>
              <option value="switched_service">Bytt tjänst</option>
              <option value="customer_service">Support/service</option>
              <option value="low_quality">Kvalitet</option>
              <option value="too_complex">För komplext</option>
              <option value="other">Annat</option>
            </select>
          </label>
          <div className="actions" style={{ marginTop: 18 }}>
            <button className="button primary" type="submit">Bekräfta uppsägning</button>
            <Link className="button" href="/billing">Avbryt</Link>
          </div>
        </form>
      </div> : null}

      {paid && management.configured && !management.canManage ? <div className="card"><strong>Read-only billing</strong><p>Du kan se abonnemangsstatus, men endast organisationens admin kan ändra plan, betalning eller subscription-livscykel.</p></div> : null}
      {!access.allowed && !paid ? <p className="lead" style={{ fontSize: 15 }}>Kontakta administratören för att ändra åtkomsttyp eller aktivera ett abonnemang.</p> : null}
    </section>
  </main>;
}
