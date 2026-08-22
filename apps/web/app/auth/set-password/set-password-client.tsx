"use client";

import { FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "../../../lib/supabase/client";
import { hydrateSessionFromAuthUrl } from "../../../lib/supabase/session-from-url";

export function SetPasswordClient() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < 12) return setError("Lösenordet måste vara minst 12 tecken.");
    if (password !== confirmPassword) return setError("Lösenorden matchar inte.");

    const supabase = createSupabaseBrowserClient();
    setBusy(true);

    try {
      const session = await hydrateSessionFromAuthUrl(supabase);
      if (!session) {
        setBusy(false);
        return setError("Lösenordslänken är ogiltig eller har gått ut. Begär en ny länk via administratören.");
      }
    } catch {
      setBusy(false);
      return setError("Lösenordslänken är ogiltig eller har gått ut. Begär en ny länk via administratören.");
    }

    const { error: passwordError } = await supabase.auth.updateUser({ password });
    if (passwordError) {
      setBusy(false);
      return setError("Lösenordet kunde inte sparas. Välj ett starkare lösenord och försök igen.");
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      setBusy(false);
      return setError("Lösenordet är sparat men kontot kunde inte verifieras. Logga in igen.");
    }

    if (user.app_metadata.system_role === "superadmin") {
      window.location.replace("/mfa");
      return;
    }

    const { error: completeError } = await supabase.rpc("complete_user_onboarding");
    if (completeError) {
      setBusy(false);
      return setError("Lösenordet är sparat, men access kunde inte aktiveras. Kontakta administratören.");
    }

    window.location.replace("/dashboard");
  }

  return <form className="form" onSubmit={submit}>
    <label className="field">Nytt lösenord<input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <label className="field">Bekräfta lösenord<input type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <button className="button primary" type="submit" disabled={busy}>{busy ? "Aktiverar…" : "Spara lösenord och aktivera"}</button>
  </form>;
}
