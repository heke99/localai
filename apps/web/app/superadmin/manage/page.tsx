import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { createPolicySet, enqueueSkillSync, setGpuProviderEnabled, setMembershipStatus, setPolicyStatus } from "./actions";

type Snapshot = {
  users?: Array<{ id: string; email: string; display_name: string; system_role: string }>;
  organizations?: Array<{ id: string; name: string; slug: string }>;
  policies?: Array<{ id: string; organization_id: string | null; organization_name: string | null; key: string; version: number; status: string; rules: number }>;
  gpu_providers?: Array<{ id: string; key: string; enabled: boolean; workers: number }>;
  skills?: Array<{ key: string; category: string; status: string; active_version: number | null }>;
};
type Membership = { organization_id: string; user_id: string; status: string };

export default async function SuperadminManagePage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");
  const [{ data: snapshotData, error: snapshotError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabase.rpc("superadmin_control_snapshot"),
    supabase.from("organization_members").select("organization_id,user_id,status").order("joined_at", { ascending: false }).limit(100)
  ]);
  if (snapshotError) throw new Error(snapshotError.message);
  if (membershipError) throw new Error(membershipError.message);
  const snapshot = (snapshotData ?? {}) as Snapshot;
  const membershipRows = (memberships ?? []) as Membership[];
  const users = new Map((snapshot.users ?? []).map((account) => [account.id, account]));
  const organizations = new Map((snapshot.organizations ?? []).map((organization) => [organization.id, organization]));

  return <main className="shell control-shell">
    <nav className="nav control-topbar"><div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Management · verifierad session</span></div><div className="control-top-actions"><Link className="button" href="/superadmin">Control center</Link><Link className="button primary" href="/dashboard">User dashboard</Link></div></nav>
    <section className="control-content" style={{ maxWidth: 1220, margin: "0 auto" }}>
      <header className="control-header"><div><p className="eyebrow">Direct controls</p><h1>Management</h1><p className="lead">High-impact controls for user access, policy, GPU providers and runtime skills. Lab is available to approved users; external actions are controlled by project plugin permissions instead of separate authorization IDs.</p></div></header>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Access</p><h2>User access</h2></div><span className="panel-count">{membershipRows.length}</span></div>{membershipRows.length ? <div className="compact-list">{membershipRows.map((membership) => { const account = users.get(membership.user_id); const organization = organizations.get(membership.organization_id); const protectedAccount = account?.system_role === "superadmin"; return <div className="compact-row" key={`${membership.organization_id}:${membership.user_id}`}><div><strong>{account?.display_name ?? account?.email ?? membership.user_id.slice(0,8)}</strong><small>{account?.email ?? membership.user_id} · {organization?.name ?? membership.organization_id.slice(0,8)}</small></div><form action={setMembershipStatus} className="row-actions"><input type="hidden" name="organizationId" value={membership.organization_id}/><input type="hidden" name="userId" value={membership.user_id}/><span className={`status-badge status-${membership.status}`}>{membership.status}</span>{!protectedAccount ? membership.status === "active" ? <button className="button danger" name="status" value="suspended">Suspend</button> : <button className="button primary" name="status" value="active">Reactivate</button> : <span className="muted">protected</span>}</form></div>; })}</div> : <p className="empty-state">No memberships.</p>}</section>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Policies</p><h2>Create & promote policy</h2></div><span className="panel-count">{snapshot.policies?.length ?? 0}</span></div><form action={createPolicySet} className="control-form lab-form"><label><span>Scope</span><select name="organizationId" defaultValue=""><option value="">Global policy</option>{snapshot.organizations?.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label><span>Policy key</span><input name="key" required maxLength={80}/></label><label><span>Effect</span><select name="effect" defaultValue="deny"><option value="deny">Deny</option><option value="allow">Allow</option></select></label><label><span>Action</span><input name="action" required maxLength={160}/></label><label><span>Resource pattern</span><input name="resourcePattern" required maxLength={1024}/></label><label className="wide-field"><span>Conditions JSON</span><textarea name="conditions" defaultValue="{}"/></label><button className="button primary">Create draft policy</button></form>{snapshot.policies?.length ? <div className="compact-list spaced-list">{snapshot.policies.map((policy) => <div className="compact-row" key={policy.id}><div><strong>{policy.key} · v{policy.version}</strong><small>{policy.organization_name ?? "Global"} · {policy.rules} rules</small></div><form action={setPolicyStatus} className="row-actions"><input type="hidden" name="policySetId" value={policy.id}/><span className={`status-badge status-${policy.status}`}>{policy.status}</span>{policy.status !== "production" ? <button className="button primary" name="status" value="production">Activate</button> : <button className="button" name="status" value="retired">Retire</button>}</form></div>)}</div> : <p className="empty-state">No policy sets yet.</p>}</section>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Compute</p><h2>GPU providers</h2></div><span className="panel-count">{snapshot.gpu_providers?.length ?? 0}</span></div>{snapshot.gpu_providers?.length ? <div className="compact-list">{snapshot.gpu_providers.map((provider) => <div className="compact-row" key={provider.id}><div><strong>{provider.key}</strong><small>{provider.workers} registered workers</small></div><form action={setGpuProviderEnabled} className="row-actions"><input type="hidden" name="providerId" value={provider.id}/><span className={`status-badge ${provider.enabled ? "status-production" : "status-muted"}`}>{provider.enabled ? "enabled" : "disabled"}</span><button className="button" name="enabled" value={provider.enabled ? "false" : "true"}>{provider.enabled ? "Disable" : "Enable"}</button></form></div>)}</div> : <p className="empty-state">No GPU providers registered.</p>}</section>
      <section className="control-panel"><div className="control-section-head"><div><p className="eyebrow">Skills</p><h2>Runtime skill registry</h2></div><span className="panel-count">{snapshot.skills?.length ?? 0}</span></div><form action={enqueueSkillSync} className="control-form quick-operation"><label><span>Pinned skill source</span><input name="resource" required maxLength={2048}/></label><button className="button primary">Queue skill sync</button></form>{snapshot.skills?.length ? <div className="compact-list spaced-list">{snapshot.skills.map((skill) => <div className="compact-row" key={skill.key}><div><strong>{skill.key}</strong><small>{skill.category}</small></div><div className="align-right"><span className={`status-badge status-${skill.status}`}>{skill.status}</span><small>active v{skill.active_version ?? "—"}</small></div></div>)}</div> : <p className="empty-state">No runtime skill version has been promoted yet.</p>}</section>
      <div className="actions" style={{ marginTop: 24 }}><Link className="button" href="/superadmin">Back to control center</Link><Link className="button primary" href="/dashboard">Open workspace</Link></div>
    </section>
  </main>;
}
