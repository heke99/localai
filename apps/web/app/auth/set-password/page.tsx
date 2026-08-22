import Link from "next/link";
import { SetPasswordClient } from "./set-password-client";

export default function SetPasswordPage() {
  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Secure account setup</div>
      <h1>Välj ditt lösenord.</h1>
      <p className="lead">När lösenordet är sparat aktiveras din workspace och dina beviljade rättigheter.</p>
      <SetPasswordClient />
    </section>
  </main>;
}
