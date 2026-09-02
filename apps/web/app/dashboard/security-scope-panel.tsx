"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type LabProject = { id: string; name: string; mode: string };
type ScopeResponse = {
  scope?: {
    projectId?: string;
    resourceId?: string;
    allowHosts?: string[];
    allowIpv4Cidrs?: string[];
    active?: boolean;
    capabilities?: string[];
  } | null;
  error?: string;
};

function parseTargets(value: string) {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

export function SecurityScopePanel({ projects }: { projects: LabProject[] }) {
  const labProjects = useMemo(() => projects.filter((project) => project.mode === "lab"), [projects]);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [hosts, setHosts] = useState("");
  const [cidrs, setCidrs] = useState("");
  const [active, setActive] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [authorizationNote, setAuthorizationNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && labProjects[0]?.id) setProjectId(labProjects[0].id);
    if (projectId && !labProjects.some((project) => project.id === projectId)) setProjectId(labProjects[0]?.id ?? "");
  }, [labProjects, projectId]);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    setMessage(null);
    void fetch(`/api/security-scopes?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json() as ScopeResponse }))
      .then(({ response, body }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(body.error ?? "security_scope_load_failed");
        setHosts((body.scope?.allowHosts ?? []).join("\n"));
        setCidrs((body.scope?.allowIpv4Cidrs ?? []).join("\n"));
        setActive(body.scope?.active === true);
        setAuthorized(false);
        setAuthorizationNote("");
        setMessage(body.scope?.resourceId ? "Ett auktoriserat scope finns för projektet." : "Inget security scope är konfigurerat ännu.");
      })
      .catch(() => {
        if (!cancelled) setMessage("Security scope kunde inte läsas. Kontrollera att databasmigrationen är applicerad.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!projectId || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/security-scopes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          allowHosts: parseTargets(hosts),
          allowIpv4Cidrs: parseTargets(cidrs),
          active,
          authorized,
          authorizationNote
        })
      });
      const body = await response.json() as ScopeResponse;
      if (!response.ok || !body.scope?.resourceId) throw new Error(body.error ?? "security_scope_save_failed");
      setHosts((body.scope.allowHosts ?? []).join("\n"));
      setCidrs((body.scope.allowIpv4Cidrs ?? []).join("\n"));
      setActive(body.scope.active === true);
      setAuthorized(false);
      setAuthorizationNote("");
      setMessage("Sparat. Agent → Lab får nu security_scan för exakt dessa mål.");
    } catch (error) {
      const code = error instanceof Error ? error.message : "security_scope_save_failed";
      setMessage(code === "invalid_security_scope"
        ? "Scope:t är ogiltigt. Ange hostnamn/IP eller IPv4-CIDR utan wildcard och kontrollera auktoriseringen."
        : code === "security_scope_access_denied"
          ? "Scope:t kunde inte sparas: projektåtkomst, Lab-behörighet eller uttrycklig auktorisering saknas."
          : "Scope:t kunde inte sparas. Kontrollera migration/API och försök igen.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Konfigurera Lab security scope"
      style={{ position: "fixed", right: 132, top: 14, zIndex: 48, minHeight: 36, border: "1px solid #34373e", borderRadius: 999, padding: "0 12px", background: "#181a1e", color: "#e2e3e5", boxShadow: "0 8px 24px rgba(0,0,0,.25)", cursor: "pointer", font: "12px/1 system-ui, sans-serif" }}
    >Lab scope</button>

    {open ? <div
      role="dialog"
      aria-modal="true"
      aria-label="Lab security scope"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", padding: 18, background: "rgba(0,0,0,.68)" }}
    >
      <form onSubmit={save} style={{ width: "min(620px, 100%)", maxHeight: "calc(100vh - 36px)", overflowY: "auto", border: "1px solid #34373e", borderRadius: 16, background: "#131519", color: "#eceef1", padding: 20, boxShadow: "0 24px 80px rgba(0,0,0,.5)", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Lab security scope</h2>
            <p style={{ margin: "8px 0 0", color: "#969ba5", lineHeight: 1.5, fontSize: 13 }}>Agenten får bara köra säkerhetsverktyg mot mål som anges här. Prompten kan aldrig utöka scope:t.</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} style={{ border: 0, background: "transparent", color: "#aeb2ba", cursor: "pointer", fontSize: 20 }}>×</button>
        </div>

        {!labProjects.length ? <div style={{ marginTop: 20, border: "1px solid #3a3d44", borderRadius: 10, padding: 12, color: "#c7cad0", fontSize: 13 }}>Skapa ett projekt med läget Lab först. Security scope binds till ett Lab-projekt, aldrig globalt.</div> : <>
          <label style={{ display: "grid", gap: 7, marginTop: 20, fontSize: 13 }}>
            <span>Lab-projekt</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={saving} style={{ minHeight: 40, border: "1px solid #34373e", borderRadius: 9, background: "#1a1d22", color: "#eceef1", padding: "0 10px" }}>
              {labProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>

          <label style={{ display: "grid", gap: 7, marginTop: 16, fontSize: 13 }}>
            <span>Tillåtna hosts / IP-adresser</span>
            <textarea rows={4} value={hosts} onChange={(event) => setHosts(event.target.value)} disabled={loading || saving} placeholder={"example.com\n203.0.113.10"} style={{ border: "1px solid #34373e", borderRadius: 9, background: "#1a1d22", color: "#eceef1", padding: 10, resize: "vertical", font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace" }} />
            <small style={{ color: "#858b95" }}>Ett mål per rad. Inga wildcard eller URL-scheman.</small>
          </label>

          <label style={{ display: "grid", gap: 7, marginTop: 16, fontSize: 13 }}>
            <span>Tillåtna IPv4-CIDR (valfritt)</span>
            <textarea rows={3} value={cidrs} onChange={(event) => setCidrs(event.target.value)} disabled={loading || saving} placeholder="203.0.113.0/28" style={{ border: "1px solid #34373e", borderRadius: 9, background: "#1a1d22", color: "#eceef1", padding: 10, resize: "vertical", font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace" }} />
          </label>

          <label style={{ display: "flex", gap: 10, alignItems: "start", marginTop: 18, fontSize: 13, lineHeight: 1.45 }}>
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={saving} style={{ marginTop: 2 }} />
            <span><strong>Aktiva tester</strong><br /><span style={{ color: "#8f949e" }}>Ger även capability <code>security.active</code>. Passiva HTTP/TLS/DNS-kontroller fungerar utan detta.</span></span>
          </label>

          <label style={{ display: "grid", gap: 7, marginTop: 16, fontSize: 13 }}>
            <span>Auktoriseringsnotering (valfritt)</span>
            <input value={authorizationNote} maxLength={500} onChange={(event) => setAuthorizationNote(event.target.value)} disabled={saving} placeholder="T.ex. internt system / kundens skriftliga tillstånd" style={{ minHeight: 40, border: "1px solid #34373e", borderRadius: 9, background: "#1a1d22", color: "#eceef1", padding: "0 10px" }} />
          </label>

          <label style={{ display: "flex", gap: 10, alignItems: "start", marginTop: 18, border: "1px solid #3a3d44", borderRadius: 10, padding: 12, fontSize: 13, lineHeight: 1.45 }}>
            <input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} disabled={saving} style={{ marginTop: 2 }} />
            <span>Jag bekräftar att jag har rätt att säkerhetstesta exakt de mål som anges ovan.</span>
          </label>

          {message ? <div role="status" style={{ marginTop: 16, border: "1px solid #34373e", borderRadius: 9, padding: 10, color: "#c8ccd3", fontSize: 13 }}>{message}</div> : null}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" onClick={() => setOpen(false)} disabled={saving} style={{ minHeight: 38, border: "1px solid #34373e", borderRadius: 9, background: "transparent", color: "#d5d8dd", padding: "0 12px", cursor: "pointer" }}>Stäng</button>
            <button type="submit" disabled={saving || loading || !authorized || (!parseTargets(hosts).length && !parseTargets(cidrs).length)} style={{ minHeight: 38, border: 0, borderRadius: 9, background: "#e9eaec", color: "#111318", padding: "0 14px", fontWeight: 700, cursor: "pointer", opacity: saving || loading || !authorized ? .55 : 1 }}>{saving ? "Sparar…" : "Spara auktoriserat scope"}</button>
          </div>
        </>}
      </form>
    </div> : null}
  </>;
}
