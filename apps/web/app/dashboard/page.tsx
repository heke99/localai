import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { AgentConsole } from "./agent-console";
import Link from "next/link";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in");
  if (user.app_metadata.system_role === "superadmin") {
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  }
  const { data: workspaces } = await supabase.from("workspaces").select("id").limit(1);
  return <main className="shell">
    <nav className="nav"><span className="brand">DIV3RSA</span><span className="eyebrow">general-prod · Q8</span>{user.app_metadata.system_role === "superadmin" ? <Link href="/superadmin">Control plane</Link> : null}</nav>
    <AgentConsole workspaceId={workspaces?.[0]?.id ?? null} />
  </main>;
}
