import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

const modes = ["Chat", "Code", "Lab", "Research"];

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in");
  if (user.app_metadata.system_role === "superadmin") {
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance?.currentLevel !== "aal2") redirect("/mfa");
  }
  return <main className="shell">
    <nav className="nav"><span className="brand">DIV3RSA</span><span className="eyebrow">general-prod · Q8</span></nav>
    <div className="dashboard">
      <aside className="sidebar"><div className="modes">{modes.map((mode, index) => <div key={mode} className={`mode ${index === 0 ? "active" : ""}`}>{mode}</div>)}</div></aside>
      <section className="workspace"><div className="composer"><div className="eyebrow">New session</div><h2>Vad ska vi lösa?</h2><textarea aria-label="Message" placeholder="Beskriv uppgiften. Agenten planerar, använder rätt skills och verifierar resultatet." /><div className="actions"><button className="button primary">Starta</button></div></div></section>
    </div>
  </main>;
}
