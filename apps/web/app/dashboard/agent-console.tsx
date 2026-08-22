"use client";

import { useEffect, useState } from "react";

type Mode = "chat" | "code" | "lab" | "research";
type Run = { id: string; status: string; mode: string; model_alias: string; failure_code?: string | null; output_content?: string | null };
const modes: Array<{ key: Mode; label: string; description: string }> = [
  { key: "chat", label: "Chat", description: "Reasoning och problemlösning" },
  { key: "code", label: "Code", description: "Kod, repos och verifiering" },
  { key: "lab", label: "Lab", description: "Auktoriserade säkerhetsflöden" },
  { key: "research", label: "Research", description: "Källbaserad research" }
];

export function AgentConsole({ workspaceId }: { workspaceId: string | null }) {
  const [mode, setMode] = useState<Mode>("chat");
  const [prompt, setPrompt] = useState("");
  const [labAuthorizationId, setLabAuthorizationId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || ["completed", "failed", "cancelled", "timed_out"].includes(run.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
      if (response.ok) setRun(await response.json() as Run);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [run]);

  async function submit() {
    if (!workspaceId || !prompt.trim()) return;
    setBusy(true); setError(null);
    const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, mode, prompt, labAuthorizationId: mode === "lab" ? labAuthorizationId : undefined }) });
    const body = await response.json() as { runId?: string; error?: string };
    if (!response.ok || !body.runId) setError(body.error ?? "run_start_failed");
    else { setRun({ id: body.runId, status: "queued", mode, model_alias: `${mode === "chat" ? "general" : mode}-prod` }); setPrompt(""); }
    setBusy(false);
  }

  async function cancel() {
    if (!run) return;
    const response = await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
    if (response.ok) setRun({ ...run, status: "cancelled" });
  }

  return <div className="dashboard">
    <aside className="sidebar"><div className="modes">{modes.map((item) => <button key={item.key} type="button" className={`mode ${mode === item.key ? "active" : ""}`} onClick={() => setMode(item.key)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div></aside>
    <section className="workspace">
      {run && <div className="run-card"><div><span className="status-dot" /> {run.status}</div><small>{run.model_alias} · {run.id.slice(0, 8)}</small>{!["completed", "failed", "cancelled", "timed_out"].includes(run.status) && <button className="button" type="button" onClick={cancel}>Stoppa</button>}{run.failure_code && <p>{run.failure_code}</p>}</div>}
      {run?.output_content && <article className="assistant-output"><div className="eyebrow">Resultat</div><p>{run.output_content}</p></article>}
      <div className="composer"><div className="eyebrow">{mode} session</div><h2>Vad ska vi lösa?</h2>{mode === "lab" && <input className="authorization-input" value={labAuthorizationId} onChange={(event) => setLabAuthorizationId(event.target.value)} aria-label="Lab authorization ID" placeholder="Aktivt authorization-ID krävs" />}<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} aria-label="Message" placeholder="Beskriv uppgiften. Agenten planerar, använder rätt skills och verifierar resultatet." disabled={!workspaceId || busy} /><div className="actions"><span className="muted">{workspaceId ? "Agent-runtime redo · modellworker ej installerad" : "Ingen workspace har tilldelats"}</span><button className="button primary" type="button" onClick={submit} disabled={!workspaceId || !prompt.trim() || busy || (mode === "lab" && !labAuthorizationId)}>{busy ? "Startar…" : "Starta"}</button></div>{error && <p className="error">{error}</p>}</div>
    </section>
  </div>;
}
