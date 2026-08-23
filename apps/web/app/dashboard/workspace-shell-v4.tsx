"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./workspace-shell-v3.module.css";

type Mode = "chat" | "code" | "lab" | "research";
type Section = Mode | "projects" | "integrations" | "settings";
type ProviderKey = "github" | "supabase" | "vercel";

type Project = { id: string; name: string; description: string | null; mode: Mode; created_at: string; updated_at: string; conversation_count: number; repository_count: number };
type Conversation = { id: string; project_id: string | null; mode: Mode; title: string | null; created_at: string; updated_at: string; last_message_at: string | null; selected_resource_ids?: string[] };
type Integration = { id: string; provider: string; external_account_id: string; status: string; created_at: string; capabilities?: Record<string, boolean> };
type Resource = { id: string; connection_id: string; provider: string; resource_type: string; external_resource_id: string; display_name: string; metadata?: Record<string, unknown>; status: string; connection_status: string; provider_capabilities?: string[] };
type ProjectResource = { project_id: string; resource_id: string; enabled: boolean; connection_id: string; provider: string; resource_type: string; external_resource_id: string; display_name: string; metadata?: Record<string, unknown>; capabilities?: string[] };
type Capability = { provider: string; capability: string; label: string; risk: "read" | "write" | "destructive" | "sensitive"; resource_type: string; description?: string | null };
type Message = { id: string; role: string; content: unknown; created_at: string };
type Run = { id: string; conversationId: string; status: string; mode: string; model_alias: string; failure_code?: string | null; output_content?: string | null };
export type WorkspaceSnapshot = { projects?: Project[]; conversations?: Conversation[]; integrations?: Integration[]; available_resources?: Resource[]; project_resources?: ProjectResource[]; capability_catalog?: Capability[] };

const modeMeta: Record<Mode, { label: string; short: string; description: string; placeholder: string }> = {
  chat: { label: "Chat", short: "C", description: "Tänk, planera och arbeta med de resurser du väljer för just den här chatten.", placeholder: "Vad vill du få gjort?" },
  code: { label: "Code", short: "</>", description: "Arbeta direkt mot valda repos, databaser och deployments med rätt verktyg i samma kontext.", placeholder: "Beskriv vad som ska byggas, felsökas eller ändras…" },
  research: { label: "Research", short: "R", description: "Undersök, jämför och analysera med valda anslutna resurser som kontext.", placeholder: "Vad vill du undersöka?" },
  lab: { label: "Lab", short: "L", description: "Säkerhetsarbete mot de resurser du uttryckligen väljer och har gett åtkomst till.", placeholder: "Beskriv säkerhetsuppgiften…" }
};
const projectModeOrder: Mode[] = ["code", "research", "lab", "chat"];
const providerMeta: Record<string, { label: string; mark: string; description: string }> = {
  github: { label: "GitHub", mark: "GH", description: "Repos, branches, pull requests och Actions" },
  supabase: { label: "Supabase", mark: "SB", description: "Databas, functions, migrations och logs" },
  vercel: { label: "Vercel", mark: "▲", description: "Projekt, deployments och runtime logs" }
};
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const validSections = new Set<Section>(["chat", "code", "lab", "research", "projects", "integrations", "settings"]);

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") return (content as { text: string }).text;
  try { return JSON.stringify(content, null, 2); } catch { return ""; }
}
function relative(value?: string | null) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "nu";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} d` : new Intl.DateTimeFormat("sv-SE", { month: "short", day: "numeric" }).format(new Date(value));
}
function providerName(provider: string) { return providerMeta[provider]?.label ?? provider; }
function providerMark(provider: string) { return providerMeta[provider]?.mark ?? provider.slice(0, 2).toUpperCase(); }
function resourceKind(resource: Resource) {
  if (resource.provider === "github" && resource.resource_type === "repository") return "Repo";
  if (resource.resource_type === "project") return "Projekt";
  return resource.resource_type;
}

function ResourceGrantCard({ resource, current, catalog, onSave }: { resource: Resource; current?: ProjectResource; catalog: Capability[]; onSave: (resourceId: string, capabilities: string[], enabled: boolean) => Promise<void> }) {
  const available = catalog.filter((cap) => cap.provider === resource.provider && cap.resource_type === resource.resource_type && (resource.provider_capabilities ?? []).includes(cap.capability));
  const [selected, setSelected] = useState<string[]>(current?.capabilities ?? []);
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSelected(current?.capabilities ?? []); setEnabled(current?.enabled ?? false); }, [current?.enabled, current?.resource_id, JSON.stringify(current?.capabilities ?? [])]);
  async function save() { setSaving(true); try { await onSave(resource.id, selected, enabled); } finally { setSaving(false); } }
  return <article className={styles.permissionCard}>
    <div className={styles.permissionHead}><span className={styles.providerBadge}>{providerMark(resource.provider)}</span><div className={styles.permissionIdentity}><strong>{resource.display_name}</strong><small>{providerName(resource.provider)} · {resourceKind(resource)}</small></div><label className={styles.switch}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{enabled ? "Aktiv" : "Av"}</span></label></div>
    <div className={styles.permissionOptions}>{available.map((cap) => <label key={cap.capability} className={`${styles.permissionOption} ${styles[`risk_${cap.risk}`]}`}><input type="checkbox" checked={selected.includes(cap.capability)} disabled={!enabled} onChange={(event) => setSelected((currentCaps) => event.target.checked ? [...new Set([...currentCaps, cap.capability])] : currentCaps.filter((item) => item !== cap.capability))} /><span><strong>{cap.label}</strong><small>{cap.risk}</small></span></label>)}</div>
    {!available.length && <p className={styles.muted}>Den här anslutningen rapporterar inga tillgängliga actions för resursen ännu.</p>}
    <div className={styles.permissionFooter}><small>Read/write kan läggas till automatiskt från chatten. Destructive och sensitive kräver explicit val här.</small><button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Sparar…" : "Spara åtkomst"}</button></div>
  </article>;
}

export function WorkspaceShellV4({ workspaceId, workspaceName, displayName, email, isSuperadmin, snapshot }: { workspaceId: string; workspaceName: string; displayName: string; email: string; isSuperadmin: boolean; snapshot: WorkspaceSnapshot }) {
  const [projects, setProjects] = useState<Project[]>(snapshot.projects ?? []);
  const [conversations, setConversations] = useState<Conversation[]>(snapshot.conversations ?? []);
  const [integrations, setIntegrations] = useState<Integration[]>(snapshot.integrations ?? []);
  const [projectResources, setProjectResources] = useState<ProjectResource[]>(snapshot.project_resources ?? []);
  const [resources, setResources] = useState<Resource[]>(snapshot.available_resources ?? []);
  const catalog = snapshot.capability_catalog ?? [];
  const initialChat = (snapshot.conversations ?? []).find((item) => item.mode === "chat");

  const [activeSection, setActiveSection] = useState<Section>("chat");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialChat?.project_id ?? null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(initialChat?.id ?? null);
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[]>(initialChat?.selected_resource_ids ?? []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [resourceSearch, setResourceSearch] = useState("");
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectCreateMode, setProjectCreateMode] = useState<Mode>("chat");
  const [manageProjectId, setManageProjectId] = useState<string>(() => (snapshot.projects ?? [])[0]?.id ?? "");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedSection = params.get("section") as Section | null;
    if (requestedSection && validSections.has(requestedSection)) setActiveSection(requestedSection);
    const provider = params.get("provider");
    const integrationError = params.get("integrationError");
    if (integrationError) {
      setActiveSection("integrations");
      const label = provider ? providerName(provider) : "Integrationen";
      setError(integrationError === "provider_configuration_missing" ? `${label} är inte konfigurerad ännu.` : integrationError === "access_denied" ? `${label}-åtkomsten godkändes inte.` : `${label} kunde inte anslutas. Försök igen.`);
    } else if (params.get("connected")) { setActiveSection("integrations"); setError(null); }
  }, []);

  const activeMode: Mode = ["projects", "integrations", "settings"].includes(activeSection) ? "chat" : activeSection as Mode;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedResources = resources.filter((resource) => selectedResourceIds.includes(resource.id));
  const connectedResources = resources.filter((resource) => ["connected", "active", "ready"].includes(resource.connection_status));
  const modeProjects = projects.filter((project) => project.mode === activeMode);
  const standaloneChats = conversations.filter((conversation) => conversation.mode === activeMode && conversation.project_id === null);
  const selectedProjectChats = selectedProjectId ? conversations.filter((conversation) => conversation.mode === activeMode && conversation.project_id === selectedProjectId) : [];
  const manageProject = projects.find((project) => project.id === manageProjectId) ?? null;
  const showChat = ["chat", "code", "lab", "research"].includes(activeSection);

  const resourceGroups = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    const filtered = connectedResources.filter((resource) => !query || resource.display_name.toLowerCase().includes(query) || providerName(resource.provider).toLowerCase().includes(query));
    const groups = new Map<string, Resource[]>();
    for (const resource of filtered) groups.set(resource.provider, [...(groups.get(resource.provider) ?? []), resource]);
    return [...groups.entries()].sort(([a], [b]) => providerName(a).localeCompare(providerName(b), "sv"));
  }, [connectedResources, resourceSearch]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.id === selectedConversationId);
    setSelectedResourceIds(conversation?.selected_resource_ids ?? []);
    setRun(null);
  }, [selectedConversationId, conversations]);

  async function loadConversation(conversationId: string) {
    setLoadingConversation(true); setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
      const body = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "conversation_load_failed");
      setMessages(body.messages ?? []);
    } catch { setMessages([]); setError("Chatten kunde inte laddas. Försök igen."); }
    finally { setLoadingConversation(false); }
  }
  useEffect(() => { if (!selectedConversationId) { setMessages([]); return; } void loadConversation(selectedConversationId); }, [selectedConversationId]);
  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
      if (!response.ok) return;
      const next = await response.json() as Run;
      const nextRun = { ...next, conversationId: run.conversationId };
      setRun(nextRun);
      if (terminalStatuses.has(next.status)) void loadConversation(run.conversationId);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [run]);

  function resetChatState() { setSelectedConversationId(null); setMessages([]); setSelectedResourceIds([]); setRun(null); setError(null); setPrompt(""); setResourcePickerOpen(false); }
  function switchMode(mode: Mode) {
    setActiveSection(mode); setError(null);
    const compatibleProjectId = projects.find((project) => project.id === selectedProjectId)?.mode === mode ? selectedProjectId : null;
    setSelectedProjectId(compatibleProjectId);
    const candidate = conversations.find((conversation) => conversation.mode === mode && conversation.project_id === compatibleProjectId);
    setSelectedConversationId(candidate?.id ?? null);
    if (!candidate) { setMessages([]); setSelectedResourceIds([]); }
  }
  function startNewChat(mode: Mode = activeMode, projectId: string | null = null) {
    const project = projectId ? projects.find((item) => item.id === projectId) : null;
    const resolvedProjectId = project?.mode === mode ? projectId : null;
    setActiveSection(mode); setSelectedProjectId(resolvedProjectId); resetChatState();
  }
  function openProject(projectId: string) {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    setSelectedProjectId(project.id); setActiveSection(project.mode);
    const candidate = conversations.find((conversation) => conversation.project_id === project.id && conversation.mode === project.mode);
    setSelectedConversationId(candidate?.id ?? null);
    if (!candidate) { setMessages([]); setSelectedResourceIds([]); }
  }
  function selectConversation(conversation: Conversation) { setActiveSection(conversation.mode); setSelectedProjectId(conversation.project_id); setSelectedConversationId(conversation.id); setResourcePickerOpen(false); }
  function beginProjectCreate(mode: Mode) { setProjectCreateMode(mode); setProjectFormOpen(true); setActiveSection("projects"); setError(null); }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, name: projectName, description: projectDescription, mode: projectCreateMode }) });
      const body = await response.json() as { project?: Project; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? "project_create_failed");
      const project = { ...body.project, conversation_count: 0, repository_count: 0 };
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id); setManageProjectId(project.id);
      setProjectName(""); setProjectDescription(""); setProjectFormOpen(false);
      setActiveSection(project.mode); resetChatState(); setSelectedProjectId(project.id);
    } catch { setError("Projektet kunde inte skapas. Kontrollera din åtkomst och försök igen."); }
    finally { setBusy(false); }
  }

  async function ensureConversation(mode: Mode) {
    if (selectedConversationId) return selectedConversationId;
    const project = selectedProjectId ? projects.find((item) => item.id === selectedProjectId) : null;
    if (project && project.mode !== mode) throw new Error("project_mode_mismatch");
    const response = await fetch("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, projectId: selectedProjectId, mode, title: "Ny chatt" }) });
    const body = await response.json() as { conversation?: Conversation; error?: string };
    if (!response.ok || !body.conversation) throw new Error(body.error ?? "conversation_create_failed");
    const conversation = { ...body.conversation, project_id: selectedProjectId, last_message_at: null, selected_resource_ids: selectedResourceIds };
    setConversations((current) => [conversation, ...current]); setSelectedConversationId(conversation.id); return conversation.id;
  }

  async function persistConversationResources(next: string[]) {
    const previous = selectedResourceIds;
    setSelectedResourceIds(next);
    if (!selectedConversationId) return;
    setConversations((current) => current.map((conversation) => conversation.id === selectedConversationId ? { ...conversation, selected_resource_ids: next } : conversation));
    const response = await fetch(`/api/conversations/${selectedConversationId}/resources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceIds: next }) });
    if (!response.ok) {
      setSelectedResourceIds(previous);
      setConversations((current) => current.map((conversation) => conversation.id === selectedConversationId ? { ...conversation, selected_resource_ids: previous } : conversation));
      setError("Resursen kunde inte läggas till. Kontrollera att anslutningen fortfarande är aktiv och att du har projektåtkomst.");
    } else setError(null);
  }
  function toggleResource(resourceId: string) { const next = selectedResourceIds.includes(resourceId) ? selectedResourceIds.filter((id) => id !== resourceId) : [...new Set([...selectedResourceIds, resourceId])]; void persistConversationResources(next); }

  async function submitPrompt() {
    const text = prompt.trim(); if (!text || busy) return;
    setBusy(true); setError(null);
    try {
      const conversationId = await ensureConversation(activeMode);
      setMessages((current) => [...current, { id: `local-${Date.now()}`, role: "user", content: { text }, created_at: new Date().toISOString() }]); setPrompt("");
      const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, conversationId, mode: activeMode, prompt: text, resourceIds: selectedResourceIds }) });
      const body = await response.json() as { runId?: string; conversationId?: string; error?: string };
      if (!response.ok || !body.runId || !body.conversationId) throw new Error(body.error ?? "run_start_failed");
      const title = text.slice(0, 100);
      setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, title: conversation.title === "Ny chatt" || !conversation.title ? title : conversation.title, updated_at: new Date().toISOString(), last_message_at: new Date().toISOString(), selected_resource_ids: selectedResourceIds } : conversation));
      setRun({ id: body.runId, conversationId: body.conversationId, status: "queued", mode: activeMode, model_alias: `${activeMode === "chat" ? "general" : activeMode}-prod` });
    } catch (caught) { setError(caught instanceof Error && /resource|access|permission|mode/.test(caught.message) ? "Projektet eller en vald resurs passar inte den här arbetsytan längre. Uppdatera valet och försök igen." : "Uppgiften kunde inte startas. Försök igen."); }
    finally { setBusy(false); }
  }
  async function cancelRun() { if (!run) return; const response = await fetch(`/api/runs/${run.id}`, { method: "DELETE" }); if (response.ok) setRun({ ...run, status: "cancelled" }); }
  function connectProvider(provider: ProviderKey) { if (busy) return; setBusy(true); setError(null); const returnPath = "/dashboard?section=integrations"; window.location.assign(`/api/integrations/${provider}/connect?workspaceId=${encodeURIComponent(workspaceId)}&returnPath=${encodeURIComponent(returnPath)}`); }
  async function disconnectProvider(provider: ProviderKey, connectionId: string) {
    if (busy) return;
    const accepted = window.confirm(`Koppla från ${providerName(provider)}? DIV3RSA tappar omedelbart åtkomst till alla ${provider === "github" ? "repos" : "projekt och resurser"} från den här anslutningen tills du ansluter igen.`);
    if (!accepted) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/integrations/${provider}/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, connectionId }) });
      const body = await response.json() as { connection?: { id?: string; status?: string }; error?: string };
      if (!response.ok || !body.connection) throw new Error(body.error ?? "integration_disconnect_failed");
      const disconnectedResourceIds = new Set(resources.filter((resource) => resource.connection_id === connectionId).map((resource) => resource.id));
      setIntegrations((current) => current.map((item) => item.id === connectionId ? { ...item, status: "disconnected" } : item));
      setResources((current) => current.map((resource) => resource.connection_id === connectionId ? { ...resource, status: "disabled", connection_status: "disconnected", provider_capabilities: [] } : resource));
      setProjectResources((current) => current.map((resource) => disconnectedResourceIds.has(resource.resource_id) ? { ...resource, enabled: false, capabilities: [] } : resource));
      setSelectedResourceIds((current) => current.filter((resourceId) => !disconnectedResourceIds.has(resourceId)));
      setConversations((current) => current.map((conversation) => ({ ...conversation, selected_resource_ids: (conversation.selected_resource_ids ?? []).filter((resourceId) => !disconnectedResourceIds.has(resourceId)) })));
    } catch {
      setError(`${providerName(provider)} kunde inte kopplas från. Försök igen.`);
    } finally { setBusy(false); }
  }
  async function saveProjectResource(resourceId: string, capabilities: string[], enabled: boolean) {
    if (!manageProjectId) return;
    const response = await fetch("/api/projects/resources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: manageProjectId, resourceId, capabilities, enabled }) });
    const body = await response.json() as { binding?: { capabilities?: string[] }; error?: string };
    if (!response.ok) { setError("Åtkomsten kunde inte sparas. Kontrollera provider-access och försök igen."); return; }
    const resource = resources.find((item) => item.id === resourceId); if (!resource) return;
    setProjectResources((current) => { const next: ProjectResource = { project_id: manageProjectId, resource_id: resourceId, enabled, connection_id: resource.connection_id, provider: resource.provider, resource_type: resource.resource_type, external_resource_id: resource.external_resource_id, display_name: resource.display_name, metadata: resource.metadata, capabilities: body.binding?.capabilities ?? capabilities }; return [next, ...current.filter((item) => !(item.project_id === manageProjectId && item.resource_id === resourceId))]; });
  }

  return <div className={`${styles.shell} ${showChat ? "" : styles.shellWide}`}>
    <aside className={styles.rail}>
      <div className={styles.brandArea}><Link href="/dashboard" className={styles.brand}>DIV3RSA</Link><button className={styles.newChatButton} type="button" onClick={() => startNewChat(activeMode, null)}><span>＋</span> Ny chatt</button></div>
      <nav className={styles.nav} aria-label="Huvudnavigation">{(Object.keys(modeMeta) as Mode[]).map((mode) => <button key={mode} type="button" className={`${styles.navButton} ${activeSection === mode ? styles.navButtonActive : ""}`} onClick={() => switchMode(mode)}><span className={styles.navGlyph}>{modeMeta[mode].short}</span><span>{modeMeta[mode].label}</span></button>)}<div className={styles.navDivider}/><button className={`${styles.navButton} ${activeSection === "projects" ? styles.navButtonActive : ""}`} onClick={() => setActiveSection("projects")}><span className={styles.navGlyph}>P</span><span>Projekt</span></button><button className={`${styles.navButton} ${activeSection === "integrations" ? styles.navButtonActive : ""}`} onClick={() => setActiveSection("integrations")}><span className={styles.navGlyph}>+</span><span>Integrationer</span></button><button className={`${styles.navButton} ${activeSection === "settings" ? styles.navButtonActive : ""}`} onClick={() => setActiveSection("settings")}><span className={styles.navGlyph}>⚙</span><span>Inställningar</span></button></nav>
      <div className={styles.account}><span className={styles.avatar}>{displayName.slice(0,1).toUpperCase()}</span><div><strong>{displayName}</strong><small>{workspaceName}</small></div></div>
    </aside>

    {showChat && <aside className={styles.chatSidebar}>
      <div className={styles.chatSidebarHeader}><div><small>{modeMeta[activeMode].label}</small><strong>{selectedProject?.name ?? "Fristående"}</strong></div><button type="button" title="Ny fristående chatt" onClick={() => startNewChat(activeMode, null)}>＋</button></div>
      <div className={styles.sidebarScroll}>
        <section className={styles.sidebarSection}><div className={styles.sidebarTitle}><span>Fristående</span><button type="button" onClick={() => startNewChat(activeMode, null)}>＋</button></div>{standaloneChats.map((conversation) => <button key={conversation.id} className={`${styles.chatRow} ${selectedConversationId === conversation.id ? styles.chatRowActive : ""}`} onClick={() => selectConversation(conversation)}><span>{conversation.title || "Ny chatt"}</span><small>{relative(conversation.last_message_at || conversation.updated_at)}</small></button>)}{!standaloneChats.length && <button className={styles.emptyRow} onClick={() => startNewChat(activeMode, null)}>Starta en fristående chatt</button>}</section>
        <section className={styles.sidebarSection}><div className={styles.sidebarTitle}><span>{modeMeta[activeMode].label}-projekt</span><button type="button" title={`Nytt ${modeMeta[activeMode].label}-projekt`} onClick={() => beginProjectCreate(activeMode)}>＋</button></div>{modeProjects.map((project) => <div className={styles.projectTree} key={project.id}><div className={`${styles.projectRow} ${selectedProjectId === project.id ? styles.projectRowActive : ""}`}><button className={styles.projectOpen} onClick={() => openProject(project.id)}><span className={styles.projectDot}/><span>{project.name}</span></button><button className={styles.projectAddChat} title={`Ny chatt i ${project.name}`} onClick={() => startNewChat(project.mode, project.id)}>＋</button></div>{selectedProjectId === project.id && <div className={styles.projectChats}>{selectedProjectChats.map((conversation) => <button key={conversation.id} className={`${styles.chatRow} ${selectedConversationId === conversation.id ? styles.chatRowActive : ""}`} onClick={() => selectConversation(conversation)}><span>{conversation.title || "Ny chatt"}</span><small>{relative(conversation.last_message_at || conversation.updated_at)}</small></button>)}{!selectedProjectChats.length && <button className={styles.emptyRow} onClick={() => startNewChat(project.mode, project.id)}>Skapa första chatten</button>}</div>}</div>)}{!modeProjects.length && <button className={styles.emptyRow} onClick={() => beginProjectCreate(activeMode)}>Skapa ditt första {modeMeta[activeMode].label}-projekt</button>}</section>
      </div>
    </aside>}

    <main className={styles.main}>
      {showChat && <><header className={styles.chatHeader}><div><div className={styles.breadcrumb}>{selectedProject ? selectedProject.name : "Fristående"} <span>/</span> {modeMeta[activeMode].label}</div><h1>{selectedConversation?.title && selectedConversation.title !== "Ny chatt" ? selectedConversation.title : "Ny chatt"}</h1></div><button className={styles.headerNewChat} type="button" onClick={() => startNewChat(activeMode, selectedProjectId)}>＋ Ny chatt</button></header>
        <section className={styles.chatCanvas}>{loadingConversation ? <div className={styles.centerState}>Laddar chatt…</div> : messages.length ? <div className={styles.messageStream}>{messages.map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}><div className={styles.messageMeta}>{message.role === "user" ? "Du" : "DIV3RSA"}</div><div className={styles.messageBody}>{messageText(message.content)}</div></article>)}</div> : <div className={styles.emptyChat}><div className={styles.emptyIcon}>{modeMeta[activeMode].short}</div><h2>{selectedProject ? `Arbeta i ${selectedProject.name}` : "Vad vill du göra?"}</h2><p>{modeMeta[activeMode].description}</p><button className={styles.emptyResourceButton} type="button" onClick={() => setResourcePickerOpen(true)}>＋ Lägg till repo eller resurs</button><small>När relationer kan bevisas kopplar DIV3RSA även in rätt deployment och databas som read-only kontext automatiskt.</small></div>}{run && <div className={styles.runBar}><span className={`${styles.runDot} ${terminalStatuses.has(run.status) ? styles.runDotIdle : ""}`}/><strong>{run.status}</strong><span>{run.model_alias}</span>{run.failure_code && <span className={styles.runError}>{run.failure_code}</span>}{!terminalStatuses.has(run.status) && <button onClick={cancelRun}>Stoppa</button>}</div>}</section>
        <footer className={styles.composerArea}><div className={styles.contextLine}><span className={styles.locationChip}>{selectedProject?.name ?? "Fristående chatt"}</span>{selectedResources.map((resource) => <button type="button" className={styles.resourceChip} key={resource.id} onClick={() => toggleResource(resource.id)} title="Ta bort resurs"><span className={styles.chipMark}>{providerMark(resource.provider)}</span><span>{resource.display_name}</span><span className={styles.chipClose}>×</span></button>)}</div><div className={styles.composer}><button className={`${styles.addResourceButton} ${selectedResources.length ? styles.addResourceButtonActive : ""}`} type="button" title="Lägg till repo, projekt eller plugin" onClick={() => setResourcePickerOpen(true)}>＋</button><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } }} placeholder={modeMeta[activeMode].placeholder} disabled={busy} rows={2}/><button className={styles.sendButton} type="button" onClick={() => void submitPrompt()} disabled={busy || !prompt.trim()}>{busy ? "…" : "↑"}</button></div><div className={styles.composerHelp}><span>{selectedResources.length ? `${selectedResources.length} aktiv${selectedResources.length === 1 ? " resurs" : "a resurser"}` : "Ingen extern resurs vald"}</span><span>Enter för att skicka · Shift+Enter för ny rad</span></div>{error && <p className={styles.error}>{error}</p>}</footer></>}

      {activeSection === "projects" && <section className={styles.page}>
        <div className={styles.pageHeader}><div><span className={styles.kicker}>Arbetsytor</span><h1>Projekt</h1><p>Projekt tillhör en arbetsdel. Ett Code-projekt syns i Code, ett Research-projekt i Research — här ser du allt grupperat.</p></div><button className={styles.primaryButton} onClick={() => { setProjectCreateMode("code"); setProjectFormOpen(true); }}>＋ Nytt projekt</button></div>
        {projectFormOpen && <form className={styles.projectForm} onSubmit={createProject}><label>Typ<select value={projectCreateMode} onChange={(event) => setProjectCreateMode(event.target.value as Mode)}>{projectModeOrder.map((mode) => <option key={mode} value={mode}>{modeMeta[mode].label}</option>)}</select></label><label>Projektnamn<input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} required autoFocus/></label><label>Beskrivning<textarea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} maxLength={2000} rows={3}/></label><div className={styles.formActions}><button type="button" onClick={() => setProjectFormOpen(false)}>Avbryt</button><button className={styles.primaryButton} disabled={busy}>Skapa {modeMeta[projectCreateMode].label}-projekt</button></div></form>}
        {projectModeOrder.map((mode) => { const grouped = projects.filter((project) => project.mode === mode); if (!grouped.length) return null; return <section key={mode}><div className={styles.pageHeader}><div><span className={styles.kicker}>{modeMeta[mode].label}</span><h2>{modeMeta[mode].label}-projekt</h2></div><button onClick={() => beginProjectCreate(mode)}>＋ Nytt</button></div><div className={styles.projectGrid}>{grouped.map((project) => { const chats = conversations.filter((chat) => chat.project_id === project.id); const bound = projectResources.filter((resource) => resource.project_id === project.id && resource.enabled); return <article className={styles.projectCard} key={project.id}><div className={styles.projectCardTop}><span className={styles.projectMark}>{project.name.slice(0,2).toUpperCase()}</span><div><span className={styles.kicker}>{modeMeta[project.mode].label}</span><h2>{project.name}</h2><p>{project.description || "Inga anteckningar ännu."}</p></div></div><div className={styles.projectStats}><span><strong>{chats.length}</strong> chattar</span><span><strong>{bound.length}</strong> resurser</span><span><strong>{bound.filter((resource) => resource.provider === "github").length}</strong> repos</span></div><div className={styles.projectActions}><button className={styles.primaryButton} onClick={() => startNewChat(project.mode, project.id)}>＋ Ny chatt</button><button onClick={() => openProject(project.id)}>Öppna projekt</button></div></article>; })}</div></section>; })}
        {!projects.length && <div className={styles.bigEmpty}><h2>Inga projekt ännu</h2><p>Skapa ett Code-, Research-, Lab- eller Chat-projekt. Fristående chattar fungerar fortfarande utan projekt.</p><div><button className={styles.primaryButton} onClick={() => { setProjectCreateMode("code"); setProjectFormOpen(true); }}>Skapa projekt</button><button onClick={() => startNewChat("chat", null)}>Fristående chatt</button></div></div>}{error && <p className={styles.error}>{error}</p>}
      </section>}

      {activeSection === "integrations" && <section className={styles.page}><div className={styles.pageHeader}><div><span className={styles.kicker}>Anslutningar</span><h1>Integrationer</h1><p>Anslut konton en gång. Kopplar du från en provider stängs åtkomsten till dess repos, projekt och credentials omedelbart tills du ansluter igen.</p></div></div><div className={styles.integrationGrid}>{(["github", "supabase", "vercel"] as ProviderKey[]).map((provider) => { const connectedConnection = integrations.find((item) => item.provider === provider && ["connected", "active", "ready"].includes(item.status)); const pendingConnection = integrations.find((item) => item.provider === provider && item.status === "pending"); const connection = connectedConnection ?? pendingConnection; const connected = Boolean(connectedConnection); return <article className={styles.integrationCard} key={provider}><div className={styles.integrationIdentity}><span className={styles.providerBadge}>{providerMark(provider)}</span><div><h2>{providerName(provider)}</h2><p>{providerMeta[provider].description}</p></div></div><div className={styles.integrationAction}><span className={`${styles.status} ${connected ? styles.statusOn : ""}`}>{connected ? "Ansluten" : pendingConnection ? "Ofullständig" : "Inte ansluten"}</span>{connected && connection ? <button type="button" disabled={busy} onClick={() => void disconnectProvider(provider, connection.id)}>Koppla från</button> : <button type="button" disabled={busy} onClick={() => connectProvider(provider)}>{pendingConnection ? "Starta om" : "Anslut"}</button>}</div></article>; })}</div><section className={styles.advancedAccess}><div className={styles.advancedHeader}><div><span className={styles.kicker}>Avancerad projektåtkomst</span><h2>Utökade actions</h2><p>Automatiskt infererade relaterade resurser får bara read-access. Destructive och sensitive actions kräver explicit val här.</p></div><select value={manageProjectId} onChange={(event) => setManageProjectId(event.target.value)}><option value="">Välj projekt</option>{projects.map((project) => <option value={project.id} key={project.id}>{modeMeta[project.mode].label} · {project.name}</option>)}</select></div>{manageProject ? <div className={styles.permissionGrid}>{connectedResources.map((resource) => <ResourceGrantCard key={`${manageProject.id}:${resource.id}`} resource={resource} current={projectResources.find((item) => item.project_id === manageProject.id && item.resource_id === resource.id)} catalog={catalog} onSave={saveProjectResource}/>)}</div> : <div className={styles.bigEmpty}><h2>Välj ett projekt</h2><p>Fristående chattar använder säker basåtkomst. Utökad åtkomst hanteras på projektnivå.</p></div>}</section>{error && <p className={styles.error}>{error}</p>}</section>}

      {activeSection === "settings" && <section className={styles.page}><div className={styles.pageHeader}><div><span className={styles.kicker}>Konto</span><h1>Inställningar</h1><p>Konto, arbetsyta och systemgenvägar.</p></div></div><div className={styles.settingsGrid}><article><span>Konto</span><strong>{displayName}</strong><small>{email}</small><Link href="/auth/set-password?mode=change">Ändra lösenord</Link></article><article><span>Arbetsyta</span><strong>{workspaceName}</strong><small>{projects.length} projekt · {connectedResources.length} synkade resurser</small><button onClick={() => setActiveSection("integrations")}>Hantera integrationer</button></article>{isSuperadmin && <article><span>System</span><strong>Control Center</strong><small>Modeller, GPU, policies och drift.</small><Link href="/superadmin">Öppna Control Center</Link></article>}<article><span>Session</span><strong>Logga ut</strong><small>Avsluta den aktiva sessionen.</small><form action="/auth/signout" method="post"><button>Logga ut</button></form></article></div></section>}
    </main>

    {resourcePickerOpen && <div className={styles.resourceOverlay} onMouseDown={() => setResourcePickerOpen(false)}><section className={styles.resourcePanel} onMouseDown={(event) => event.stopPropagation()} aria-label="Välj resurser"><div className={styles.resourcePanelHeader}><div><span className={styles.kicker}>Aktiv arbetskontext</span><h2>Lägg till resurs</h2><p>Välj startresursen. DIV3RSA kopplar automatiskt in starkt verifierade relaterade system som read-only kontext.</p></div><button className={styles.closeButton} onClick={() => setResourcePickerOpen(false)}>×</button></div><div className={styles.resourceSearch}><span>⌕</span><input autoFocus value={resourceSearch} onChange={(event) => setResourceSearch(event.target.value)} placeholder="Sök repo, Supabase-projekt, Vercel-projekt…"/></div><div className={styles.resourceList}>{resourceGroups.map(([provider, providerResources]) => <div className={styles.resourceGroup} key={provider}><div className={styles.resourceGroupTitle}><span className={styles.providerBadge}>{providerMark(provider)}</span><strong>{providerName(provider)}</strong><small>{providerResources.length}</small></div>{providerResources.map((resource) => { const selected = selectedResourceIds.includes(resource.id); const projectBinding = selectedProjectId ? projectResources.find((item) => item.project_id === selectedProjectId && item.resource_id === resource.id) : undefined; return <button type="button" key={resource.id} className={`${styles.resourceOption} ${selected ? styles.resourceOptionSelected : ""}`} onClick={() => toggleResource(resource.id)}><span className={styles.resourceCheck}>{selected ? "✓" : ""}</span><span className={styles.resourceOptionText}><strong>{resource.display_name}</strong><small>{resourceKind(resource)} · {projectBinding?.capabilities?.length ? `${projectBinding.capabilities.length} anpassade actions` : "säker read/write-bas"}</small></span><span className={styles.resourceArrow}>{selected ? "Vald" : "Lägg till"}</span></button>; })}</div>)}{!resourceGroups.length && <div className={styles.resourceEmpty}><h3>{connectedResources.length ? "Ingen matchning" : "Inga synkade resurser ännu"}</h3><p>{connectedResources.length ? "Prova ett annat sökord." : "Anslut GitHub, Supabase eller Vercel för att börja arbeta direkt mot externa system."}</p></div>}</div><div className={styles.resourcePanelFooter}><button onClick={() => { setResourcePickerOpen(false); setActiveSection("integrations"); }}>Hantera integrationer</button><button className={styles.primaryButton} onClick={() => setResourcePickerOpen(false)}>Klar · {selectedResourceIds.length} valda</button></div></section></div>}
  </div>;
}
