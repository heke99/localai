import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type AccessRequest = {
  id: string;
  email: string;
  name: string;
  organization_name: string | null;
  use_case: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  invited_user_id: string | null;
  invited_at: string | null;
  password_email_sent_at: string | null;
  onboarding_completed_at: string | null;
  organization_id: string | null;
  workspace_id: string | null;
  access_mode: "paid" | "free" | "trial" | null;
  trial_days: number | null;
  trial_token_limit: number | null;
  billing_checkout_url: string | null;
  billing_configured_at: string | null;
};

type SearchParams = Promise<{ updated?: string; error?: string; reason?: string }>;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short" }).format(date);
}

function valueOrDash(value?: string | null) {
  return value?.trim() || "—";
}

function feedback(updated?: string, error?: string, reason?: string) {
  if (error) return { kind: "error", text: reason ? `Åtgärden kunde inte slutföras (${reason}).` : "Åtgärden kunde inte slutföras. Kontrollera statusen och försök igen." };
  if (updated === "reviewing") return { kind: "success", text: "Ansökan är markerad som under granskning." };
  if (updated === "rejected") return { kind: "success", text: "Ansökan är avslagen." };
  if (updated === "approved") return { kind: "success", text: "Kunden är godkänd och åtkomsten är konfigurerad." };
  if (updated === "approved-billing-pending") return { kind: "error", text: "Kunden är godkänd, men Stripe Checkout kunde inte skapas. Paid-access är fortsatt låst tills en betalningslänk skapas." };
  if (updated === "already-approved") return { kind: "success", text: "Kunden var redan godkänd. Åtkomstinställningen har uppdaterats utan dubbel provisionering." };
  return null;
}

function accessLabel(request: AccessRequest) {
  if (request.access_mode === "free") return "Fri åtkomst";
  if (request.access_mode === "trial") return `Trial · ${request.trial_days ?? "—"} dagar · ${(request.trial_token_limit ?? 0).toLocaleString("sv-SE")} tokens`;
  if (request.access_mode === "paid") return "Paid · 2 000 kr/mån exkl. moms";
  return "Inte vald";
}

export default async function SuperadminApplicationDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");

  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const { data, error } = await supabase
    .from("access_requests")
    .select("id,email,name,organization_name,use_case,status,reviewed_by,reviewed_at,created_at,invited_user_id,invited_at,password_email_sent_at,onboarding_completed_at,organization_id,workspace_id,access_mode,trial_days,trial_token_limit,billing_checkout_url,billing_configured_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) notFound();
  const request = data as AccessRequest;
  const finished = Boolean(request.onboarding_completed_at);
  const notice = feedback(query.updated, query.error, query.reason);

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Application detail</span></div>
      <div className="control-top-actions">
        <Link className="button" href="/superadmin/applications">Alla ansökningar</Link>
        <Link className="button" href="/superadmin">Control center</Link>
      </div>
    </nav>

    <section className="control-content" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <header className="control-header">
        <div>
          <p className="eyebrow">Application</p>
          <h1>{request.name}</h1>
          <p className="lead">Ansökningsunderlag, beslut, åtkomsttyp och onboardingstatus.</p>
        </div>
        <span className={`status-badge status-${finished ? "active" : request.status}`}>{finished ? "active" : request.status}</span>
      </header>

      {notice ? <div className="card" role="status">
        <strong>{notice.kind === "error" ? "Kontroll krävs" : "Status uppdaterad"}</strong>
        <p>{notice.text}</p>
      </div> : null}

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Applicant</p><h2>Kontakt & organisation</h2></div></div>
        <div className="control-split">
          <div className="compact-list">
            <div className="compact-row"><div><strong>Namn</strong><small>{request.name}</small></div></div>
            <div className="compact-row"><div><strong>E-post</strong><small>{request.email}</small></div></div>
          </div>
          <div className="compact-list">
            <div className="compact-row"><div><strong>Organisation</strong><small>{valueOrDash(request.organization_name)}</small></div></div>
            <div className="compact-row"><div><strong>Ansökte</strong><small>{formatDate(request.created_at)}</small></div></div>
          </div>
        </div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Motivation</p><h2>Varför de ansöker</h2></div></div>
        <p className="panel-copy" style={{ maxWidth: "none", whiteSpace: "pre-wrap", fontSize: 15 }}>{request.use_case}</p>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Review</p><h2>Status & beslut</h2></div></div>
        <div className="control-split">
          <div className="compact-list">
            <div className="compact-row"><div><strong>Status</strong><small>{request.status}</small></div></div>
            <div className="compact-row"><div><strong>Granskad</strong><small>{formatDate(request.reviewed_at)}</small></div></div>
          </div>
          <div className="compact-list">
            <div className="compact-row"><div><strong>Åtkomst</strong><small>{accessLabel(request)}</small></div></div>
            <div className="compact-row"><div><strong>Billing konfigurerad</strong><small>{formatDate(request.billing_configured_at)}</small></div></div>
          </div>
        </div>

        {!finished && request.status !== "approved" && request.status !== "rejected" ? <form
          className="control-form"
          style={{ marginTop: 18 }}
          action={`/api/superadmin/access-requests/${request.id}`}
          method="post"
        >
          <label><span>Åtkomsttyp</span><select name="access_mode" defaultValue="paid"><option value="paid">Paid · 2 000 kr/mån exkl. moms</option><option value="free">Fri åtkomst</option><option value="trial">Trial</option></select></label>
          <label><span>Trial · dagar</span><input name="trial_days" type="number" min={1} max={90} defaultValue={3}/></label>
          <label><span>Trial · tokenlimit</span><input name="trial_token_limit" type="number" min={1000} max={1000000000} step={1000} defaultValue={100000}/></label>
          <p className="muted" style={{ gridColumn: "1 / -1" }}>Trial-fälten används endast när Trial väljs. Paid aktiveras först efter bekräftad Stripe-betalning. Stripe Tax beräknar tillämplig moms automatiskt. Free och Trial kräver ingen betalning.</p>
          <div className="row-actions" style={{ gridColumn: "1 / -1" }}>
            {request.status === "pending" ? <button name="action" value="reviewing" className="button">Markera under granskning</button> : null}
            <button name="action" value="approve" className="button primary">Godkänn & konfigurera åtkomst</button>
            <button name="action" value="rejected" className="button danger">Avslå</button>
          </div>
        </form> : null}

        {request.billing_checkout_url ? <div className="actions" style={{ marginTop: 16 }}><a className="button" href={request.billing_checkout_url} target="_blank" rel="noreferrer">Öppna Stripe Checkout</a></div> : null}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Onboarding</p><h2>Åtkomsthistorik</h2></div></div>
        <div className="onboarding-track" style={{ marginTop: 18 }}>
          <span className={request.invited_at ? "done" : ""}>Invite · {formatDate(request.invited_at)}</span>
          <span className={request.password_email_sent_at ? "done" : ""}>Password mail · {formatDate(request.password_email_sent_at)}</span>
          <span className={request.onboarding_completed_at ? "done" : ""}>Activated · {formatDate(request.onboarding_completed_at)}</span>
        </div>
        <div className="control-split spaced-list">
          <div className="compact-list">
            <div className="compact-row"><div><strong>User ID</strong><small>{valueOrDash(request.invited_user_id)}</small></div></div>
            <div className="compact-row"><div><strong>Organization ID</strong><small>{valueOrDash(request.organization_id)}</small></div></div>
          </div>
          <div className="compact-list">
            <div className="compact-row"><div><strong>Workspace ID</strong><small>{valueOrDash(request.workspace_id)}</small></div></div>
            <div className="compact-row"><div><strong>Onboarding state</strong><small>{finished ? "Completed" : request.status === "approved" ? "Provisioned / waiting for activation" : "Not provisioned"}</small></div></div>
          </div>
        </div>
      </section>
    </section>
  </main>;
}
