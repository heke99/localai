"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

function cleanAuthParameters() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.delete("code");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export async function hydrateSessionFromAuthUrl(supabase: SupabaseClient) {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fragmentError = fragment.get("error_description") ?? fragment.get("error");
  if (fragmentError) throw new Error(fragmentError);

  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    if (error) throw error;
    cleanAuthParameters();
    return data.session;
  }

  const code = new URL(window.location.href).searchParams.get("code");
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    cleanAuthParameters();
    return data.session;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}
