"use client";

import { FormEvent, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "../../../lib/supabase/client";
import { hydrateSessionFromAuthUrl } from "../../../lib/supabase/session-from-url";

export type PasswordMode = "onboarding" | "recovery" | "change";

export function SetPasswordClient({ mode }: { mode: PasswordMode }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkReady, setLinkReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const consumeLink = async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const session = await hydrateSessionFromAuthUrl(supabase);
        if (!active) return;
        if (!session) {
          setError(mode === "change"
            ? "Du behöver logga in innan du kan ändra lösenord."
            : "Lösenordslänken är ogiltig eller har gått ut. Begär en ny länk via Glömt lösenord.");
          return;
        }
        setLinkReady(true);
      } catch {
        if (active) {
          setError(mode === "change"
            ? "Din session har gått ut. Logga in igen."
            : "Lösenordslänken är ogiltig eller har gått ut. Begär en ny länk via Glömt lösenord.");
        }
      }
    };
    void consumeLink();
    return () => { active = false; };
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!linkReady) return setError(mode === "change" ? "Logga in igen och försök på nytt." : "Verifiera lösenordslänken först.");
    if (password.length < 12) return setError("Lösenordet måste vara minst 12 tecken.");
    if (password !== confirmPassword) return setError("Lösenorden matchar inte.");
    if (mode === "change" && currentPassword.length < 8) return setError("Ange ditt nuvarande lösenord.");

    const supabase = createSupabaseBrowserClient();
    setBusy(true);

    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      setBusy(false);
      return setError("Din session har gått ut. Logga in igen.");
    }

    const passwordAttributes = mode === "change"
      ? { password, current_password: currentPassword }
      : { password };
    const { error: passwordError } = await supabase.auth.updateUser(passwordAttributes);
    if (passwordError) {
      setBusy(false);
      return setError(mode === "change"
        ? "Lösenordet kunde inte ändras. Kontrollera ditt nuvarande lösenord och välj ett starkt nytt lösenord."
        : "Lösenordet kunde inte sparas. Välj ett starkare lösenord eller begär en ny återställningslänk.");
    }

    // A password change/recovery is a security boundary. Revoke every other
    // refresh-token session while keeping this verified session alive.
    if (mode !== "onboarding") {
      const { error: revokeError } = await supabase.auth.signOut({ scope: "others" });
      if (revokeError) {
        setBusy(false);
        return setError("Lösenordet är ändrat, men andra inloggade sessioner kunde inte avslutas. Logga ut alla enheter och logga in igen.");
      }
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      setBusy(false);
      return setError("Lösenordet är sparat men kontot kunde inte verifieras. Logga in igen.");
    }

    if (mode === "onboarding" && user.app_metadata.system_role !== "superadmin") {
      const { error: completeError } = await supabase.rpc("complete_user_onboarding");
      if (completeError) {
        setBusy(false);
        return setError("Lösenordet är sparat, men access kunde inte aktiveras. Kontakta administratören.");
      }
    }

    if (user.app_metadata.system_role === "superadmin") {
      const { data: status } = await supabase.rpc("superadmin_email_step_up_status");
      if ((status as { locked_until?: string | null } | null)?.locked_until) {
        window.location.replace("/verify-email?error=locked");
        return;
      }

      const { error: codeError } = await supabase.auth.reauthenticate();
      if (codeError) {
        window.location.replace("/verify-email?error=send");
        return;
      }

      const { data: begun, error: beginError } = await supabase.rpc("superadmin_begin_email_step_up");
      const beginResult = begun as { started?: boolean; reason?: string } | null;
      window.location.replace(
        beginError || !beginResult?.started
          ? beginResult?.reason === "locked" ? "/verify-email?error=locked" : "/verify-email?error=send"
          : "/verify-email?sent=1"
      );
      return;
    }

    window.location.replace("/dashboard");
  }

  const buttonLabel = mode === "onboarding"
    ? "Spara lösenord och aktivera"
    : mode === "change"
      ? "Ändra lösenord"
      : "Spara nytt lösenord";

  return <form className="form" onSubmit={submit}>
    {mode === "change" ? <label className="field">Nuvarande lösenord<input type="password" autoComplete="current-password" minLength={8} required disabled={!linkReady || busy} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label> : null}
    <label className="field">Nytt lösenord<input type="password" autoComplete="new-password" minLength={12} required disabled={!linkReady || busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <label className="field">Bekräfta nytt lösenord<input type="password" autoComplete="new-password" minLength={12} required disabled={!linkReady || busy} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
    {error ? <p className="error" role="alert">{error}</p> : !linkReady ? <p className="muted" role="status">Verifierar säkerheten…</p> : null}
    <button className="button primary" type="submit" disabled={busy || !linkReady}>{busy ? "Sparar…" : buttonLabel}</button>
  </form>;
}
