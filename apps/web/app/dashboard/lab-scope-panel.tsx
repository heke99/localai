"use client";

import { FormEvent, useMemo, useState } from "react";

type LabProject = { id: string; name: string; mode: string };
type ExistingResource = { id: string; provider: string; resource_type: string; display_name: string; metadata?: Record<string, unknown> };

type ScopeResponse = {
  scope?: { resourceId?: string; displayName?: string; capabilities?: string[] };
  error?: string;
};

function splitTargets(value: string) {
  return [...new Set(value.split(/[\n,]/g).map((item) => item.trim()).filter(Boolean))];
}

function errorText(code?: string) {
  if (!code) return "Scope kunde inte skapas.";
  if (/permission_denied|project_access_denied/.test(code)) return "Du saknar behörighet att ändra Lab-scope för projektet.";
  if (/lab_project_required/.test(code)) return "Välj ett projekt som är skapat i Lab-läge.";
  if (/blocked_security_scope/.test(code)) return "Lokala, metadata- och andra interna mål är blockerade från Lab-scope.";
  if (/invalid_security_scope_host/.test(code)) return "Ett hostname eller URL är ogiltigt.";
  if (/invalid_security_scope_cidr/.test(code)) return "Ett IPv4-CIDR är ogiltigt. Exempel: 203.0.113.10/32.";
  if (/security_scope_target_required/.test(code)) return "Ange minst ett uttryckligt mål.";
  if (/security_scope_too_large/.test(code)) return "Scope är för stort. Max 32 hostnames och 32 CIDR per scope.";
  if (/Could_not_find_the_function|PGRST202/.test(code)) return "Databasmigrationen för Lab-scope är inte applicerad ännu.";
  return "Scope kunde inte skapas. Kontrollera målet och försök igen.";
}

export function LabScopePanel({ projects, resources }: { projects: LabProject[]; resources: ExistingResource[] }) {
  const labProjects = useMemo(() => projects.filter((project) => project.mode === "lab"), [projects]);
  const existingScopes = useMemo(() => resources.filter((resource) => resource.provider === "security" && resource.resource_type === "security_scope"), [resources]);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(labProjects[0]?.id ?? "");
  const [name, setName] = useState("Authorized target");
  const [hosts, setHosts] = useState("");
  const [cidrs, setCidrs] = useState("");
  const [allowActive, setAllowActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  if (!labProjects.length) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || saving) return;
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const response = await fetch("/api/lab/scopes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          displayName: name.trim(),
          hosts: splitTargets(hosts),
          ipv4Cidrs: splitTargets(cidrs),
          allowActive
        })
      });
      const body = await response.json() as ScopeResponse;
      if (!response.ok || !body.scope?.resourceId) {
        setError(errorText(body.error));
        return;
      }
      setCreated(body.scope.displayName ?? "Lab-scope");
      setHosts("");
      setCidrs("");
      // The dashboard snapshot is server-rendered. Reload once so the newly
      // created scope appears in the ordinary resource picker and can be
      // explicitly selected for the conversation before an agent run starts.
      window.setTimeout(() => window.location.reload(), 450);
    } catch {
      setError("Anslutningen bröts när Lab-scope skulle skapas.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Hantera Lab target scope"
      style={{ position: "fixed", right: 18, top: 58, zIndex: 48, minHeight: 36, border: "1px solid #39414b", borderRadius: 999, padding: "0 12px", background: "#171b20", color: "#e6e8eb", boxShadow: "0 8px 24px rgba(0,0,0,.25)", cursor: "pointer", font: "12px/1 system-ui, sans-serif" }}
    >Lab target{existingScopes.length ? ` · ${existingScopes.length}` : ""}</button>

    {open ? <div role="dialog" aria-modal="true" aria-label="Lab target scope" style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(6,8,11,.72)", display: "grid", placeItems: "center", padding: 18 }}>
      <form onSubmit={submit} style={{ width: "min(620px, 100%)", maxHeight: "calc(100vh - 36px)", overflowY: "auto", border: "1px solid #343b45", borderRadius: 16, background: "#121519", color: "#eef0f2", padding: 18, boxShadow: "0 28px 80px rgba(0,0,0,.5)", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 18 }}>
          <div><strong style={{ display: "block", fontSize: 16 }}>Authorized Lab target</strong><span style={{ display: "block", marginTop: 5, color: "#9aa1aa", fontSize: 12, lineHeight: 1.5 }}>Scope är en faktisk exekveringsgräns. Agenten får inte utöka den från prompten.</span></div>
          <button type="button" onClick={() => setOpen(false)} style={{ border: "1px solid #343b45", borderRadius: 9, background: "transparent", color: "#c9cdd2", padding: "7px 10px", cursor: "pointer" }}>Stäng</button>
        </div>

        <label style={{ display: "grid", gap: 6, marginTop: 18, fontSize: 12, color: "#b8bdc5" }}>Lab-projekt
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} style={{ border: "1px solid #343b45", borderRadius: 9, background: "#191d22", color: "#eef0f2", padding: "10px 11px" }}>
            {labProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>

        <label style={{ display: "grid", gap: 6, marginTop: 14, fontSize: 12, color: "#b8bdc5" }}>Namn på scope
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required style={{ border: "1px solid #343b45", borderRadius: 9, background: "#191d22", color: "#eef0f2", padding: "10px 11px" }} />
        </label>

        <label style={{ display: "grid", gap: 6, marginTop: 14, fontSize: 12, color: "#b8bdc5" }}>Godkända hostnames / HTTPS-URL:er
          <textarea value={hosts} onChange={(event) => setHosts(event.target.value)} rows={4} placeholder={"example.com\napi.example.com"} style={{ resize: "vertical", border: "1px solid #343b45", borderRadius: 9, background: "#191d22", color: "#eef0f2", padding: "10px 11px", font: "13px/1.5 ui-monospace, SFMono-Regular, monospace" }} />
          <span style={{ color: "#7f8791" }}>Ett mål per rad. Ett hostname tillåter även dess subdomäner i security-runtime.</span>
        </label>

        <label style={{ display: "grid", gap: 6, marginTop: 14, fontSize: 12, color: "#b8bdc5" }}>Godkända IPv4-CIDR
          <textarea value={cidrs} onChange={(event) => setCidrs(event.target.value)} rows={3} placeholder={"203.0.113.10/32"} style={{ resize: "vertical", border: "1px solid #343b45", borderRadius: 9, background: "#191d22", color: "#eef0f2", padding: "10px 11px", font: "13px/1.5 ui-monospace, SFMono-Regular, monospace" }} />
        </label>

        <label style={{ display: "flex", alignItems: "start", gap: 10, marginTop: 16, padding: 12, border: "1px solid #343b45", borderRadius: 10, background: "#171a1f", cursor: "pointer" }}>
          <input type="checkbox" checked={allowActive} onChange={(event) => setAllowActive(event.target.checked)} style={{ marginTop: 2 }} />
          <span><strong style={{ display: "block", fontSize: 13 }}>Tillåt aktiva säkerhetskontroller</strong><small style={{ display: "block", marginTop: 4, color: "#8f969f", lineHeight: 1.45 }}>Aktiverar bounded port scan, vulnerability templates och content discovery för just detta scope. Passiva HTTP/TLS/DNS-kontroller är annars standard.</small></span>
        </label>

        <p style={{ margin: "14px 0 0", color: "#8f969f", fontSize: 11, lineHeight: 1.5 }}>Lägg endast till system du äger eller uttryckligen har fått tillstånd att säkerhetstesta. Lokala metadata-/loopbackmål blockeras separat i runtime.</p>
        {error ? <div role="alert" style={{ marginTop: 12, border: "1px solid #5a3232", borderRadius: 9, background: "#241616", color: "#f0c4c4", padding: "9px 10px", fontSize: 12 }}>{error}</div> : null}
        {created ? <div style={{ marginTop: 12, border: "1px solid #34513e", borderRadius: 9, background: "#142019", color: "#c4e8cd", padding: "9px 10px", fontSize: 12 }}>{created} skapades. Uppdaterar resurser…</div> : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 16 }}>
          <button type="button" onClick={() => setOpen(false)} disabled={saving} style={{ border: "1px solid #343b45", borderRadius: 9, background: "transparent", color: "#c9cdd2", padding: "9px 12px", cursor: "pointer" }}>Avbryt</button>
          <button type="submit" disabled={saving || !projectId || !name.trim() || (!hosts.trim() && !cidrs.trim())} style={{ border: 0, borderRadius: 9, background: "#eceef0", color: "#111318", fontWeight: 700, padding: "9px 13px", cursor: saving ? "default" : "pointer", opacity: saving || !projectId || !name.trim() || (!hosts.trim() && !cidrs.trim()) ? .5 : 1 }}>{saving ? "Skapar…" : "Skapa scope"}</button>
        </div>
      </form>
    </div> : null}
  </>;
}
