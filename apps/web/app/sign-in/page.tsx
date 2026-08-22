import Link from "next/link";
import { signIn } from "./actions";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Invitation only</div>
      <h1>Sign in.</h1>
      <p className="lead">Konton skapas endast efter godkänd ansökan. Superadmin och andra känsliga roller slutför MFA innan kontrollplanet öppnas.</p>
      {error ? <p role="alert">Inloggningen misslyckades. Kontrollera uppgifterna.</p> : null}
      <form className="form" action={signIn}>
        <label className="field">E-post<input name="email" type="email" autoComplete="email" required /></label>
        <label className="field">Lösenord<input name="password" type="password" autoComplete="current-password" required minLength={8} /></label>
        <button className="button primary" type="submit">Logga in</button>
      </form>
      <div className="actions"><Link href="/request-access">Saknar du inbjudan?</Link></div>
    </section>
  </main>;
}
