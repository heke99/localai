import Link from "next/link";
import { SetPasswordClient, type PasswordMode } from "./set-password-client";

const allowedModes = new Set<PasswordMode>(["onboarding", "recovery", "change"]);

export default async function SetPasswordPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode: rawMode } = await searchParams;
  const mode: PasswordMode = rawMode && allowedModes.has(rawMode as PasswordMode)
    ? rawMode as PasswordMode
    : "recovery";

  const copy = mode === "onboarding"
    ? {
        eyebrow: "Secure account setup",
        title: "Välj ditt lösenord.",
        lead: "När lösenordet är sparat aktiveras din workspace och dina beviljade rättigheter."
      }
    : mode === "change"
      ? {
          eyebrow: "Account security",
          title: "Ändra lösenord.",
          lead: "Bekräfta ditt nuvarande lösenord och välj ett nytt lösenord för kontot."
        }
      : {
          eyebrow: "Account recovery",
          title: "Välj ett nytt lösenord.",
          lead: "Sätt ett nytt lösenord för ditt konto. Återställningslänken är personlig och tidsbegränsad."
        };

  return <main className="shell">
    <nav className="nav"><Link className="brand" href="/">DIV3RSA</Link></nav>
    <section className="hero">
      <div className="eyebrow">{copy.eyebrow}</div>
      <h1>{copy.title}</h1>
      <p className="lead">{copy.lead}</p>
      <SetPasswordClient mode={mode} />
      <div className="actions"><Link href={mode === "change" ? "/dashboard" : "/sign-in"}>{mode === "change" ? "Tillbaka till dashboard" : "Till inloggning"}</Link></div>
    </section>
  </main>;
}
