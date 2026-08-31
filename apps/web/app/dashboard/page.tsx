import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { SubscriptionSettingsCard } from "./subscription-settings-card";
import { WorkspaceShellV6 } from "./workspace-shell-v6";

type AuthClaims = {
  sub?: string;
  email?: string;
  app_metadata?: { system_role?: string };
};

type Profile = { display_name: string | null; account_status: string | null };
type Workspace = { id: string; name: string };
type AgentAccess = { allowed?: boolean; accessMode?: string; status?: string };

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: claimsData, error } = await supabase.auth.getClaims();
  const claims = claimsData?.claims as AuthClaims | undefined;
  const userId = claims?.sub;
  if (error || !userId) redirect("/sign-in");

  const isSuperadmin = claims.app_metadata?.system_role === "superadmin";
  let profile: Profile | null = null;
  let workspace: Workspace | null = null;

  if (isSuperadmin) {
    const [{ data: stepUp, error: stepUpError }, { data: profileData }, { data: internalOrganization }] = await Promise.all([
      supabase.rpc("superadmin_email_step_up_status"),
      supabase.from("profiles").select("display_name,account_status").eq("user_id", userId).maybeSingle(),
      supabase.from("organizations").select("id").eq("slug", "div3rsa-internal").maybeSingle()
    ]);

    if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");
    profile = profileData as Profile | null;

    if (internalOrganization) {
      const { data: internalWorkspaces } = await supabase
        .from("workspaces")
        .select("id,name")
        .eq("organization_id", internalOrganization.id)
        .order("created_at", { ascending: true })
        .limit(1);
      workspace = (internalWorkspaces?.[0] ?? null) as Workspace | null;
    }
  } else {
    const [{ data: profileData, error: profileError }, { data: workspaces }] = await Promise.all([
      supabase.from("profiles").select("display_name,account_status").eq("user_id", userId).maybeSingle(),
      supabase.from("workspaces").select("id,name").order("created_at", { ascending: true }).limit(1)
    ]);

    profile = profileData as Profile | null;
    if (!profileError && profile?.account_status === "paused") redirect("/account-paused");
    workspace = (workspaces?.[0] ?? null) as Workspace | null;
  }

  if (!workspace) {
    if (isSuperadmin) redirect("/superadmin");
    redirect("/auth/accepted");
  }

  if (!isSuperadmin) {
    const { data: accessData, error: accessError } = await supabase.rpc("my_agent_access_snapshot", { target_workspace_id: workspace.id });
    if (accessError) throw new Error(accessError.message);
    const access = (accessData ?? {}) as AgentAccess;
    if (!access.allowed) redirect("/billing");
  }

  const { data: snapshotData, error: snapshotError } = await supabase.rpc("workspace_dashboard_snapshot", { target_workspace_id: workspace.id });
  if (snapshotError) throw new Error(snapshotError.message);
  const snapshot = (snapshotData ?? {}) as Parameters<typeof WorkspaceShellV6>[0]["snapshot"];

  return <>
    <WorkspaceShellV6
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      displayName={profile?.display_name ?? claims.email?.split("@")[0] ?? "Konto"}
      email={claims.email ?? ""}
      isSuperadmin={isSuperadmin}
      snapshot={snapshot}
    />
    <SubscriptionSettingsCard isSuperadmin={isSuperadmin} />
  </>;
}
