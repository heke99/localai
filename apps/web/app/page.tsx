import Link from "next/link";

const capabilities = [
  ["Code", "Planera, förstå repositories, implementera och verifiera riktiga ändringar."],
  ["Lab", "Isolerade arbetsflöden för auktoriserad säkerhetsanalys och pentest."],
  ["Research", "Källbaserad research med spårbar provenance och färsk information."]
];

export default function Home() {
  return <main className="shell">
    <nav className="nav"><span className="brand">DIV3RSA</span><div className="navlinks"><Link href="/request-access">Request access</Link><Link href="/sign-in">Sign in</Link></div></nav>
    <section className="hero">
      <div className="eyebrow">Private agent intelligence</div>
      <h1>Build, reason and verify without losing control.</h1>
      <p className="lead">En privat, skill-first AI-plattform där modeller och GPU:er kan bytas utan att minne, verktyg, projekt eller operativ kunskap försvinner.</p>
      <div className="actions"><Link className="button primary" href="/request-access">Ansök om åtkomst</Link><Link className="button" href="/sign-in">Öppna systemet</Link></div>
      <div className="grid">{capabilities.map(([title, text]) => <article className="card" key={title}><h2>{title}</h2><p>{text}</p></article>)}</div>
    </section>
  </main>;
}
