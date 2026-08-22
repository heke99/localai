import Link from "next/link";
import { requestPasswordReset } from "./actions";

export default async function ForgotPasswordPage({
  searchParams
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Account recovery</div>
      <h1>Glömt lösenord?</h1>
      <p className="lead">Ange e-postadressen för ditt konto. Om kontot finns skickar vi en säker länk där du kan välja ett nytt lösenord.</p>

      {sent ? <div className="card" role="status">
        <strong>Kontrollera din e-post</strong>
        <p>Om adressen är kopplad till ett konto har vi skickat en återställningslänk från DIV3RSA.</p>
      </div> : <form className="form" action={requestPasswordReset}>
        <label className="field">E-post<input name="email" type="email" autoComplete="email" required /></label>
        {error ? <p className="error" role="alert">Ange en giltig e-postadress.</p> : null}
        <button className="button primary" type="submit">Skicka återställningslänk</button>
      </form>}

      <div className="actions"><Link href="/sign-in">Tillbaka till inloggning</Link></div>
    </section>
  </main>;
}
