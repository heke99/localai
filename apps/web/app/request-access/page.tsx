import Link from "next/link";

export default function RequestAccessPage() {
  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Invitation only</div>
      <h1>Request access.</h1>
      <p className="lead">Det finns ingen öppen registrering. Skicka en ansökan så granskas behov, användningsområde och behörighetsnivå.</p>
      <form className="form" action="/api/access-requests" method="post">
        <label className="field">Namn<input name="name" required minLength={2} maxLength={120} /></label>
        <label className="field">E-post<input name="email" type="email" required maxLength={320} /></label>
        <label className="field">Organisation<input name="organization" maxLength={160} /></label>
        <label className="field">Vad vill du använda systemet till?<textarea name="use_case" required minLength={20} maxLength={3000} /></label>
        <button className="button primary" type="submit">Skicka ansökan</button>
      </form>
    </section>
  </main>;
}
