import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { WorkspaceShellV4 } from "./workspace-shell-v4";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in");

  const isSuperadmin = user.app_metadata.system_role === "superadmin";
  if (isSuperadmin) {
    const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
    if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");
  }

  const { data: profile } = await supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle();

  let workspace: { id: string; name: string } | null = null;
  if (isSuperadmin) {
    const { data: internalOrganization } = await supabase.from("organizations").select("id").eq("slug", "div3rsa-internal").maybeSingle();
    if (internalOrganization) {
      const { data: internalWorkspaces } = await supabase.from("workspaces").select("id,name").eq("organization_id", internalOrganization.id).order("created_at", { ascending: true }).limit(1);
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

  const { data: snapshotData, error: snapshotError } = await supabase.rpc("workspace_dashboard_snapshot", { target_workspace_id: workspace.id });
  if (snapshotError) throw new Error(snapshotError.message);
  const snapshot = (snapshotData ?? {}) as Parameters<typeof WorkspaceShellV4>[0]["snapshot"];

  return <WorkspaceShellV4
    workspaceId={workspace.id}
    workspaceName={workspace.name}
    displayName={profile?.display_name ?? user.email?.split("@")[0] ?? "Konto"}
    email={user.email ?? ""}
    isSuperadmin={isSuperadmin}
    snapshot={snapshot}
  />;
}
