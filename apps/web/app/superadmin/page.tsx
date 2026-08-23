import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { enqueueOperation, grantAccess, reviewAccessRequest, setModelAlias } from "./actions";

type Snapshot = {
  counts?: Record<string, number>;
  users?: Array<{ id: string; email: string; display_name: string; system_role: string; created_at: string; last_sign_in_at: string | null; active_organizations: number }>;
  organizations?: Array<{ id: string; name: string; slug: string; created_at: string; active_members: number; workspaces: number }>;
  model_aliases?: Array<{ alias: string; model_version_id: string; version_key: string; status: string; repository: string; revision: string; updated_at: string }>;
  model_versions?: Array<{ id: string; version_key: string; status: string; repository: string; revision: string; context_window: number; capabilities: string[]; quantization: string | null; created_at: string }>;
  gpu_providers?: Array<{ id: string; key: string; enabled: boolean; workers: number }>;
  gpu_workers?: Array<{ id: string; provider: string; external_worker_id: string; profile: string; state: string; last_heartbeat_at: string | null; version_key: string | null }>;
  skills?: Array<{ key: string; category: string; status: string; active_version: number | null; created_at: string }>;
  knowledge?: Array<{ id: string; scope_type: string; source_type: string; source_uri: string | null; approval_status: string; created_at: string }>;
  integrations?: Array<{ id: string; organization_id: string; organization_name: string | null; provider: string; external_account_id: string; status: string; created_at: string }>;
  policies?: Array<{ id: string; organization_id: string | null; organization_name: string | null; key: string; version: number; status: string; created_at: string; rules: number }>;
  eval_runs?: Array<{ id: string; status: string; created_at: string; finished_at: string | null; version_key: string | null }>;
  jobs?: Array<{ id: string; queue: string; status: string; priority: number; attempts: number; maximum_attempts: number; last_error_code: string | null; created_at: string; updated_at: string }>;
  runs?: Array<{ id: string; mode: string; status: string; model_alias: string; failure_code: string | null; active_skill: string | null; created_at: string; started_at: string | null; finished_at: string | null }>;
  usage_monthly?: Array<{ organization_id: string; organization_name: string | null; usage_month: string; totals: Record<string, unknown> }>;
  audit?: Array<{ id: string; event_type: string; target_type: string; target_id: string; outcome: string; occurred_at: string; organization_id: string | null }>;
  errors?: Array<{ trace_id: string; service: string; event_name: string; severity: string; duration_ms: number | null; occurred_at: string }>;
};

type AccessRequest = {
  id: string;
  email: string;
  name: string;
  organization_name: string | null;
  use_case: string;
  status: string;
  created_at: string;
  invited_at: string | null;
  password_email_sent_at: string | null;
  onboarding_completed_at: string | null;
};

const controlLinks = [
  ["#overview", "Overview"],
  ["#access", "Access"],
  ["#users", "Users & orgs"],
  ["#models", "Models"],
  ["#gpu", "GPU"],
  ["#knowledge", "Knowledge & skills"],
  ["#integrations", "Integrations & policies"],
  ["#operations", "Runs & operations"],
  ["#usage", "Usage"],
  ["#audit", "Audit & errors"]
] as const;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : "—";
}

export default async function SuperadminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");

  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const [{ data: snapshotData, error: snapshotError }, { data: requests, error: requestError }] = await Promise.all([
    supabase.rpc("superadmin_control_snapshot"),
    supabase
      .from("access_requests")
      .select("id,email,name,organization_name,use_case,status,created_at,invited_at,password_email_sent_at,onboarding_completed_at")
      .in("status", ["pending", "reviewing", "approved"])
      .order("created_at", { ascending: false })
      .limit(60)
  ]);

  if (snapshotError) throw new Error(snapshotError.message);
  if (requestError) throw new Error(requestError.message);

  const snapshot = (snapshotData ?? {}) as Snapshot;
  const accessRequests = (requests ?? []) as AccessRequest[];
  const counts = snapshot.counts ?? {};
  const activeModel = snapshot.model_aliases?.find((alias) => alias.alias === "general-prod");
  const readyWorkers = snapshot.gpu_workers?.filter((worker) => worker.state === "ready").length ?? 0;

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Superadmin · verifierad session</span></div>
      <div className="control-top-actions">
        <Link className="button primary" href="/dashboard">Open user dashboard</Link>
        <form action="/auth/signout" method="post"><button className="button" type="submit">Logga ut</button></form>
      </div>
    </nav>

    <div className="control-layout">
      <aside className="control-sidebar" aria-label="Control plane navigation">
        <p className="control-sidebar-title">Control plane</p>
        <nav>{controlLinks.map(([href, label]) => <a href={href} key={href}>{label}</a>)}</nav>
        <div className="control-sidebar-note">
          <span>Active model</span>
          <strong>{activeModel?.version_key ?? "Not selected"}</strong>
          <small>{activeModel?.repository ?? "No model registered"}</small>
        </div>
      </aside>

      <section className="control-content">
        <header className="control-header" id="overview">
          <div>
            <p className="eyebrow">System control</p>
            <h1>Control center</h1>
            <p className="lead">Users, models, GPU capacity, knowledge, integrations, policies, evaluations and runtime operations in one place. High-impact work is audited and either applied through a protected RPC or queued for a worker.</p>
          </div>
          <div className="control-health">
            <span className={`health-dot ${readyWorkers > 0 ? "ready" : "waiting"}`} />
            <div><strong>{readyWorkers > 0 ? "Inference capacity online" : "GPU worker not connected"}</strong><small>{readyWorkers} ready worker{readyWorkers === 1 ? "" : "s"}</small></div>
          </div>
        </header>

        <div className="control-metrics">
          <article><span>Users</span><strong>{counts.users ?? 0}</strong><small>{counts.organizations ?? 0} organizations</small></article>
          <article><span>Runs</span><strong>{counts.runs ?? 0}</strong><small>{counts.queued_jobs ?? 0} active jobs</small></article>
          <article><span>GPU</span><strong>{readyWorkers}/{counts.workers ?? 0}</strong><small>ready / total workers</small></article>
          <article><span>Knowledge</span><strong>{counts.knowledge ?? 0}</strong><small>{counts.skills ?? 0} registered skills</small></article>
          <article><span>Integrations</span><strong>{counts.integrations ?? 0}</strong><small>{counts.projects ?? 0} projects</small></article>
          <article><span>Policy sets</span><strong>{counts.policies ?? 0}</strong><small>{counts.evals ?? 0} eval runs</small></article>
        </div>

        <section className="control-panel" id="access">
          <div className="control-section-head"><div><p className="eyebrow">Access</p><h2>Applications & onboarding</h2></div><span className="panel-count">{accessRequests.length}</span></div>
          {accessRequests.length ? <div className="control-list">{accessRequests.map((request) => {
            const finished = Boolean(request.onboarding_completed_at);
            return <article className="control-row" key={request.id}>
              <div className="control-row-main">
                <div className="control-row-title"><strong>{request.name}</strong><span className={`status-badge status-${request.status}`}>{finished ? "active" : request.status}</span></div>
                <small>{request.email} · {request.organization_name ?? "Independent"} · applied {formatDate(request.created_at)}</small>
                <p>{request.use_case}</p>
                {request.status === "approved" ? <div className="onboarding-track"><span className={request.invited_at ? "done" : ""}>Invite</span><span className={request.password_email_sent_at ? "done" : ""}>Password mail</span><span className={request.onboarding_completed_at ? "done" : ""}>Activated</span></div> : null}
              </div>
              {!finished && request.status !== "approved" ? <form className="row-actions">
                <input type="hidden" name="requestId" value={request.id}/>
                {request.status === "pending" ? <button formAction={reviewAccessRequest} name="decision" value="reviewing" className="button">Review</button> : null}
                <button formAction={grantAccess} className="button primary">Grant access</button>
                <button formAction={reviewAccessRequest} name="decision" value="rejected" className="button danger">Reject</button>
              </form> : null}
            </article>;
          })}</div> : <p className="empty-state">No applications yet.</p>}
        </section>

        <section className="control-panel" id="users">
          <div className="control-section-head"><div><p className="eyebrow">Accounts</p><h2>Users & organizations</h2></div><span className="panel-count">{snapshot.users?.length ?? 0}</span></div>
          <div className="control-split">
            <div><h3>Users</h3>{snapshot.users?.length ? <div className="compact-list">{snapshot.users.map((account) => <div className="compact-row" key={account.id}><div><strong>{account.display_name}</strong><small>{account.email}</small></div><div className="align-right"><span className="status-badge">{account.system_role}</span><small>{account.active_organizations} org · last {formatDate(account.last_sign_in_at)}</small></div></div>)}</div> : <p className="empty-state">No users.</p>}</div>
            <div><h3>Organizations</h3>{snapshot.organizations?.length ? <div className="compact-list">{snapshot.organizations.map((organization) => <div className="compact-row" key={organization.id}><div><strong>{organization.name}</strong><small>{organization.slug}</small></div><div className="align-right"><span>{organization.active_members} members</span><small>{organization.workspaces} workspaces</small></div></div>)}</div> : <p className="empty-state">No organizations.</p>}</div>
          </div>
        </section>

        <section className="control-panel" id="models">
          <div className="control-section-head"><div><p className="eyebrow">Inference</p><h2>Models & routing</h2></div><span className="panel-count">{snapshot.model_versions?.length ?? 0}</span></div>
          <form action={setModelAlias} className="control-form model-routing-form">
            <label><span>Route</span><select name="alias" defaultValue="code-prod"><option value="general-prod">General</option><option value="code-prod">Code</option><option value="lab-prod">Lab</option><option value="research-prod">Research</option><option value="reasoner-prod">Reasoner</option><option value="verifier-prod">Verifier</option></select></label>
            <label><span>Model version</span><select name="modelVersionId" required defaultValue={snapshot.model_versions?.[0]?.id}>{snapshot.model_versions?.map((model) => <option value={model.id} key={model.id}>{model.version_key} · {model.quantization ?? "unquantized"} · {model.status}</option>)}</select></label>
            <button className="button primary" type="submit" disabled={!snapshot.model_versions?.length}>Update route</button>
          </form>
          <div className="alias-grid">{snapshot.model_aliases?.map((alias) => <article key={alias.alias}><span>{alias.alias.replace("-prod", "")}</span><strong>{alias.version_key}</strong><small>{alias.repository}</small><small>{alias.revision.slice(0, 12)} · {alias.status}</small></article>)}</div>
          <div className="control-list spaced-list">{snapshot.model_versions?.map((model) => <article className="control-row" key={model.id}><div><div className="control-row-title"><strong>{model.version_key} · {model.quantization ?? "full"}</strong><span className={`status-badge status-${model.status}`}>{model.status}</span></div><small>{model.repository}@{model.revision.slice(0, 12)} · context {model.context_window.toLocaleString("sv-SE")}</small><p>{model.capabilities?.join(" · ") || "No capabilities declared"}</p></div></article>)}</div>
        </section>

        <section className="control-panel" id="gpu">
          <div className="control-section-head"><div><p className="eyebrow">Compute</p><h2>GPU capacity</h2></div><span className="panel-count">{snapshot.gpu_workers?.length ?? 0}</span></div>
          <div className="provider-grid">{snapshot.gpu_providers?.map((provider) => <article key={provider.id}><div><strong>{provider.key}</strong><span className={`status-badge ${provider.enabled ? "status-production" : "status-muted"}`}>{provider.enabled ? "enabled" : "disabled"}</span></div><p>{provider.workers} registered workers</p></article>)}</div>
          {snapshot.gpu_workers?.length ? <div className="compact-list spaced-list">{snapshot.gpu_workers.map((worker) => <div className="compact-row" key={worker.id}><div><strong>{worker.provider} · {worker.profile}</strong><small>{worker.external_worker_id} · model {worker.version_key ?? "none"}</small></div><div className="align-right"><span className={`status-badge status-${worker.state}`}>{worker.state}</span><small>heartbeat {formatDate(worker.last_heartbeat_at)}</small></div></div>)}</div> : <p className="empty-state">No GPU worker is registered yet. Use GPU reconcile when provider credentials and the model worker are ready.</p>}
          <form action={enqueueOperation} className="control-form quick-operation"><input type="hidden" name="queue" value="gpu-reconcile"/><label><span>Reconcile target</span><input name="resource" required maxLength={2048} placeholder="provider/profile, e.g. hyperstack/rtx-pro-6000-96gb"/></label><button className="button primary">Queue GPU reconcile</button></form>
        </section>

        <section className="control-panel" id="knowledge">
          <div className="control-section-head"><div><p className="eyebrow">Intelligence</p><h2>Knowledge & skills</h2></div><span className="panel-count">{(snapshot.knowledge?.length ?? 0) + (snapshot.skills?.length ?? 0)}</span></div>
          <div className="control-split">
            <div><h3>Knowledge sources</h3>{snapshot.knowledge?.length ? <div className="compact-list">{snapshot.knowledge.map((source) => <div className="compact-row" key={source.id}><div><strong>{source.source_type}</strong><small>{source.source_uri ?? shortId(source.id)}</small></div><span className={`status-badge status-${source.approval_status}`}>{source.approval_status}</span></div>)}</div> : <p className="empty-state">No knowledge has been ingested yet.</p>}</div>
            <div><h3>Runtime skills</h3>{snapshot.skills?.length ? <div className="compact-list">{snapshot.skills.map((skill) => <div className="compact-row" key={skill.key}><div><strong>{skill.key}</strong><small>{skill.category}</small></div><div className="align-right"><span className={`status-badge status-${skill.status}`}>{skill.status}</span><small>v{skill.active_version ?? "—"}</small></div></div>)}</div> : <p className="empty-state">Repo skills exist, but no runtime skill versions are registered in the database yet.</p>}</div>
          </div>
          <form action={enqueueOperation} className="control-form quick-operation"><input type="hidden" name="queue" value="knowledge-ingestion"/><label><span>Source to ingest</span><input name="resource" required maxLength={2048} placeholder="Pinned URL, document URI, repository revision or source ID"/></label><button className="button primary">Queue ingestion</button></form>
        </section>

        <section className="control-panel" id="integrations">
          <div className="control-section-head"><div><p className="eyebrow">Governance</p><h2>Integrations & policies</h2></div><span className="panel-count">{(snapshot.integrations?.length ?? 0) + (snapshot.policies?.length ?? 0)}</span></div>
          <div className="control-split">
            <div><h3>Connections</h3>{snapshot.integrations?.length ? <div className="compact-list">{snapshot.integrations.map((integration) => <div className="compact-row" key={integration.id}><div><strong>{integration.provider}</strong><small>{integration.organization_name ?? shortId(integration.organization_id)} · {integration.external_account_id}</small></div><span className={`status-badge status-${integration.status}`}>{integration.status}</span></div>)}</div> : <p className="empty-state">No account connection is registered yet.</p>}</div>
            <div><h3>Policy sets</h3>{snapshot.policies?.length ? <div className="compact-list">{snapshot.policies.map((policy) => <div className="compact-row" key={policy.id}><div><strong>{policy.key} · v{policy.version}</strong><small>{policy.organization_name ?? "Global"} · {policy.rules} rules</small></div><span className={`status-badge status-${policy.status}`}>{policy.status}</span></div>)}</div> : <p className="empty-state">No customer policy sets have been created yet.</p>}</div>
          </div>
          <p className="panel-copy">Plugin access is controlled per project, resource and capability. Lab uses the same resource-permission model as every other agent mode; there is no separate authorization ID or Lab scope object.</p>
        </section>

        <section className="control-panel" id="operations">
          <div className="control-section-head"><div><p className="eyebrow">Operations</p><h2>Runs, evals & queued work</h2></div><span className="panel-count">{snapshot.jobs?.length ?? 0}</span></div>
          <form action={enqueueOperation} className="control-form operation-form">
            <label><span>Operation</span><select name="queue" defaultValue="repository-index"><option value="repository-index">Repository index</option><option value="eval">Evaluation</option><option value="training">LoRA / QLoRA plan</option><option value="gpu-reconcile">GPU reconcile</option><option value="knowledge-ingestion">Knowledge ingestion</option><option value="rollback">Rollback</option></select></label>
            <label><span>Pinned resource</span><input name="resource" required maxLength={2048} placeholder="Repository@revision, model version, source URI or operation ID"/></label>
            <button className="button primary">Queue operation</button>
          </form>
          <div className="control-split spaced-list">
            <div><h3>Recent jobs</h3>{snapshot.jobs?.length ? <div className="compact-list">{snapshot.jobs.slice(0, 12).map((job) => <div className="compact-row" key={job.id}><div><strong>{job.queue}</strong><small>{shortId(job.id)} · {job.attempts}/{job.maximum_attempts} attempts</small></div><div className="align-right"><span className={`status-badge status-${job.status}`}>{job.status}</span><small>{job.last_error_code ?? formatDate(job.updated_at)}</small></div></div>)}</div> : <p className="empty-state">No jobs have been queued.</p>}</div>
            <div><h3>Agent runs</h3>{snapshot.runs?.length ? <div className="compact-list">{snapshot.runs.slice(0, 12).map((run) => <div className="compact-row" key={run.id}><div><strong>{run.mode} · {run.model_alias}</strong><small>{shortId(run.id)} · {run.active_skill ?? "no active skill"}</small></div><div className="align-right"><span className={`status-badge status-${run.status}`}>{run.status}</span><small>{run.failure_code ?? formatDate(run.created_at)}</small></div></div>)}</div> : <p className="empty-state">No agent runs yet.</p>}</div>
          </div>
          {snapshot.eval_runs?.length ? <div className="compact-list spaced-list">{snapshot.eval_runs.map((evaluation) => <div className="compact-row" key={evaluation.id}><div><strong>Eval · {evaluation.version_key ?? "unassigned model"}</strong><small>{shortId(evaluation.id)} · {formatDate(evaluation.created_at)}</small></div><span className={`status-badge status-${evaluation.status}`}>{evaluation.status}</span></div>)}</div> : null}
        </section>

        <section className="control-panel" id="usage">
          <div className="control-section-head"><div><p className="eyebrow">Metering</p><h2>Usage</h2></div><span className="panel-count">{snapshot.usage_monthly?.length ?? 0}</span></div>
          {snapshot.usage_monthly?.length ? <div className="compact-list">{snapshot.usage_monthly.map((usage) => <div className="compact-row" key={`${usage.organization_id}:${usage.usage_month}`}><div><strong>{usage.organization_name ?? shortId(usage.organization_id)}</strong><small>{usage.usage_month}</small></div><code className="usage-json">{JSON.stringify(usage.totals)}</code></div>)}</div> : <p className="empty-state">Usage aggregation starts when agent runs begin.</p>}
        </section>

        <section className="control-panel" id="audit">
          <div className="control-section-head"><div><p className="eyebrow">Observability</p><h2>Audit & runtime errors</h2></div><span className="panel-count">{snapshot.errors?.length ?? 0}</span></div>
          <div className="control-split">
            <div><h3>Audit trail</h3>{snapshot.audit?.length ? <div className="compact-list">{snapshot.audit.slice(0, 20).map((event) => <div className="compact-row" key={event.id}><div><strong>{event.event_type}</strong><small>{event.target_type}:{shortId(event.target_id)} · {formatDate(event.occurred_at)}</small></div><span className={`status-badge status-${event.outcome}`}>{event.outcome}</span></div>)}</div> : <p className="empty-state">No audit events yet.</p>}</div>
            <div><h3>Runtime errors</h3>{snapshot.errors?.length ? <div className="compact-list">{snapshot.errors.slice(0, 20).map((event) => <div className="compact-row" key={`${event.trace_id}:${event.occurred_at}`}><div><strong>{event.service} · {event.event_name}</strong><small>{event.trace_id} · {formatDate(event.occurred_at)}</small></div><span className="status-badge status-failed">error</span></div>)}</div> : <p className="empty-state">No recorded runtime errors.</p>}</div>
          </div>
        </section>
      </section>
    </div>
  </main>;
}
