import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { AgentConsole } from "./agent-console";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in");

  const isSuperadmin = user.app_metadata.system_role === "superadmin";
  if (isSuperadmin) {
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  }

  const { data: profile } = await supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle();

  let workspace: { id: string; name: string } | null = null;
  if (isSuperadmin) {
    const { data: internalOrganization } = await supabase.from("organizations").select("id").eq("slug", "div3rsa-internal").maybeSingle();
    if (internalOrganization) {
      const { data: internalWorkspaces } = await supabase
        .from("workspaces")
        .select("id,name")
        .eq("organization_id", internalOrganization.id)
        .order("created_at", { ascending: true })
        .limit(1);
      workspace = internalWorkspaces?.[0] ?? null;
    }
  } else {
    const { data: workspaces } = await supabase.from("workspaces").select("id,name").order("created_at", { ascending: true }).limit(1);
    workspace = workspaces?.[0] ?? null;
  }

  if (!workspace) {
    if (isSuperadmin) redirect("/superadmin");
    redirect("/auth/accepted");
  }

  return <main className="shell">
    <nav className="nav dashboard-nav">
      <div className="dashboard-brand"><span className="brand">DIV3RSA</span><span className="workspace-chip">{workspace.name}</span></div>
      <div className="dashboard-account"><span className="muted">{profile?.display_name ?? user.email}</span>{isSuperadmin ? <span className="status-badge">superadmin</span> : null}</div>
      <div className="dashboard-nav-actions">{isSuperadmin ? <Link className="button" href="/superadmin">Control plane</Link> : null}<form action="/auth/signout" method="post"><button className="button" type="submit">Logga ut</button></form></div>
    </nav>
    <AgentConsole workspaceId={workspace.id} />
  </main>;
}
