import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { enqueueOperation, reviewAccessRequest } from "./actions";

type Overview = { access_requests?: Record<string, number>; runs?: Record<string, number>; knowledge?: Record<string, number>; models?: Array<{ version: string; status: string; repository: string; revision: string; quantization: string }>; workers?: Record<string, number>; queues?: Record<string, number>; recent_errors?: Array<{ trace_id: string; service: string; event_name: string; occurred_at: string }> };

export default async function SuperadminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  const [{ data: overviewData, error }, { data: requests }] = await Promise.all([
    supabase.rpc("superadmin_overview"),
    supabase.from("access_requests").select("id,email,name,organization_name,use_case,status,created_at").in("status", ["pending", "reviewing"]).order("created_at", { ascending: true }).limit(50)
  ]);
  if (error) throw new Error(error.message);
  const overview = overviewData as Overview;
  return <main className="shell">
    <nav className="nav"><span className="brand">DIV3RSA CONTROL</span><Link href="/dashboard">User dashboard</Link></nav>
    <section className="admin-page">
      <div><p className="eyebrow">Superadmin · AAL2</p><h2>Control plane</h2><p className="lead">Operations are queued, audited and denied by default until their workers and scoped credentials are connected.</p></div>
      <div className="metric-grid">
        <article className="card"><span>Queued runs</span><strong>{overview.runs?.queued ?? 0}</strong></article>
        <article className="card"><span>Knowledge pending</span><strong>{overview.knowledge?.pending ?? 0}</strong></article>
        <article className="card"><span>GPU workers</span><strong>{overview.workers?.ready ?? 0}/{overview.workers?.total ?? 0}</strong></article>
        <article className="card"><span>Access pending</span><strong>{overview.access_requests?.pending ?? 0}</strong></article>
      </div>
      <section className="admin-section"><h3>Operational queues</h3><form action={enqueueOperation} className="inline-form"><select name="queue" defaultValue="repository-index"><option value="knowledge-ingestion">Knowledge ingestion</option><option value="repository-index">Repository index</option><option value="eval">Evaluation</option><option value="training">LoRA / QLoRA plan</option><option value="gpu-reconcile">GPU reconcile</option><option value="rollback">Rollback</option></select><input name="resource" required maxLength={2048} placeholder="Pinned source, revision or operation ID"/><button className="button primary">Queue operation</button></form></section>
      <section className="admin-section"><h3>Access review</h3>{requests?.length ? <div className="admin-list">{requests.map((request) => <article className="admin-row" key={request.id}><div><strong>{request.name}</strong><small>{request.email} · {request.organization_name ?? "Independent"}</small><p>{request.use_case}</p></div><form action={reviewAccessRequest} className="row-actions"><input type="hidden" name="requestId" value={request.id}/><button name="decision" value="reviewing" className="button">Review</button><button name="decision" value="approved" className="button primary">Approve</button><button name="decision" value="rejected" className="button danger">Reject</button></form></article>)}</div> : <p className="muted">No pending requests.</p>}</section>
      <section className="admin-section"><h3>Model registry</h3><div className="admin-list">{overview.models?.map((model) => <article className="admin-row" key={model.version}><div><strong>{model.version} · {model.quantization}</strong><small>{model.repository}@{model.revision.slice(0, 12)}</small></div><span className="status-badge">{model.status}</span></article>)}</div></section>
      <section className="admin-section"><h3>Recent runtime errors</h3>{overview.recent_errors?.length ? overview.recent_errors.map((event) => <div className="admin-row" key={`${event.trace_id}:${event.occurred_at}`}><span>{event.service} · {event.event_name}</span><small>{event.trace_id}</small></div>) : <p className="muted">No recorded errors.</p>}</section>
    </section>
  </main>;
}
