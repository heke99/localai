import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { setOrganizationBillingAccess } from "../manage/actions";

type Organization = { id: string; name: string; slug: string };
type Subscription = {
  organization_id: string;
  access_mode: "paid" | "free" | "trial";
  status: string;
  provider_status: string | null;
  provider_subscription_id: string | null;
  trial_ends_at: string | null;
  trial_token_limit: number | null;
  current_period_end: string | null;
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium" }).format(date);
}

export default async function SuperadminBillingPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const [{ data: organizations, error: organizationError }, { data: subscriptions, error: subscriptionError }] = await Promise.all([
    supabase.from("organizations").select("id,name,slug").order("created_at", { ascending: false }).limit(500),
    supabase.from("organization_subscriptions").select("organization_id,access_mode,status,provider_status,provider_subscription_id,trial_ends_at,trial_token_limit,current_period_end").limit(500)
  ]);
  if (organizationError) throw new Error(organizationError.message);
  if (subscriptionError) throw new Error(subscriptionError.message);

  const subscriptionByOrg = new Map(((subscriptions ?? []) as Subscription[]).map((row) => [row.organization_id, row]));

  return <main className="shell control-shell">
    <nav className="nav control-topbar"><div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Billing & access</span></div><div className="control-top-actions"><Link className="button" href="/superadmin/manage">Management</Link><Link className="button primary" href="/superadmin">Control center</Link></div></nav>
    <section className="control-content" style={{ maxWidth: 1180, margin: "0 auto" }}>
      <header className="control-header"><div><p className="eyebrow">Access plans</p><h1>Billing & access</h1><p className="lead">Hantera Paid, Free och tidsbegränsade Trials. Paid kostar 2 000 kr/mån exkl. moms och Stripe Tax beräknar tillämplig moms automatiskt. Superadmin är alltid undantagen från billing.</p></div></header>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Organizations</p><h2>Åtkomst per organisation</h2></div><span className="panel-count">{organizations?.length ?? 0}</span></div>
        <div className="compact-list">
          {((organizations ?? []) as Organization[]).map((organization) => {
            const subscription = subscriptionByOrg.get(organization.id);
            const internal = organization.slug === "div3rsa-internal";
            return <div className="compact-row" key={organization.id} style={{ alignItems: "flex-start", gap: 20 }}>
              <div style={{ minWidth: 240 }}>
                <strong>{organization.name}</strong>
                <small>{internal ? "Superadmin / intern · billing exempt" : subscription ? `${subscription.access_mode} · ${subscription.status}` : "Ingen accessplan ännu"}</small>
                {subscription?.access_mode === "trial" ? <small>Trial slutar {formatDate(subscription.trial_ends_at)} · {(subscription.trial_token_limit ?? 0).toLocaleString("sv-SE")} tokens</small> : null}
                {subscription?.access_mode === "paid" && subscription.current_period_end ? <small>Betald period till {formatDate(subscription.current_period_end)}</small> : null}
              </div>

              {internal ? <span className="status-badge status-production">billing exempt</span> : <form action={setOrganizationBillingAccess} className="row-actions" style={{ flex: 1, justifyContent: "flex-end", alignItems: "flex-end", flexWrap: "wrap" }}>
                <input type="hidden" name="organizationId" value={organization.id}/>
                <label style={{ display: "grid", gap: 5 }}><small>Åtkomst</small><select name="accessMode" defaultValue={subscription?.access_mode ?? "paid"}><option value="paid">Paid · 2 000 kr/mån exkl. moms</option><option value="free">Free</option><option value="trial">Trial</option></select></label>
                <label style={{ display: "grid", gap: 5 }}><small>Trial dagar</small><input name="trialDays" type="number" min={1} max={90} defaultValue={3} style={{ width: 90 }}/></label>
                <label style={{ display: "grid", gap: 5 }}><small>Trial tokens</small><input name="trialTokenLimit" type="number" min={1000} max={1000000000} step={1000} defaultValue={subscription?.trial_token_limit ?? 100000} style={{ width: 140 }}/></label>
                <button className="button primary" type="submit">Spara access</button>
              </form>}
            </div>;
          })}
        </div>
      </section>
    </section>
  </main>;
}
