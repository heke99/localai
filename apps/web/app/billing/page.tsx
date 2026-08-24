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

type SearchParams = Promise<{ checkout?: string; error?: string }>;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "long" }).format(date);
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
  const { data, error } = await supabase.rpc("my_agent_access_snapshot", { target_workspace_id: workspace.id });
  if (error) throw new Error(error.message);
  const access = (data ?? {}) as AccessSnapshot;

  const paid = access.accessMode === "paid";
  const trial = access.accessMode === "trial";
  const free = access.accessMode === "free";
  const activePaid = paid && access.allowed;
  const needsPayment = paid && !access.allowed;
  const trialExhausted = trial && !access.allowed && (access.trialTokensRemaining ?? 0) <= 0;
  const trialExpired = trial && !access.allowed && Boolean(access.trialEndsAt) && new Date(access.trialEndsAt!).getTime() <= Date.now();

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link><Link href="/dashboard">Dashboard</Link></nav>
    <section className="hero" style={{ maxWidth: 820 }}>
      <div className="eyebrow">Access & billing</div>
      <h1>Ditt abonnemang.</h1>
      <p className="lead">Här ser du åtkomststatus, betalning och eventuell trial för {workspace.name}.</p>

      {query.checkout === "success" ? <div className="card" role="status"><strong>Betalningen behandlas.</strong><p>Stripe bekräftar abonnemanget via webhook. Åtkomsten öppnas automatiskt när betalningen är bekräftad.</p></div> : null}
      {query.checkout === "canceled" ? <div className="card" role="status"><strong>Betalningen avbröts.</strong><p>Inget abonnemang har aktiverats. Du kan starta betalningen igen när du vill.</p></div> : null}
      {query.error ? <p className="error" role="alert">Billing-åtgärden kunde inte slutföras. Försök igen eller kontakta administratören.</p> : null}

      <div className="card">
        <strong>{free ? "Fri åtkomst" : trial ? "Trial" : activePaid ? "Aktivt abonnemang" : "DIV3RSA"}</strong>
        {free ? <p>Din åtkomst är administratörsgodkänd och kräver ingen betalning.</p> : null}
        {trial ? <>
          <p>Trial gäller till {formatDate(access.trialEndsAt)}.</p>
          <p><strong>{Math.max(access.trialTokensRemaining ?? 0, 0).toLocaleString("sv-SE")}</strong> av {(access.trialTokenLimit ?? 0).toLocaleString("sv-SE")} tokens återstår.</p>
          {trialExpired ? <p className="error">Trial-perioden har gått ut.</p> : null}
          {trialExhausted ? <p className="error">Trialens tokenbudget är förbrukad.</p> : null}
        </> : null}
        {paid ? <>
          <p><strong>2 000 kr/mån exkl. moms.</strong> Stripe beräknar tillämplig moms automatiskt utifrån kundens land och skatteuppgifter. Abonnemanget förnyas månadsvis.</p>
          {access.currentPeriodEnd ? <p>Nästa period: {formatDate(access.currentPeriodEnd)}</p> : null}
          {access.status === "past_due" ? <p className="error">Betalningen kunde inte genomföras. Agentåtkomsten är pausad tills betalningen är löst.</p> : null}
          {access.status === "canceled" ? <p className="error">Abonnemanget är avslutat.</p> : null}
        </> : null}

        <div className="actions">
          {needsPayment ? <form action="/api/billing/checkout" method="post"><button className="button primary" type="submit">Aktivera · 2 000 kr/mån exkl. moms</button></form> : null}
          {paid && access.providerCustomerId ? <form action="/api/billing/portal" method="post"><button className="button" type="submit">Hantera betalning</button></form> : null}
          {access.allowed ? <Link className="button primary" href="/dashboard">Öppna DIV3RSA</Link> : null}
        </div>
      </div>

      {!access.allowed && !paid ? <p className="lead" style={{ fontSize: 15 }}>Kontakta administratören för att ändra åtkomsttyp eller aktivera ett abonnemang.</p> : null}
    </section>
  </main>;
}
