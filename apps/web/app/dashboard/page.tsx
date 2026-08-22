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

  const [{ data: workspaces }, { data: profile }] = await Promise.all([
    supabase.from("workspaces").select("id,name").limit(1),
    supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle()
  ]);
  const workspace = workspaces?.[0] ?? null;

  if (!isSuperadmin && !workspace) redirect("/auth/accepted");

  return <main className="shell">
    <nav className="nav">
      <span className="brand">DIV3RSA</span>
      <span className="eyebrow">general-prod · Q8</span>
      <span className="muted">{profile?.display_name ?? user.email}</span>
      {isSuperadmin ? <Link href="/superadmin">Control plane</Link> : null}
      <form action="/auth/signout" method="post"><button className="button" type="submit">Logga ut</button></form>
    </nav>
    <AgentConsole workspaceId={workspace?.id ?? null} />
  </main>;
}
