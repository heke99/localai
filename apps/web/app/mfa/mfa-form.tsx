"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

export function MfaForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const client = () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("MFA-konfiguration saknas.");
    return createBrowserClient(url, key);
  };
  const enroll = async () => {
    setError(null);
    try {
      const { data, error: enrollError } = await client().auth.mfa.enroll({ factorType: "totp", friendlyName: "DIV3RSA" });
      if (enrollError) return setError("MFA-registreringen kunde inte startas.");
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "MFA-konfiguration saknas."); }
  };
  const verify = async () => {
    setError(null);
    let supabase;
    try { supabase = client(); }
    catch (cause) { return setError(cause instanceof Error ? cause.message : "MFA-konfiguration saknas."); }
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const selectedFactorId = factorId ?? factors?.totp.find((item) => item.status === "verified")?.id;
    if (listError || !selectedFactorId) return setError("Registrera först en TOTP-faktor.");
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: selectedFactorId });
    if (challengeError) return setError("MFA-utmaningen kunde inte startas.");
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: selectedFactorId, challengeId: challenge.id, code });
    if (verifyError) return setError("Koden kunde inte verifieras.");
    window.location.assign("/dashboard");
  };
  return <div className="form">
    {qrCode ? <img src={qrCode} width={220} height={220} alt="QR-kod för DIV3RSA MFA" /> : <button className="button" type="button" onClick={enroll}>Registrera autentiseringsapp</button>}
    <label className="field">Kod från autentiseringsappen<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
    {error ? <p role="alert">{error}</p> : null}
    <button className="button primary" type="button" disabled={code.length !== 6} onClick={verify}>Verifiera</button>
  </div>;
}
