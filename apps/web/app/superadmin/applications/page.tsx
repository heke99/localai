import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { grantAccess, reviewAccessRequest } from "../actions";

type AccessRequest = {
  id: string;
  email: string;
  name: string;
  organization_name: string | null;
  use_case: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  invited_at: string | null;
  password_email_sent_at: string | null;
  onboarding_completed_at: string | null;
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function excerpt(value: string) {
  return value.length > 220 ? `${value.slice(0, 217)}…` : value;
}

export default async function SuperadminApplicationsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");

  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const { data, error } = await supabase
    .from("access_requests")
    .select("id,email,name,organization_name,use_case,status,created_at,reviewed_at,invited_at,password_email_sent_at,onboarding_completed_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);
  const requests = (data ?? []) as AccessRequest[];
  const pending = requests.filter((request) => request.status === "pending").length;
  const reviewing = requests.filter((request) => request.status === "reviewing").length;
  const approved = requests.filter((request) => request.status === "approved").length;
  const rejected = requests.filter((request) => request.status === "rejected").length;

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Applications</span></div>
      <div className="control-top-actions">
        <Link className="button" href="/superadmin">Control center</Link>
        <Link className="button primary" href="/dashboard">User dashboard</Link>
      </div>
    </nav>

    <section className="control-content" style={{ maxWidth: 1280, margin: "0 auto" }}>
      <header className="control-header">
        <div>
          <p className="eyebrow">Access management</p>
          <h1>Applications</h1>
          <p className="lead">Se vem som har ansökt, deras kontaktuppgifter, organisation, varför de vill ha åtkomst och hela onboardingstatusen.</p>
        </div>
      </header>

      <div className="control-metrics" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
        <article><span>Pending</span><strong>{pending}</strong><small>väntar på granskning</small></article>
        <article><span>Reviewing</span><strong>{reviewing}</strong><small>under granskning</small></article>
        <article><span>Approved</span><strong>{approved}</strong><small>godkända</small></article>
        <article><span>Rejected</span><strong>{rejected}</strong><small>avslagna</small></article>
      </div>

      <section className="control-panel">
        <div className="control-section-head">
          <div><p className="eyebrow">All applications</p><h2>Ansökningar</h2></div>
          <span className="panel-count">{requests.length}</span>
        </div>

        {requests.length ? <div className="control-list">{requests.map((request) => {
          const finished = Boolean(request.onboarding_completed_at);
          return <article className="control-row" key={request.id}>
            <div className="control-row-main">
              <div className="control-row-title">
                <strong>{request.name}</strong>
                <span className={`status-badge status-${finished ? "active" : request.status}`}>{finished ? "active" : request.status}</span>
              </div>
              <small>{request.email} · {request.organization_name ?? "Ingen organisation angiven"} · {formatDate(request.created_at)}</small>
              <p><strong>Varför:</strong> {excerpt(request.use_case)}</p>
              {request.reviewed_at ? <small>Granskad {formatDate(request.reviewed_at)}</small> : null}
              {request.status === "approved" ? <div className="onboarding-track">
                <span className={request.invited_at ? "done" : ""}>Invite</span>
                <span className={request.password_email_sent_at ? "done" : ""}>Password mail</span>
                <span className={request.onboarding_completed_at ? "done" : ""}>Activated</span>
              </div> : null}
            </div>
            <div className="row-actions">
              <Link className="button primary" href={`/superadmin/applications/${request.id}`}>Öppna ansökan</Link>
              {!finished && request.status !== "approved" && request.status !== "rejected" ? <form className="row-actions">
                <input type="hidden" name="requestId" value={request.id}/>
                {request.status === "pending" ? <button formAction={reviewAccessRequest} name="decision" value="reviewing" className="button">Review</button> : null}
                <button formAction={grantAccess} className="button">Grant access</button>
                <button formAction={reviewAccessRequest} name="decision" value="rejected" className="button danger">Reject</button>
              </form> : null}
            </div>
          </article>;
        })}</div> : <p className="empty-state">Inga ansökningar har kommit in ännu.</p>}
      </section>
    </section>
  </main>;
}
