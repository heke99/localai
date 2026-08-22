import Link from "next/link";

type SearchParams = Promise<{ submitted?: string; error?: string }>;

export default async function RequestAccessPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const submitted = params.submitted === "1";
  const error = params.error;

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link><Link href="/sign-in">Logga in</Link></nav>
    <section className="hero">
      <div className="eyebrow">Invitation only</div>
      <h1>Request access.</h1>
      <p className="lead">Det finns ingen öppen registrering. Skicka en ansökan så granskas behov, användningsområde och behörighetsnivå.</p>
      {submitted ? <div className="card" role="status"><strong>Ansökan är mottagen.</strong><p>Om access beviljas får du först ett mejl för att bekräfta din e-post. Därefter skickas ett separat mejl där du väljer lösenord.</p></div> : null}
      {error === "invalid" ? <p className="error" role="alert">Kontrollera uppgifterna och försök igen.</p> : null}
      {error === "save" ? <p className="error" role="alert">Ansökan kunde inte sparas just nu. Försök igen.</p> : null}
      {!submitted ? <form className="form" action="/api/access-requests" method="post">
        <label className="field">Namn<input name="name" autoComplete="name" required minLength={2} maxLength={120} /></label>
        <label className="field">E-post<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
        <label className="field">Organisation<input name="organization" autoComplete="organization" maxLength={160} /></label>
        <label className="field">Vad vill du använda systemet till?<textarea name="use_case" required minLength={20} maxLength={3000} /></label>
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}><label>Website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <button className="button primary" type="submit">Skicka ansökan</button>
      </form> : <Link className="button" href="/">Till startsidan</Link>}
    </section>
  </main>;
}
