"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const STORAGE_KEY = "div3rsa-cookie-consent-v1";
const EVENT_NAME = "div3rsa-cookie-consent";

type ConsentChoice = "accepted" | "rejected";

type StoredConsent = {
  version: 1;
  optional: boolean;
  choice: ConsentChoice;
  updatedAt: string;
};

function persist(choice: ConsentChoice) {
  const value: StoredConsent = {
    version: 1,
    optional: choice === "accepted",
    choice,
    updatedAt: new Date().toISOString()
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: value }));
}

export function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [hasChoice, setHasChoice] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    setHasChoice(Boolean(stored));
    setOpen(!stored);
  }, []);

  const choose = (choice: ConsentChoice) => {
    persist(choice);
    setHasChoice(true);
    setOpen(false);
  };

  return <>
    {open ? <div className="cookie-consent" role="dialog" aria-label="Cookieinställningar" aria-live="polite">
      <div className="cookie-consent-copy">
        <strong>Cookies och integritet</strong>
        <p>Vi använder nödvändiga cookies och liknande lagring för inloggning, säkerhet och grundläggande funktioner. Valfria cookies för exempelvis statistik får bara användas efter ditt val.</p>
        <Link href="/legal/cookies">Läs vår cookiepolicy</Link>
      </div>
      <div className="cookie-consent-actions">
        <button type="button" onClick={() => choose("rejected")}>Avvisa valfria</button>
        <button type="button" onClick={() => choose("accepted")}>Tillåt valfria</button>
      </div>
    </div> : null}
    {hasChoice && !open ? <button className="cookie-settings-button" type="button" onClick={() => setOpen(true)} aria-label="Ändra cookieinställningar">Cookieinställningar</button> : null}
  </>;
}
