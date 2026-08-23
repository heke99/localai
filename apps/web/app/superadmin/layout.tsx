import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export default async function SuperadminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: lifecycle, error } = await supabase
      .from("profiles")
      .select("account_status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!error && lifecycle?.account_status === "paused") redirect("/account-paused");
  }

  return <>
    {children}
    <div style={{ position: "fixed", right: 22, bottom: 22, zIndex: 60, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
      <Link
        href="/superadmin/applications"
        className="button"
        style={{ boxShadow: "0 12px 32px rgba(0,0,0,.22)" }}
      >
        Applications
      </Link>
      <Link
        href="/superadmin/manage"
        className="button primary"
        style={{ boxShadow: "0 12px 32px rgba(0,0,0,.28)" }}
      >
        Management actions
      </Link>
    </div>
  </>;
}
