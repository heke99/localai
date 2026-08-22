"use client";

import { FormEvent, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "../../../lib/supabase/client";

export function SetPasswordClient() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < 12) return setError("Lösenordet måste vara minst 12 tecken.");
    if (password !== confirmPassword) return setError("Lösenorden matchar inte.");

    setBusy(true);
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      setBusy(false);
      return setError("Lösenordslänken är ogiltig eller har gått ut. Begär en ny länk via administratören.");
    }

    const { error: passwordError } = await supabase.auth.updateUser({ password });
    if (passwordError) {
      setBusy(false);
      return setError("Lösenordet kunde inte sparas. Välj ett starkare lösenord och försök igen.");
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
