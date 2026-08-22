import Link from "next/link";
import { AcceptedClient } from "./accepted-client";

export default function AcceptedPage() {
  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">Access granted</div>
      <h1>Bekräfta konto.</h1>
      <p className="lead">Din första länk verifierar e-postadressen. Därefter skickar vi ett separat, engångsgiltigt mejl där du väljer lösenord.</p>
      <AcceptedClient />
    </section>
  </main>;
}
