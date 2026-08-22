import Link from "next/link";

const workModes = [
  { number: "01", title: "Chat", text: "Resonera, planera och fatta bättre beslut med hela sammanhanget samlat." },
  { number: "02", title: "Code", text: "Förstå kodbaser, genomför ändringar och verifiera dem med riktiga tester." },
  { number: "03", title: "Research", text: "Undersök komplexa frågor och få ett tydligt svar med spårbara källor." },
  { number: "04", title: "Lab", text: "Arbeta med auktoriserad säkerhetsanalys i en avgränsad och dokumenterad miljö." }
];

const outcomes = ["Plan som går att agera på", "Ändringar som är testade", "Källor som går att följa", "Arbete som går att återuppta"];

export default function Home() {
  return <main className="shell public-home">
    <nav className="nav public-nav">
      <Link className="brand" href="/" aria-label="DIV3RSA startsida">DIV3RSA</Link>
      <div className="navlinks public-navlinks"><a href="#capabilities">Vad du får</a><a href="#workflow">Så fungerar det</a></div>
      <div className="nav-actions"><Link className="nav-signin" href="/sign-in">Logga in</Link><Link className="button nav-cta" href="/request-access">Ansök om åtkomst</Link></div>
    </nav>

    <section className="public-hero">
      <div className="hero-copy">
        <div className="availability"><span className="availability-dot" aria-hidden="true"/>Privat tillgång för utvalda användare</div>
        <h1>Från komplex uppgift till <span>verifierat resultat.</span></h1>
        <p className="hero-lead">DIV3RSA samlar analys, kod, research och säkerhetsarbete i en fokuserad arbetsyta. Du beskriver målet. Systemet hjälper dig hela vägen från första tanke till färdigt, kontrollerat arbete.</p>
        <div className="hero-actions"><Link className="button primary hero-primary" href="/request-access">Ansök om åtkomst <span aria-hidden="true">↗</span></Link><Link className="text-link" href="#capabilities">Se vad du får <span aria-hidden="true">↓</span></Link></div>
        <div className="trust-line" aria-label="Viktiga produktegenskaper"><span>Privat arbetsyta</span><span>Spårbara resultat</span><span>Mänsklig kontroll</span></div>
      </div>

      <div className="work-preview" aria-label="Exempel på ett arbetsflöde">
        <div className="preview-top"><span className="preview-kicker">Aktivt arbete</span><span className="live-indicator"><i aria-hidden="true"/> Pågår</span></div>
        <div className="preview-title"><span>Repository review</span><strong>Förbered release</strong></div>
        <div className="work-steps">
          <div className="work-step done"><span className="step-mark">✓</span><div><strong>Förstå uppgiften</strong><small>Krav och beroenden kartlagda</small></div><em>klar</em></div>
          <div className="work-step active"><span className="step-mark">02</span><div><strong>Genomför ändringarna</strong><small>Arbetar genom berörda filer</small></div><em>nu</em></div>
          <div className="work-step"><span className="step-mark">03</span><div><strong>Verifiera resultatet</strong><small>Tester, build och slutkontroll</small></div><em>nästa</em></div>
        </div>
        <div className="preview-footer"><span>Allt arbete sparas och kan följas</span><span className="preview-progress"><i/></span></div>
      </div>
    </section>

    <div className="proof-strip" aria-label="Vad systemet levererar">{outcomes.map((outcome) => <span key={outcome}><i aria-hidden="true"/> {outcome}</span>)}</div>

    <section className="capability-section" id="capabilities">
      <div className="section-heading"><p className="section-label">Fyra sätt att arbeta</p><h2>En arbetsyta för det som kräver mer.</h2><p>Välj arbetssätt efter uppgiften. Kontext, historik och resultat följer med utan att du behöver börja om.</p></div>
      <div className="mode-grid">{workModes.map((mode) => <article className="mode-card" key={mode.title}><span>{mode.number}</span><div><h3>{mode.title}</h3><p>{mode.text}</p></div><span className="mode-arrow" aria-hidden="true">↗</span></article>)}</div>
    </section>

    <section className="workflow-section" id="workflow">
      <div className="workflow-copy"><p className="section-label">Från brief till bevis</p><h2>Du behåller kontrollen. Systemet driver arbetet framåt.</h2></div>
      <ol className="workflow-list">
        <li><span>1</span><div><strong>Beskriv målet</strong><p>Ge uppgiften, materialet och ramarna som är viktiga.</p></div></li>
        <li><span>2</span><div><strong>Följ arbetet</strong><p>Se planen, framstegen och vad som faktiskt genomförs.</p></div></li>
        <li><span>3</span><div><strong>Få ett verifierat resultat</strong><p>Ta emot svar, kod eller underlag tillsammans med tydliga bevis.</p></div></li>
      </ol>
    </section>

    <section className="public-cta"><div><p className="section-label">Invitation only</p><h2>Redo för ett smartare sätt att arbeta?</h2></div><Link className="button primary hero-primary" href="/request-access">Ansök om åtkomst <span aria-hidden="true">↗</span></Link></section>
    <footer className="public-footer"><span className="brand">DIV3RSA</span><span>En privat arbetsyta för avancerat arbete.</span><span>© 2026</span></footer>
  </main>;
}
