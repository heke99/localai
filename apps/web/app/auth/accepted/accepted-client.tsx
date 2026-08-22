"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "../../../lib/supabase/client";

type State = "checking" | "sending" | "sent" | "error";

export function AcceptedClient() {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("Bekräftar din inbjudan…");
  const requested = useRef(false);

  useEffect(() => {
    let active = true;
    let timeout = 0;
    let unsubscribe = () => {};

    const start = async () => {
      let supabase;
      try {
        supabase = createSupabaseBrowserClient();
      } catch {
        if (active) {
          setState("error");
          setMessage("Inloggningskonfiguration saknas. Kontakta administratören.");
        }
        return;
      }

      const sendPasswordEmail = async () => {
        if (!active || requested.current) return;
        requested.current = true;
        setState("sending");
        setMessage("E-posten är bekräftad. Skickar nästa mejl…");

        const response = await fetch("/api/onboarding/password-email", { method: "POST" });
        const body = await response.json().catch(() => ({})) as { sent?: boolean; completed?: boolean; error?: string };
        if (!active) return;

        if (response.ok && body.completed) {
          window.location.replace("/dashboard");
          return;
        }
        if (response.ok && body.sent) {
          setState("sent");
          setMessage("Klart. Vi har skickat ett separat mejl där du väljer ditt lösenord.");
          return;
        }

        requested.current = false;
        setState("error");
        setMessage(body.error === "approved_access_grant_required"
          ? "Din inbjudan är verifierad men access är inte färdigprovisionerad. Kontakta administratören."
          : "Det gick inte att skicka lösenordsmejlet. Försök igen.");
      };

      const { data: { session } } = await supabase.auth.getSession();
      if (session) void sendPasswordEmail();

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
    <strong>{state === "sent" ? "Nästa steg: välj lösenord" : "Kontrollerar access"}</strong>
    <p>{message}</p>
    {state === "error" ? <button className="button" type="button" onClick={() => window.location.reload()}>Försök igen</button> : null}
  </div>;
}
