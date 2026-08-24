import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type AccessSnapshot = {
  accessMode?: string;
  status?: string;
  allowed?: boolean;
};

type ManagementSnapshot = {
  configured?: boolean;
  provider?: string | null;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "long" }).format(date);
}

export default async function SubscriptionSettingsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/sign-in?next=/settings/subscription");

  if (user.app_metadata.system_role !== "superadmin") redirect("/billing");

  const { data: internalOrganization } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", "div3rsa-internal")
    .maybeSingle();

  if (!internalOrganization) redirect("/superadmin");

  const { data: internalWorkspaces } = await supabase
    .from("workspaces")
    .select("id,name")
    .eq("organization_id", internalOrganization.id)
    .order("created_at", { ascending: true })
    .limit(1);

  const workspace = internalWorkspaces?.[0];
  if (!workspace) redirect("/superadmin");

  const [{ data: accessData }, { data: managementData }] = await Promise.all([
    supabase.rpc("my_agent_access_snapshot", { target_workspace_id: workspace.id }),
    supabase.rpc("my_subscription_management_snapshot", { target_workspace_id: workspace.id })
  ]);

  const access = (accessData ?? {}) as AccessSnapshot;
  const management = (managementData ?? {}) as ManagementSnapshot;
  const configured = Boolean(management.configured);

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link><Link href="/dashboard?section=settings">Inställningar</Link></nav>
    <section className="hero" style={{ maxWidth: 860 }}>
      <div className="eyebrow">Settings · Subscription</div>
      <h1>Systemkonto.</h1>
      <p className="lead">Subscription-status för den interna superadmin-arbetsytan {workspace.name}.</p>

      <div className="card">
        <strong>Superadmin</strong>
        <p>Systemkontot har intern åtkomst och ska inte debiteras som en vanlig kundorganisation.</p>
        <p><strong>Access mode:</strong> {access.accessMode ?? "superadmin"}</p>
        <p><strong>Status:</strong> {access.status ?? (access.allowed ? "active" : "inactive")}</p>
      </div>

      <div className="card">
        <strong>Stripe subscription</strong>
        {configured ? <>
          <p><strong>Provider:</strong> {management.provider ?? "—"}</p>
          <p><strong>Status:</strong> {management.status ?? "—"}</p>
          <p><strong>Periodslut:</strong> {formatDate(management.currentPeriodEnd)}</p>
          <p><strong>Auto-renew:</strong> {management.cancelAtPeriodEnd ? "Av" : "På"}</p>
        </> : <p>Ingen kundprenumeration är kopplad till systemkontot, vilket är förväntat för superadmin.</p>}
      </div>

      <div className="actions">
        <Link className="button primary" href="/dashboard?section=settings">Tillbaka till Inställningar</Link>
        <Link className="button" href="/superadmin">Öppna Control Center</Link>
      </div>
    </section>
  </main>;
}
