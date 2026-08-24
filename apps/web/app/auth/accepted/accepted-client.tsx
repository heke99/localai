"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "../../../lib/supabase/client";
import { hydrateSessionFromAuthUrl } from "../../../lib/supabase/session-from-url";

type State = "checking" | "sending" | "sent" | "error";

export function AcceptedClient() {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("Bekräftar din inbjudan…");
  const [billingCheckoutUrl, setBillingCheckoutUrl] = useState<string | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    let active = true;
    let timeout = 0;
    let unsubscribe = () => {};

    const start = async () => {
      const supabase = createSupabaseBrowserClient();

      const sendPasswordEmail = async () => {
        if (!active || requested.current) return;
        requested.current = true;
        setState("sending");
        setMessage("E-posten är bekräftad. Förbereder ditt konto…");

        const response = await fetch("/api/onboarding/password-email", { method: "POST", cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { sent?: boolean; completed?: boolean; billingCheckoutUrl?: string | null; error?: string };
        if (!active) return;
        setBillingCheckoutUrl(body.billingCheckoutUrl ?? null);

        if (response.ok && body.completed) {
          window.location.replace(body.billingCheckoutUrl ? "/billing" : "/dashboard");
          return;
        }
        if (response.ok && body.sent) {
          setState("sent");
          setMessage(body.billingCheckoutUrl
            ? "Klart. Vi har skickat ett separat mejl där du väljer lösenord. Ditt abonnemang aktiveras efter genomförd betalning."
            : "Klart. Vi har skickat ett separat mejl där du väljer ditt lösenord.");
          return;
        }

        requested.current = false;
        setState("error");
        if (body.error === "approved_access_grant_required") {
          setMessage("Din inbjudan är verifierad men åtkomsten är inte färdigkonfigurerad. Kontakta administratören.");
        } else if (body.error === "onboarding_completion_failed") {
          setMessage("Ditt konto är godkänt men den sista aktiveringen kunde inte slutföras. Försök igen eller kontakta administratören.");
        } else {
          setMessage("Det gick inte att slutföra onboarding. Försök igen.");
        }
      };

      try {
        const session = await hydrateSessionFromAuthUrl(supabase);
        if (session) void sendPasswordEmail();
      } catch {
        if (active) {
          setState("error");
          setMessage("Inbjudningslänken kunde inte verifieras eller har gått ut.");
        }
      }

      const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (nextSession) window.setTimeout(() => void sendPasswordEmail(), 0);
      });
      unsubscribe = () => listener.subscription.unsubscribe();

      timeout = window.setTimeout(() => {
        if (active && !requested.current) {
          setState("error");
          setMessage("Inbjudningslänken kunde inte verifieras eller har gått ut.");
        }
      }, 5000);
    };

    void start();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      unsubscribe();
    };
  }, []);

  return <div className="card" role="status">
    <strong>{state === "sent" ? "Nästa steg" : "Kontrollerar åtkomst"}</strong>
    <p>{message}</p>
    {billingCheckoutUrl ? <a className="button primary" href={billingCheckoutUrl}>Aktivera · 2 000 kr/mån</a> : null}
    {state === "error" ? <button className="button" type="button" onClick={() => window.location.reload()}>Försök igen</button> : null}
  </div>;
}
