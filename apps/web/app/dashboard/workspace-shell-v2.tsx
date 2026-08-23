"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./workspace-shell-v2.module.css";

type Mode = "chat" | "code" | "lab" | "research";
type Section = Mode | "projects" | "integrations" | "settings";
type ProviderKey = "github" | "supabase" | "vercel";

type Project = { id: string; name: string; description: string | null; created_at: string; updated_at: string; conversation_count: number; repository_count: number };
type Conversation = { id: string; project_id: string | null; mode: Mode; title: string | null; created_at: string; updated_at: string; last_message_at: string | null; selected_resource_ids?: string[] };
type Integration = { id: string; provider: string; external_account_id: string; status: string; created_at: string; capabilities?: Record<string, boolean> };
type Resource = { id: string; connection_id: string; provider: string; resource_type: string; external_resource_id: string; display_name: string; metadata?: Record<string, unknown>; status: string; connection_status: string; provider_capabilities?: string[] };
type ProjectResource = { project_id: string; resource_id: string; enabled: boolean; connection_id: string; provider: string; resource_type: string; external_resource_id: string; display_name: string; metadata?: Record<string, unknown>; capabilities?: string[] };
type Capability = { provider: string; capability: string; label: string; risk: "read" | "write" | "destructive" | "sensitive"; resource_type: string; description?: string | null };
type Message = { id: string; role: string; content: unknown; created_at: string };
type Run = { id: string; conversationId: string; status: string; mode: string; model_alias: string; failure_code?: string | null; output_content?: string | null };
export type WorkspaceSnapshot = { projects?: Project[]; conversations?: Conversation[]; integrations?: Integration[]; available_resources?: Resource[]; project_resources?: ProjectResource[]; capability_catalog?: Capability[] };

const modeMeta: Record<Mode, { label: string; short: string; description: string; placeholder: string }> = {
  chat: { label: "Chat", short: "C", description: "Planera, resonera och arbeta med dina anslutna projektresurser.", placeholder: "Vad vill du få gjort?" },
  code: { label: "Code", short: "</>", description: "Läs, ändra och verifiera kod i de repos du väljer och har gett behörighet till.", placeholder: "Beskriv vad som ska byggas, felsökas eller ändras…" },
  research: { label: "Research", short: "R", description: "Research, analys och arbete med valda datakällor och projektresurser.", placeholder: "Vad vill du undersöka?" },
  lab: { label: "Lab", short: "L", description: "Säkerhetsarbete med samma projekt- och pluginbehörigheter som resten av arbetsytan.", placeholder: "Beskriv uppgiften för det valda projektet…" }
};
const providerMeta: Record<string, { label: string; mark: string }> = { github: { label: "GitHub", mark: "GH" }, supabase: { label: "Supabase", mark: "SB" }, vercel: { label: "Vercel", mark: "▲" } };
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") return (content as { text: string }).text;
  try { return JSON.stringify(content, null, 2); } catch { return ""; }
}
function relative(value?: string | null) {
  if (!value) return ""; const time = new Date(value).getTime(); if (!Number.isFinite(time)) return "";
  const minutes = Math.floor((Date.now() - time) / 60_000); if (minutes < 1) return "nu"; if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} h`; const days = Math.floor(hours / 24); return days < 7 ? `${days} d` : new Intl.DateTimeFormat("sv-SE", { month: "short", day: "numeric" }).format(new Date(value));
}
function providerName(provider: string) { return providerMeta[provider]?.label ?? provider; }

function ResourceGrantCard({ resource, current, catalog, onSave }: { resource: Resource; current?: ProjectResource; catalog: Capability[]; onSave: (resourceId: string, capabilities: string[], enabled: boolean) => Promise<void> }) {
  const available = catalog.filter((cap) => cap.provider === resource.provider && cap.resource_type === resource.resource_type && (resource.provider_capabilities ?? []).includes(cap.capability));
  const [selected, setSelected] = useState<string[]>(current?.capabilities ?? []);
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSelected(current?.capabilities ?? []); setEnabled(current?.enabled ?? false); }, [current?.enabled, current?.resource_id, JSON.stringify(current?.capabilities ?? [])]);
  async function save() { setSaving(true); try { await onSave(resource.id, selected, enabled); } finally { setSaving(false); } }
  return <article className={styles.resourceGrantCard}>
    <div className={styles.resourceGrantHead}><span className={styles.providerMark}>{providerMeta[resource.provider]?.mark ?? resource.provider.slice(0, 2).toUpperCase()}</span><div><strong>{resource.display_name}</strong><small>{providerName(resource.provider)} · {resource.resource_type}</small></div><label className={styles.toggle}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{enabled ? "Aktiv" : "Av"}</span></label></div>
    <div className={styles.capabilityGrid}>{available.map((cap) => <label key={cap.capability} className={`${styles.capabilityOption} ${styles[`risk_${cap.risk}`]}`}><input type="checkbox" checked={selected.includes(cap.capability)} disabled={!enabled} onChange={(event) => setSelected((currentCaps) => event.target.checked ? [...new Set([...currentCaps, cap.capability])] : currentCaps.filter((item) => item !== cap.capability))} /><span><strong>{cap.label}</strong><small>{cap.risk}</small></span></label>)}</div>
    {!available.length && <p className={styles.muted}>Provider-anslutningen har ännu inga synkade capabilities för den här resursen.</p>}
    <div className={styles.resourceGrantFooter}><small>Agenten kan aldrig överskrida provider-accessen eller de capabilities du väljer här.</small><button type="button" disabled={saving || resource.connection_status === "pending"} onClick={() => void save()}>{saving ? "Sparar…" : "Spara behörighet"}</button></div>
  </article>;
}

export function WorkspaceShellV2({ workspaceId, workspaceName, displayName, email, isSuperadmin, snapshot }: { workspaceId: string; workspaceName: string; displayName: string; email: string; isSuperadmin: boolean; snapshot: WorkspaceSnapshot }) {
  const [projects, setProjects] = useState<Project[]>(snapshot.projects ?? []);
  const [conversations, setConversations] = useState<Conversation[]>(snapshot.conversations ?? []);
  const [integrations, setIntegrations] = useState<Integration[]>(snapshot.integrations ?? []);
  const [projectResources, setProjectResources] = useState<ProjectResource[]>(snapshot.project_resources ?? []);
  const resources = snapshot.available_resources ?? [];
  const catalog = snapshot.capability_catalog ?? [];
  const [activeSection, setActiveSection] = useState<Section>("chat");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => (snapshot.conversations ?? []).find((item) => item.mode === "chat")?.id ?? null);
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[]>(() => (snapshot.conversations ?? []).find((item) => item.mode === "chat")?.selected_resource_ids ?? []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [manageProjectId, setManageProjectId] = useState<string>(() => (snapshot.projects ?? [])[0]?.id ?? "");

  const activeMode: Mode = ["projects", "integrations", "settings"].includes(activeSection) ? "chat" : activeSection as Mode;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedResources = projectResources.filter((resource) => resource.project_id === selectedProjectId && resource.enabled && selectedResourceIds.includes(resource.resource_id));
  const selectableResources = projectResources.filter((resource) => resource.project_id === selectedProjectId && resource.enabled && (resource.capabilities?.length ?? 0) > 0);
  const modeConversations = useMemo(() => conversations.filter((conversation) => conversation.mode === activeMode && (!selectedProjectId || conversation.project_id === selectedProjectId)), [activeMode, conversations, selectedProjectId]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.id === selectedConversationId);
    setSelectedResourceIds(conversation?.selected_resource_ids ?? []);
  }, [selectedConversationId, conversations]);

  async function loadConversation(conversationId: string) {
    setLoadingConversation(true); setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
      const body = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "conversation_load_failed");
      setMessages(body.messages ?? []);
    } catch { setMessages([]); setError("Chatten kunde inte laddas. Försök igen."); } finally { setLoadingConversation(false); }
  }
  useEffect(() => { if (!selectedConversationId) { setMessages([]); return; } void loadConversation(selectedConversationId); }, [selectedConversationId]);
  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    const timer = window.setInterval(async () => { const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" }); if (!response.ok) return; const next = await response.json() as Run; const nextRun = { ...next, conversationId: run.conversationId }; setRun(nextRun); if (terminalStatuses.has(next.status)) void loadConversation(run.conversationId); }, 1500);
    return () => window.clearInterval(timer);
  }, [run]);

  function switchMode(mode: Mode) { setActiveSection(mode); setError(null); const candidate = conversations.find((conversation) => conversation.mode === mode && (!selectedProjectId || conversation.project_id === selectedProjectId)); setSelectedConversationId(candidate?.id ?? null); if (!candidate) { setMessages([]); setSelectedResourceIds([]); } }
  function startNewChat(mode: Mode = activeMode, projectId: string | null = selectedProjectId) { setActiveSection(mode); setSelectedProjectId(projectId); setSelectedConversationId(null); setMessages([]); setSelectedResourceIds([]); setRun(null); setError(null); setPrompt(""); }
  function openProject(projectId: string, mode: Mode = activeMode) { setSelectedProjectId(projectId); setActiveSection(mode); const candidate = conversations.find((conversation) => conversation.project_id === projectId && conversation.mode === mode); setSelectedConversationId(candidate?.id ?? null); if (!candidate) { setMessages([]); setSelectedResourceIds([]); } }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!projectName.trim() || busy) return; setBusy(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, name: projectName, description: projectDescription }) });
      const body = await response.json() as { project?: Project; error?: string }; if (!response.ok || !body.project) throw new Error(body.error ?? "project_create_failed");
      const project = { ...body.project, conversation_count: 0, repository_count: 0 }; setProjects((current) => [project, ...current]); setSelectedProjectId(project.id); setManageProjectId(project.id); setProjectName(""); setProjectDescription(""); setProjectFormOpen(false); setActiveSection("projects");
    } catch { setError("Projektet kunde inte skapas. Kontrollera din åtkomst och försök igen."); } finally { setBusy(false); }
  }

  async function ensureConversation(mode: Mode) {
    if (selectedConversationId) return selectedConversationId;
    const response = await fetch("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, projectId: selectedProjectId, mode, title: "Ny chatt" }) });
    const body = await response.json() as { conversation?: Conversation; error?: string }; if (!response.ok || !body.conversation) throw new Error(body.error ?? "conversation_create_failed");
    const conversation = { ...body.conversation, last_message_at: null, selected_resource_ids: selectedResourceIds }; setConversations((current) => [conversation, ...current]); setSelectedConversationId(conversation.id); return conversation.id;
  }

  async function persistConversationResources(next: string[]) {
    setSelectedResourceIds(next);
    if (!selectedConversationId) return;
    setConversations((current) => current.map((conversation) => conversation.id === selectedConversationId ? { ...conversation, selected_resource_ids: next } : conversation));
    const response = await fetch(`/api/conversations/${selectedConversationId}/resources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceIds: next }) });
    if (!response.ok) { setError("Resursvalet kunde inte sparas. Kontrollera projektets behörigheter."); }
  }

  async function submitPrompt() {
    const text = prompt.trim(); if (!text || busy) return; setBusy(true); setError(null);
    try {
      const conversationId = await ensureConversation(activeMode);
      setMessages((current) => [...current, { id: `local-${Date.now()}`, role: "user", content: { text }, created_at: new Date().toISOString() }]); setPrompt("");
      const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, conversationId, mode: activeMode, prompt: text, resourceIds: selectedResourceIds }) });
      const body = await response.json() as { runId?: string; conversationId?: string; error?: string }; if (!response.ok || !body.runId || !body.conversationId) throw new Error(body.error ?? "run_start_failed");
      const title = text.slice(0, 100); setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, title: conversation.title === "Ny chatt" || !conversation.title ? title : conversation.title, updated_at: new Date().toISOString(), last_message_at: new Date().toISOString(), selected_resource_ids: selectedResourceIds } : conversation));
      setRun({ id: body.runId, conversationId: body.conversationId, status: "queued", mode: activeMode, model_alias: `${activeMode === "chat" ? "general" : activeMode}-prod` });
    } catch (caught) { setError(caught instanceof Error && caught.message === "resource_or_access_denied" ? "En vald resurs eller behörighet är inte längre tillgänglig. Uppdatera resursvalet och försök igen." : "Uppgiften kunde inte startas. Försök igen."); } finally { setBusy(false); }
  }

  async function cancelRun() { if (!run) return; const response = await fetch(`/api/runs/${run.id}`, { method: "DELETE" }); if (response.ok) setRun({ ...run, status: "cancelled" }); }
  async function connectProvider(provider: ProviderKey) { setBusy(true); setError(null); try { const response = await fetch("/api/integrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, provider }) }); const body = await response.json() as { connection?: Integration; error?: string }; if (!response.ok || !body.connection) throw new Error(body.error ?? "integration_request_failed"); setIntegrations((current) => [body.connection!, ...current.filter((item) => item.id !== body.connection?.id)]); } catch { setError("Anslutningen kunde inte startas."); } finally { setBusy(false); } }
  async function saveProjectResource(resourceId: string, capabilities: string[], enabled: boolean) { if (!manageProjectId) return; const response = await fetch("/api/projects/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: manageProjectId, resourceId, capabilities, enabled }) }); const body = await response.json() as { binding?: { capabilities?: string[] }; error?: string }; if (!response.ok) { setError("Behörigheten kunde inte sparas. Kontrollera provider-access och försök igen."); return; } const resource = resources.find((item) => item.id === resourceId); if (!resource) return; setProjectResources((current) => { const next: ProjectResource = { project_id: manageProjectId, resource_id: resourceId, enabled, connection_id: resource.connection_id, provider: resource.provider, resource_type: resource.resource_type, external_resource_id: resource.external_resource_id, display_name: resource.display_name, metadata: resource.metadata, capabilities: body.binding?.capabilities ?? capabilities }; return [next, ...current.filter((item) => !(item.project_id === manageProjectId && item.resource_id === resourceId))]; }); }

  const showChat = ["chat", "code", "lab", "research"].includes(activeSection);
  const manageProject = projects.find((project) => project.id === manageProjectId) ?? null;

  return <div className={`${styles.appShell} ${showChat ? "" : styles.appShellWide}`}>
    <aside className={styles.primaryRail}>
      <div className={styles.brandBlock}><Link className={styles.brand} href="/dashboard">DIV3RSA</Link><button className={styles.newButton} type="button" onClick={() => startNewChat()}>＋ <span>Ny chatt</span></button></div>
      <nav className={styles.primaryNav} aria-label="Workspace navigation">{(Object.keys(modeMeta) as Mode[]).map((mode) => <button key={mode} type="button" className={`${styles.navItem} ${activeSection === mode ? styles.navItemActive : ""}`} onClick={() => switchMode(mode)}><span className={styles.navIcon}>{modeMeta[mode].short}</span><span>{modeMeta[mode].label}</span></button>)}<div className={styles.navDivider}/><button className={`${styles.navItem} ${activeSection === "projects" ? styles.navItemActive : ""}`} onClick={() => setActiveSection("projects")}><span className={styles.navIcon}>P</span><span>Projekt</span></button><button className={`${styles.navItem} ${activeSection === "integrations" ? styles.navItemActive : ""}`} onClick={() => setActiveSection("integrations")}><span className={styles.navIcon}>+</span><span>Integrationer</span></button><button className={`${styles.navItem} ${activeSection === "settings" ? styles.navItemActive : ""}`} onClick={() => setActiveSection("settings")}><span className={styles.navIcon}>⚙</span><span>Inställningar</span></button></nav>
      <div className={styles.accountBlock}><div className={styles.avatar}>{displayName.slice(0,1).toUpperCase()}</div><div><strong>{displayName}</strong><small>{workspaceName}</small></div></div>
    </aside>

    {showChat && <aside className={styles.contextSidebar}><div className={styles.contextHeader}><div><small>{modeMeta[activeMode].label}</small><strong>{selectedProject?.name ?? "Alla projekt"}</strong></div><button onClick={() => startNewChat(activeMode)}>＋</button></div><div className={styles.contextScroll}><div className={styles.sideTitle}>Projekt</div><button className={`${styles.filterItem} ${!selectedProjectId ? styles.filterActive : ""}`} onClick={() => { setSelectedProjectId(null); setSelectedConversationId(conversations.find((item) => item.mode === activeMode)?.id ?? null); }}>Alla projekt</button>{projects.map((project) => <button className={`${styles.filterItem} ${selectedProjectId === project.id ? styles.filterActive : ""}`} key={project.id} onClick={() => openProject(project.id, activeMode)}><span>{project.name}</span><small>{conversations.filter((chat) => chat.project_id === project.id && chat.mode === activeMode).length}</small></button>)}<div className={styles.sideTitle}>Chattar</div>{modeConversations.map((conversation) => <button className={`${styles.chatItem} ${selectedConversationId === conversation.id ? styles.chatActive : ""}`} key={conversation.id} onClick={() => setSelectedConversationId(conversation.id)}><span>{conversation.title || "Ny chatt"}</span><small>{relative(conversation.last_message_at || conversation.updated_at)}</small></button>)}{!modeConversations.length && <p className={styles.sideEmpty}>Inga chattar här ännu.</p>}</div></aside>}

    <main className={styles.main}>
      {showChat && <><header className={styles.chatHeader}><div><div className={styles.breadcrumb}>{selectedProject ? `${selectedProject.name} / ` : ""}{modeMeta[activeMode].label}</div><h1>{selectedConversation?.title && selectedConversation.title !== "Ny chatt" ? selectedConversation.title : "Ny chatt"}</h1></div><div className={styles.headerActions}><details className={styles.resourcePicker}><summary>{selectedResources.length ? `${selectedResources.length} resurser` : "Välj resurser"}</summary><div className={styles.resourceMenu}>{!selectedProject && <p>Välj ett projekt för att använda repos och plugins.</p>}{selectedProject && !selectableResources.length && <p>Projektet har inga aktiva plugin-resurser ännu. Lägg till dem under Integrationer.</p>}{selectableResources.map((resource) => <label key={resource.resource_id}><input type="checkbox" checked={selectedResourceIds.includes(resource.resource_id)} onChange={(event) => void persistConversationResources(event.target.checked ? [...new Set([...selectedResourceIds, resource.resource_id])] : selectedResourceIds.filter((id) => id !== resource.resource_id))}/><span className={styles.providerMark}>{providerMeta[resource.provider]?.mark ?? resource.provider.slice(0,2)}</span><span><strong>{resource.display_name}</strong><small>{providerName(resource.provider)} · {(resource.capabilities ?? []).length} rättigheter</small></span></label>)}</div></details><button className={styles.smallButton} onClick={() => startNewChat(activeMode)}>Ny chatt</button></div></header>
        <section className={styles.chatCanvas}>{loadingConversation ? <div className={styles.centerState}>Laddar chatt…</div> : messages.length ? <div className={styles.messageStream}>{messages.map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}><div className={styles.messageMeta}>{message.role === "user" ? "Du" : "DIV3RSA"}</div><div className={styles.messageBody}>{messageText(message.content)}</div></article>)}</div> : <div className={styles.emptyChat}><div className={styles.modeBadge}>{modeMeta[activeMode].short}</div><h2>{selectedProject ? `Arbeta i ${selectedProject.name}` : modeMeta[activeMode].label}</h2><p>{modeMeta[activeMode].description}</p>{selectedProject && <div className={styles.resourceHint}>{selectableResources.length ? "Välj repo eller plugin-resurs uppe till höger. Agenten får endast de capabilities som projektet tillåter." : "Anslut och ge projektet resurser under Integrationer när du vill arbeta direkt mot externa system."}</div>}</div>}{run && <div className={styles.runStrip}><span className={`${styles.runDot} ${terminalStatuses.has(run.status) ? styles.runDotIdle : ""}`}/><strong>{run.status}</strong><span>{run.model_alias}</span>{run.failure_code && <span className={styles.runError}>{run.failure_code}</span>}{!terminalStatuses.has(run.status) && <button onClick={cancelRun}>Stoppa</button>}</div>}</section>
        <footer className={styles.composerWrap}><div className={styles.composer}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } }} placeholder={modeMeta[activeMode].placeholder} disabled={busy} rows={3}/><div className={styles.composerFooter}><div className={styles.composerContext}><span>{selectedProject?.name ?? "Ingen projektmapp"}</span>{selectedResources.map((resource) => <span className={styles.contextChip} key={resource.resource_id}>{providerMeta[resource.provider]?.mark ?? resource.provider} · {resource.display_name}</span>)}</div><button className={styles.sendButton} onClick={() => void submitPrompt()} disabled={busy || !prompt.trim()}>{busy ? "…" : "↑"}</button></div></div>{error && <p className={styles.error}>{error}</p>}</footer></>}

      {activeSection === "projects" && <section className={styles.pageSection}><div className={styles.pageHeader}><div><span className={styles.kicker}>Workspace</span><h1>Projekt</h1><p>Projekt håller ihop chattar och de externa resurser agenten får arbeta med.</p></div><button className={styles.primaryButton} onClick={() => setProjectFormOpen(true)}>＋ Nytt projekt</button></div>{projectFormOpen && <form className={styles.projectForm} onSubmit={createProject}><label>Projektnamn<input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} required autoFocus/></label><label>Beskrivning<textarea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} maxLength={2000} rows={3}/></label><div><button type="button" onClick={() => setProjectFormOpen(false)}>Avbryt</button><button className={styles.primaryButton} disabled={busy}>Skapa</button></div></form>}<div className={styles.projectGrid}>{projects.map((project) => { const chats = conversations.filter((chat) => chat.project_id === project.id); const bound = projectResources.filter((resource) => resource.project_id === project.id && resource.enabled); return <article className={styles.projectCard} key={project.id}><div className={styles.projectMark}>{project.name.slice(0,2).toUpperCase()}</div><h2>{project.name}</h2><p>{project.description || "Inga projektanteckningar ännu."}</p><div className={styles.projectStats}><span>{chats.length} chattar</span><span>{bound.length} resurser</span><span>{bound.filter((resource) => resource.provider === "github").length} repos</span></div><div className={styles.projectModes}>{(Object.keys(modeMeta) as Mode[]).map((mode) => <button key={mode} onClick={() => openProject(project.id, mode)}>{modeMeta[mode].label}</button>)}</div></article>; })}</div>{!projects.length && <div className={styles.bigEmpty}>Skapa ett projekt för att samla chattar, repos och andra integrationer.</div>}</section>}

      {activeSection === "integrations" && <section className={styles.pageSection}><div className={styles.pageHeader}><div><span className={styles.kicker}>Plugins</span><h1>Integrationer & åtkomst</h1><p>Anslut konton centralt. Ge sedan varje projekt endast de resurser och actions agenten behöver.</p></div></div><div className={styles.integrationGrid}>{(["github","supabase","vercel"] as ProviderKey[]).map((provider) => { const connection = integrations.find((item) => item.provider === provider && ["connected","active","ready","pending"].includes(item.status)); const connected = Boolean(connection && ["connected","active","ready"].includes(connection.status)); return <article className={styles.integrationCard} key={provider}><div className={styles.integrationHead}><span className={styles.providerMark}>{providerMeta[provider].mark}</span><div><h2>{providerMeta[provider].label}</h2><p>{provider === "github" ? "Repositories, branches, PR och Actions" : provider === "supabase" ? "Databas, migrations, functions och logs" : "Deployments, logs, environment och domains"}</p></div><span className={`${styles.status} ${connected ? styles.statusOn : ""}`}>{connected ? "Ansluten" : connection?.status === "pending" ? "Väntar" : "Inte ansluten"}</span></div><button disabled={busy || connected || connection?.status === "pending"} onClick={() => void connectProvider(provider)}>{connected ? "Ansluten" : connection?.status === "pending" ? "Begärd" : "Anslut"}</button></article>; })}</div><section className={styles.accessPanel}><div className={styles.accessHeader}><div><span className={styles.kicker}>Project access</span><h2>Resurser & permissions</h2><p>Välj projekt och bestäm exakt vad agenten får läsa, skriva eller utföra.</p></div><select value={manageProjectId} onChange={(event) => setManageProjectId(event.target.value)}><option value="">Välj projekt</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div>{manageProject ? <div className={styles.resourceGrantGrid}>{resources.filter((resource) => ["connected","active","ready"].includes(resource.connection_status)).map((resource) => <ResourceGrantCard key={`${manageProject.id}:${resource.id}`} resource={resource} current={projectResources.find((item) => item.project_id === manageProject.id && item.resource_id === resource.id)} catalog={catalog} onSave={saveProjectResource}/>)}</div> : <div className={styles.bigEmpty}>Välj ett projekt för att konfigurera plugin-resurser.</div>}{manageProject && !resources.some((resource) => ["connected","active","ready"].includes(resource.connection_status)) && <div className={styles.bigEmpty}>När en plugin är ansluten och dess resurser synkats visas repos/projekt här.</div>}</section>{error && <p className={styles.error}>{error}</p>}</section>}

      {activeSection === "settings" && <section className={styles.pageSection}><div className={styles.pageHeader}><div><span className={styles.kicker}>Konto</span><h1>Inställningar</h1><p>Kontosäkerhet, arbetsyta och systemgenvägar.</p></div></div><div className={styles.settingsGrid}><article><span>Konto</span><strong>{displayName}</strong><small>{email}</small><Link href="/auth/set-password?mode=change">Ändra lösenord</Link></article><article><span>Arbetsyta</span><strong>{workspaceName}</strong><small>{projects.length} projekt · {integrations.length} integrationsposter</small><button onClick={() => setActiveSection("integrations")}>Hantera integrationer</button></article>{isSuperadmin && <article><span>System</span><strong>Control Center</strong><small>Modeller, GPU, policies och drift.</small><Link href="/superadmin">Öppna Control Center</Link></article>}<article><span>Session</span><strong>Logga ut</strong><small>Avsluta den aktiva sessionen.</small><form action="/auth/signout" method="post"><button>Logga ut</button></form></article></div></section>}
    </main>
  </div>;
}
