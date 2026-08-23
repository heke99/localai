import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import { safeReturnPath } from "../../../../lib/integrations/oauth";

function safeUuid(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : "";
}

export default async function VercelSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/sign-in?next=/integrations/vercel/setup");

  const params = await searchParams;
  const workspaceId = safeUuid(params.workspaceId);
  const returnPath = safeReturnPath(Array.isArray(params.returnPath) ? params.returnPath[0] : params.returnPath);
  const clientId = process.env.VERCEL_INTEGRATION_CLIENT_ID?.trim() ?? "";
  const installCommand = clientId
    ? `vercel oauth-apps install --client-id ${clientId} --permission read:project --permission read:deployment --projects '*'`
    : "Vercel App Client ID saknas i production.";
  const retryHref = workspaceId
    ? `/api/integrations/vercel/connect?workspaceId=${encodeURIComponent(workspaceId)}&returnPath=${encodeURIComponent(returnPath)}`
    : "/dashboard?section=integrations";

  return <main className="shell">
    <nav className="nav">
      <Link className="brand" href="/dashboard">DIV3RSA</Link>
      <div className="actions"><Link href="/dashboard?section=integrations">Till integrationer</Link></div>
    </nav>

    <section className="hero">
      <div className="eyebrow">Vercel · projektåtkomst</div>
      <h1>Vercel är inloggat, men projektåtkomst saknas.</h1>
      <p className="lead">
        Identitetsgodkännandet är redan klart. Vercel svarar däremot inte med team/projekt förrän Vercel Appen är installerad med API-behörigheter. Därför skickar vi dig inte runt i OAuth-flödet igen.
      </p>

      <div className="form">
        <div className="field">
          <span>1. Ge Vercel Appen projektåtkomst</span>
          <strong>Välj team och de projekt DIV3RSA får arbeta mot.</strong>
          <small>Minst read:project och read:deployment behövs för discovery. Lägg bara till write-permissions för actions som faktiskt ska kunna ändra Vercel.</small>
        </div>

        <div className="field">
          <span>Verifierad Vercel CLI-metod</span>
          <code style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)" }}>{installCommand}</code>
          <small>Byt `--projects '*'` mot kommaseparerade projekt-ID:n om appen bara ska få åtkomst till vissa projekt. Installationen görs på det Vercel-team som äger projekten.</small>
        </div>

        <div className="field">
          <span>2. Kontrollera igen</span>
          <strong>När installationen är klar kör vi ett nytt fräscht Connect-försök.</strong>
          <small>DIV3RSA markeras inte som anslutet förrän Vercel API faktiskt ger åtkomst till tillåtna projekt.</small>
        </div>

        <div className="actions">
          <Link className="button primary" href={retryHref}>{workspaceId ? "Kontrollera Vercel igen" : "Tillbaka till integrationer"}</Link>
          <Link className="button" href="https://vercel.com/dashboard">Öppna Vercel</Link>
        </div>
      </div>
    </section>
  </main>;
}
