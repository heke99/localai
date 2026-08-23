import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

export default async function VercelSetupPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in?next=/integrations/vercel/setup");

  const clientId = process.env.VERCEL_INTEGRATION_CLIENT_ID?.trim() ?? "";
  const installCommand = clientId
    ? `vercel oauth-apps install --client-id ${clientId} --permission read:project --permission read:deployment --projects '*'`
    : "Vercel App Client ID saknas i production.";

  return <main className="shell">
    <nav className="nav">
      <Link className="brand" href="/dashboard">DIV3RSA</Link>
      <div className="actions"><Link href="/dashboard?section=integrations">Till integrationer</Link></div>
    </nav>

    <section className="hero">
      <div className="eyebrow">Vercel · projektåtkomst</div>
      <h1>Vercel-kontot är godkänt. Projektåtkomst saknas.</h1>
      <p className="lead">
        Vercels OAuth-godkännande identifierar kontot men ger inte DIV3RSA rätt att läsa team eller projekt.
        Vercel Appen måste dessutom installeras på teamet med uttryckliga projektbehörigheter.
      </p>

      <div className="form">
        <div className="field">
          <span>1. Installera Vercel Appen</span>
          <strong>Välj team och projekt som DIV3RSA får arbeta mot.</strong>
          <small>För minsta fungerande projektlista behövs read:project och read:deployment. Begränsa gärna installationen till valda projekt.</small>
        </div>

        <div className="field">
          <span>Verifierad Vercel CLI-metod</span>
          <code style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)" }}>{installCommand}</code>
          <small>Byt `--projects '*'` mot kommaseparerade projekt-ID:n om appen bara ska få åtkomst till vissa projekt.</small>
        </div>

        <div className="field">
          <span>2. Anslut igen</span>
          <strong>Efter installationen kör du Connect Vercel igen.</strong>
          <small>DIV3RSA markerar inte Vercel som anslutet förrän Vercel API faktiskt låter oss läsa minst en tillåten projektkontext.</small>
        </div>

        <div className="actions">
          <Link className="button primary" href="/dashboard?section=integrations">Tillbaka och anslut igen</Link>
        </div>
      </div>
    </section>
  </main>;
}
