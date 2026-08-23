import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import {
  createPolicySet,
  enqueueSkillSync,
  setAccountLifecycleStatus,
  setGpuProviderEnabled,
  setMembershipStatus,
  setPolicyStatus,
  setSubscriptionLifecycleAction
} from "./actions";

type Snapshot = {
  users?: Array<{ id: string; email: string; display_name: string; system_role: string }>;
  organizations?: Array<{ id: string; name: string; slug: string }>;
  policies?: Array<{ id: string; organization_id: string | null; organization_name: string | null; key: string; version: number; status: string; rules: number }>;
  gpu_providers?: Array<{ id: string; key: string; enabled: boolean; workers: number }>;
  skills?: Array<{ key: string; category: string; status: string; active_version: number | null }>;
};
type Membership = { organization_id: string; user_id: string; status: string };
type AccountLifecycle = { user_id: string; account_status: string; account_paused_at: string | null };
type Subscription = { id: string; organization_id: string; provider: string; status: string; requested_action: string | null; current_period_end: string | null };
type WorkspaceRef = { id: string; organization_id: string };

function subscriptionLabel(status: string) {
  const labels: Record<string,string> = {
    inactive: "inactive",
    trialing: "trialing",
    active: "active",
    pause_requested: "pause requested",
    paused: "paused",
    resume_requested: "resume requested",
    past_due: "past due",
    canceled: "canceled"
  };
  return labels[status] ?? status;
}

export default async function SuperadminManagePage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const [snapshotResult, membershipResult, lifecycleResult, subscriptionResult, workspaceResult] = await Promise.all([
    supabase.rpc("superadmin_control_snapshot"),
    supabase.from("organization_members").select("organization_id,user_id,status").order("joined_at", { ascending: false }).limit(100),
    supabase.from("profiles").select("user_id,account_status,account_paused_at").limit(500),
    supabase.from("organization_subscriptions").select("id,organization_id,provider,status,requested_action,current_period_end").order("updated_at", { ascending: false }).limit(200),
    supabase.from("workspaces").select("id,organization_id").order("created_at", { ascending: true }).limit(500)
  ]);

  if (snapshotResult.error) throw new Error(snapshotResult.error.message);
  if (membershipResult.error) throw new Error(membershipResult.error.message);

  const snapshot = (snapshotResult.data ?? {}) as Snapshot;
  const membershipRows = (membershipResult.data ?? []) as Membership[];
  const lifecycleReady = !lifecycleResult.error;
  const lifecycleRows = lifecycleReady ? (lifecycleResult.data ?? []) as AccountLifecycle[] : [];
  const subscriptionReady = !subscriptionResult.error;
  const subscriptions = subscriptionReady ? (subscriptionResult.data ?? []) as Subscription[] : [];
  const workspaceRows = (workspaceResult.data ?? []) as WorkspaceRef[];

  const users = new Map((snapshot.users ?? []).map((account) => [account.id, account]));
  const organizations = new Map((snapshot.organizations ?? []).map((organization) => [organization.id, organization]));
  const lifecycleByUser = new Map(lifecycleRows.map((row) => [row.user_id, row]));
  const workspaceByOrganization = new Map<string,string>();
  for (const workspace of workspaceRows) {
    if (!workspaceByOrganization.has(workspace.organization_id)) workspaceByOrganization.set(workspace.organization_id, workspace.id);
  }

  return <main className="shell control-shell">
    <nav className="nav control-topbar"><div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Management · verifierad session</span></div><div className="control-top-actions"><Link className="button" href="/superadmin">Control center</Link><Link className="button primary" href="/dashboard">User dashboard</Link></div></nav>
    <section className="control-content" style={{ maxWidth: 1220, margin: "0 auto" }}>
      <header className="control-header"><div><p className="eyebrow">Direct controls</p><h1>Management</h1><p className="lead">High-impact controls for account lifecycle, memberships, subscriptions, policy, GPU providers and runtime skills. Account pause is reversible and preserves projects, chats and permissions exactly as they were.</p></div></header>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Accounts</p><h2>Account lifecycle</h2></div><span className="panel-count">{snapshot.users?.length ?? 0}</span></div>
        {!lifecycleReady ? <p className="empty-state">Account lifecycle migration is not active in this environment yet.</p> : snapshot.users?.length ? <div className="compact-list">{snapshot.users.map((account) => {
          const lifecycle = lifecycleByUser.get(account.id);
          const status = lifecycle?.account_status ?? "active";
          return <div className="compact-row" key={account.id}>
            <div><strong>{account.display_name || account.email || account.id.slice(0,8)}</strong><small>{account.email || account.id} · {account.system_role || "user"}{lifecycle?.account_paused_at ? ` · paused ${new Date(lifecycle.account_paused_at).toLocaleDateString("sv-SE")}` : ""}</small></div>
            <form action={setAccountLifecycleStatus} className="row-actions">
              <input type="hidden" name="userId" value={account.id}/>
              <span className={`status-badge ${status === "paused" ? "status-muted" : "status-production"}`}>{status}</span>
              {status === "paused" ? <button className="button primary" name="status" value="active">Reactivate</button> : <button className="button danger" name="status" value="paused">Pause account</button>}
            </form>
          </div>;
        })}</div> : <p className="empty-state">No users.</p>}
      </section>

      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Memberships</p><h2>Organization access</h2></div><span className="panel-count">{membershipRows.length}</span></div>{membershipRows.length ? <div className="compact-list">{membershipRows.map((membership) => { const account = users.get(membership.user_id); const organization = organizations.get(membership.organization_id); const protectedAccount = account?.system_role === "superadmin"; return <div className="compact-row" key={`${membership.organization_id}:${membership.user_id}`}><div><strong>{account?.display_name ?? account?.email ?? membership.user_id.slice(0,8)}</strong><small>{account?.email ?? membership.user_id} · {organization?.name ?? membership.organization_id.slice(0,8)}</small></div><form action={setMembershipStatus} className="row-actions"><input type="hidden" name="organizationId" value={membership.organization_id}/><input type="hidden" name="userId" value={membership.user_id}/><span className={`status-badge status-${membership.status}`}>{membership.status}</span>{!protectedAccount ? membership.status === "active" ? <button className="button danger" name="status" value="suspended">Suspend membership</button> : <button className="button primary" name="status" value="active">Reactivate membership</button> : <span className="muted">system role · use account pause above</span>}</form></div>; })}</div> : <p className="empty-state">No memberships.</p>}</section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Billing</p><h2>Subscriptions</h2></div><span className="panel-count">{subscriptions.length}</span></div>
        {!subscriptionReady ? <p className="empty-state">Subscription lifecycle migration is not active in this environment yet.</p> : subscriptions.length ? <div className="compact-list">{subscriptions.map((subscription) => {
          const organization = organizations.get(subscription.organization_id);
          const workspaceId = workspaceByOrganization.get(subscription.organization_id);
          const pending = ["pause_requested", "resume_requested"].includes(subscription.status);
          const canPause = ["active", "trialing"].includes(subscription.status);
          const canResume = subscription.status === "paused";
          return <div className="compact-row" key={subscription.id}>
            <div><strong>{organization?.name ?? subscription.organization_id.slice(0,8)}</strong><small>{subscription.provider} · provider-confirmed lifecycle{subscription.current_period_end ? ` · period ends ${new Date(subscription.current_period_end).toLocaleDateString("sv-SE")}` : ""}</small></div>
            <form action={setSubscriptionLifecycleAction} className="row-actions">
              {workspaceId ? <input type="hidden" name="workspaceId" value={workspaceId}/> : null}
              <span className={`status-badge status-${subscription.status}`}>{subscriptionLabel(subscription.status)}</span>
              {pending ? <span className="muted">waiting for provider</span> : !workspaceId ? <span className="muted">no workspace</span> : canPause ? <button className="button danger" name="action" value="pause">Pause subscription</button> : canResume ? <button className="button primary" name="action" value="resume">Resume subscription</button> : null}
            </form>
          </div>;
        })}</div> : <p className="empty-state">No configured subscriptions.</p>}
      </section>

      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Policies</p><h2>Create & promote policy</h2></div><span className="panel-count">{snapshot.policies?.length ?? 0}</span></div><form action={createPolicySet} className="control-form lab-form"><label><span>Scope</span><select name="organizationId" defaultValue=""><option value="">Global policy</option>{snapshot.organizations?.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label><span>Policy key</span><input name="key" required maxLength={80}/></label><label><span>Effect</span><select name="effect" defaultValue="deny"><option value="deny">Deny</option><option value="allow">Allow</option></select></label><label><span>Action</span><input name="action" required maxLength={160}/></label><label><span>Resource pattern</span><input name="resourcePattern" required maxLength={1024}/></label><label className="wide-field"><span>Conditions JSON</span><textarea name="conditions" defaultValue="{}"/></label><button className="button primary">Create draft policy</button></form>{snapshot.policies?.length ? <div className="compact-list spaced-list">{snapshot.policies.map((policy) => <div className="compact-row" key={policy.id}><div><strong>{policy.key} · v{policy.version}</strong><small>{policy.organization_name ?? "Global"} · {policy.rules} rules</small></div><form action={setPolicyStatus} className="row-actions"><input type="hidden" name="policySetId" value={policy.id}/><span className={`status-badge status-${policy.status}`}>{policy.status}</span>{policy.status !== "production" ? <button className="button primary" name="status" value="production">Activate</button> : <button className="button" name="status" value="retired">Retire</button>}</form></div>)}</div> : <p className="empty-state">No policy sets yet.</p>}</section>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Compute</p><h2>GPU providers</h2></div><span className="panel-count">{snapshot.gpu_providers?.length ?? 0}</span></div>{snapshot.gpu_providers?.length ? <div className="compact-list">{snapshot.gpu_providers.map((provider) => <div className="compact-row" key={provider.id}><div><strong>{provider.key}</strong><small>{provider.workers} registered workers</small></div><form action={setGpuProviderEnabled} className="row-actions"><input type="hidden" name="providerId" value={provider.id}/><span className={`status-badge ${provider.enabled ? "status-production" : "status-muted"}`}>{provider.enabled ? "enabled" : "disabled"}</span><button className="button" name="enabled" value={provider.enabled ? "false" : "true"}>{provider.enabled ? "Disable" : "Enable"}</button></form></div>)}</div> : <p className="empty-state">No GPU providers registered.</p>}</section>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Skills</p><h2>Runtime skill registry</h2></div><span className="panel-count">{snapshot.skills?.length ?? 0}</span></div><form action={enqueueSkillSync} className="control-form quick-operation"><label><span>Pinned skill source</span><input name="resource" required maxLength={2048}/></label><button className="button primary">Queue skill sync</button></form>{snapshot.skills?.length ? <div className="compact-list spaced-list">{snapshot.skills.map((skill) => <div className="compact-row" key={skill.key}><div><strong>{skill.key}</strong><small>{skill.category}</small></div><div className="align-right"><span className={`status-badge status-${skill.status}`}>{skill.status}</span><small>active v{skill.active_version ?? "—"}</small></div></div>)}</div> : <p className="empty-state">No runtime skill version has been promoted yet.</p>}</section>
      <div className="actions" style={{ marginTop: 24 }}><Link className="button" href="/superadmin">Back to control center</Link><Link className="button primary" href="/dashboard">Open workspace</Link></div>
    </section>
  </main>;
}
