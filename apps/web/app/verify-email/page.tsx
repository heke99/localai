import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { sendVerificationCode, verifyEmailCode } from "./actions";

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, Math.min(7, local.length - visible.length)))}@${domain}`;
}

function errorMessage(error?: string, remaining?: string) {
  if (error === "invalid_code") {
    return remaining ? `Koden stämmer inte. ${remaining} försök återstår.` : "Koden stämmer inte. Kontrollera koden och försök igen.";
  }
  if (error === "expired") return "Koden har gått ut. Skicka en ny kod för att fortsätta.";
  if (error === "locked") return "För många felaktiga försök. Verifieringen är tillfälligt låst i 15 minuter.";
  if (error === "send") return "Koden kunde inte skickas just nu. Vänta en kort stund och försök igen.";
  if (error === "verification_failed") return "Verifieringen kunde inte slutföras. Försök igen.";
  return null;
}

export default async function VerifyEmailPage({
  searchParams
}: {
  searchParams: Promise<{ sent?: string; error?: string; remaining?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");

  const { data: status } = await supabase.rpc("superadmin_email_step_up_status");
  if ((status as { verified?: boolean } | null)?.verified) redirect("/superadmin");

  const message = errorMessage(params.error, params.remaining);

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Verifiera inloggningen</div>
      <h1>Kontrollera din e-post.</h1>
      <p className="lead">Ange den sexsiffriga engångskoden som skickats till {maskEmail(user.email ?? "din e-postadress")}.</p>

      {params.sent ? <p role="status">En ny kod har skickats. Koden gäller i 5 minuter.</p> : null}
      {message ? <p className="error" role="alert">{message}</p> : null}

      <form className="form" action={verifyEmailCode}>
        <label className="field">Verifieringskod
          <input
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            required
            autoFocus
            aria-label="Sexsiffrig verifieringskod"
          />
        </label>
        <button className="button primary" type="submit">Verifiera</button>
      </form>

      <div className="actions">
        <form action={sendVerificationCode}><button className="button" type="submit">Skicka ny kod</button></form>
        <form action="/auth/signout" method="post"><button className="button" type="submit">Avbryt</button></form>
      </div>
    </section>
  </main>;
}
