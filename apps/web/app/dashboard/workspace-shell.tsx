"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./workspace-shell.module.css";

type Mode = "chat" | "code" | "lab" | "research";
type Section = Mode | "projects" | "integrations" | "settings";

type Project = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  repository_count: number;
};

type Conversation = {
  id: string;
  project_id: string | null;
  mode: Mode;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

type Integration = {
  id: string;
  provider: string;
  external_account_id: string;
  status: string;
  created_at: string;
  capabilities?: Record<string, boolean>;
};

type Message = {
  id: string;
  role: string;
  content: unknown;
  created_at: string;
};

type Run = {
  id: string;
  conversationId: string;
  status: string;
  mode: string;
  model_alias: string;
  failure_code?: string | null;
  output_content?: string | null;
};

type Snapshot = {
  projects?: Project[];
  conversations?: Conversation[];
  integrations?: Integration[];
};

type ProviderKey = "github" | "supabase" | "vercel";

const modeMeta: Record<Mode, { label: string; short: string; description: string; placeholder: string }> = {
  chat: {
    label: "Chat",
    short: "C",
    description: "Planera, resonera och lös uppgifter.",
    placeholder: "Skriv ett meddelande eller beskriv vad du vill få gjort…"
  },
  code: {
    label: "Code",
    short: "</>",
    description: "Arbeta med kod, repos, tester och implementation.",
    placeholder: "Beskriv vad som ska byggas, felsökas eller ändras…"
  },
  research: {
    label: "Research",
    short: "R",
    description: "Research med källor, jämförelser och strukturerade svar.",
    placeholder: "Vad vill du undersöka?"
  },
  lab: {
    label: "Lab",
    short: "L",
    description: "Säkerhetsarbete inom godkända projekt och scopes.",
    placeholder: "Beskriv säkerhetsuppgiften för det valda projektet…"
  }
};

const providers: Array<{ key: ProviderKey; name: string; mark: string; description: string; capabilities: string[] }> = [
  { key: "github", name: "GitHub", mark: "GH", description: "Repos, branches, pull requests och Actions.", capabilities: ["Repository access", "Branches & PR", "Actions"] },
  { key: "supabase", name: "Supabase", mark: "SB", description: "Databas, schema, migrations, logs och projektdata.", capabilities: ["Database", "Migrations", "Logs"] },
  { key: "vercel", name: "Vercel", mark: "▲", description: "Deployments, projekt, miljövariabler och runtime logs.", capabilities: ["Deployments", "Environment", "Runtime logs"] }
];

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  try { return JSON.stringify(content, null, 2); } catch { return ""; }
}

function formatRelative(value?: string | null) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "nu";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  return new Intl.DateTimeFormat("sv-SE", { month: "short", day: "numeric" }).format(new Date(value));
}

export function WorkspaceShell({
  workspaceId,
  workspaceName,
  displayName,
  email,
  isSuperadmin,
  snapshot
}: {
  workspaceId: string;
  workspaceName: string;
  displayName: string;
  email: string;
  isSuperadmin: boolean;
  snapshot: Snapshot;
}) {
  const [projects, setProjects] = useState<Project[]>(snapshot.projects ?? []);
  const [conversations, setConversations] = useState<Conversation[]>(snapshot.conversations ?? []);
  const [integrations, setIntegrations] = useState<Integration[]>(snapshot.integrations ?? []);
  const [activeSection, setActiveSection] = useState<Section>("chat");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => (snapshot.conversations ?? []).find((item) => item.mode === "chat")?.id ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");

  const activeMode: Mode = activeSection === "projects" || activeSection === "integrations" || activeSection === "settings" ? "chat" : activeSection;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;

  const modeConversations = useMemo(() => conversations.filter((conversation) => {
    if (conversation.mode !== activeMode) return false;
    if (selectedProjectId && conversation.project_id !== selectedProjectId) return false;
    return true;
  }), [activeMode, conversations, selectedProjectId]);

  const currentModeProjects = useMemo(() => projects.map((project) => ({
    ...project,
    modeCount: conversations.filter((conversation) => conversation.project_id === project.id && conversation.mode === activeMode).length
  })), [activeMode, conversations, projects]);

  async function loadConversation(conversationId: string) {
    setLoadingConversation(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
      const body = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "conversation_load_failed");
      setMessages(body.messages ?? []);
    } catch {
      setMessages([]);
      setError("Chatten kunde inte laddas. Försök igen.");
    } finally {
      setLoadingConversation(false);
    }
  }

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }
    void loadConversation(selectedConversationId);
  }, [selectedConversationId]);

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

  function switchMode(mode: Mode) {
    setActiveSection(mode);
    setError(null);
    const candidate = conversations.find((conversation) => conversation.mode === mode && (!selectedProjectId || conversation.project_id === selectedProjectId));
    setSelectedConversationId(candidate?.id ?? null);
    if (!candidate) setMessages([]);
  }

  function startNewChat(mode: Mode = activeMode, projectId: string | null = selectedProjectId) {
    setActiveSection(mode);
    setSelectedProjectId(projectId);
    setSelectedConversationId(null);
    setMessages([]);
    setRun(null);
    setError(null);
    setPrompt("");
  }

  function openProject(projectId: string, mode: Mode = activeMode) {
    setSelectedProjectId(projectId);
    setActiveSection(mode);
    const candidate = conversations.find((conversation) => conversation.project_id === projectId && conversation.mode === mode);
    setSelectedConversationId(candidate?.id ?? null);
    if (!candidate) setMessages([]);
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, name: projectName, description: projectDescription })
      });
      const body = await response.json() as { project?: Project; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? "project_create_failed");
      const project = { ...body.project, conversation_count: 0, repository_count: 0 };
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setProjectName("");
      setProjectDescription("");
      setProjectFormOpen(false);
      setActiveSection("projects");
    } catch {
      setError("Projektet kunde inte skapas. Kontrollera din åtkomst och försök igen.");
    } finally {
      setBusy(false);
    }
  }

  async function ensureConversation(mode: Mode) {
    if (selectedConversationId) return selectedConversationId;
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, projectId: selectedProjectId, mode, title: "Ny chatt" })
    });
    const body = await response.json() as { conversation?: Conversation; error?: string };
    if (!response.ok || !body.conversation) throw new Error(body.error ?? "conversation_create_failed");
    const conversation = { ...body.conversation, last_message_at: null };
    setConversations((current) => [conversation, ...current]);
    setSelectedConversationId(conversation.id);
    return conversation.id;
  }

  async function submitPrompt() {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const conversationId = await ensureConversation(activeMode);
      const optimistic: Message = { id: `local-${Date.now()}`, role: "user", content: { text }, created_at: new Date().toISOString() };
      setMessages((current) => [...current, optimistic]);
      setPrompt("");

      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, conversationId, mode: activeMode, prompt: text })
      });
      const body = await response.json() as { runId?: string; conversationId?: string; error?: string };
      if (!response.ok || !body.runId || !body.conversationId) {
        if (body.error === "lab_scope_required") throw new Error("lab_scope_required");
        throw new Error(body.error ?? "run_start_failed");
      }

      const title = text.slice(0, 100);
      setConversations((current) => current.map((conversation) => conversation.id === conversationId
        ? { ...conversation, title: conversation.title === "Ny chatt" || !conversation.title ? title : conversation.title, updated_at: new Date().toISOString(), last_message_at: new Date().toISOString() }
        : conversation));
      setRun({ id: body.runId, conversationId: body.conversationId, status: "queued", mode: activeMode, model_alias: `${activeMode === "chat" ? "general" : activeMode}-prod` });
    } catch (caught) {
      setError(caught instanceof Error && caught.message === "lab_scope_required"
        ? "Lab kräver ett aktivt godkänt scope för det valda projektet. Kontakta administratören om projektet ännu inte är godkänt."
        : "Uppgiften kunde inte startas. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun() {
    if (!run) return;
    const response = await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
    if (response.ok) setRun({ ...run, status: "cancelled" });
  }

  async function connectProvider(provider: ProviderKey) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, provider })
      });
      const body = await response.json() as { connection?: Integration; error?: string };
      if (!response.ok || !body.connection) throw new Error(body.error ?? "integration_request_failed");
      setIntegrations((current) => [body.connection!, ...current.filter((item) => item.provider !== provider || item.id !== body.connection?.id)]);
    } catch {
      setError("Anslutningen kunde inte startas. Kontrollera att du har rätt behörighet.");
    } finally {
      setBusy(false);
    }
  }

  const projectChats = selectedProjectId ? conversations.filter((conversation) => conversation.project_id === selectedProjectId) : [];

  return <div className={styles.appShell}>
    <aside className={styles.primaryRail}>
      <div className={styles.brandBlock}>
        <Link className={styles.brand} href="/dashboard">DIV3RSA</Link>
        <button className={styles.newButton} type="button" onClick={() => startNewChat()}>＋ <span>Ny chatt</span></button>
      </div>

      <nav className={styles.primaryNav} aria-label="Workspace navigation">
        {(Object.keys(modeMeta) as Mode[]).map((mode) => <button
          key={mode}
          type="button"
          className={`${styles.primaryNavItem} ${activeSection === mode ? styles.primaryNavItemActive : ""}`}
          onClick={() => switchMode(mode)}
        >
          <span className={styles.navIcon}>{modeMeta[mode].short}</span>
          <span>{modeMeta[mode].label}</span>
        </button>)}
        <div className={styles.navDivider} />
        <button type="button" className={`${styles.primaryNavItem} ${activeSection === "projects" ? styles.primaryNavItemActive : ""}`} onClick={() => setActiveSection("projects")}><span className={styles.navIcon}>P</span><span>Projekt</span></button>
        <button type="button" className={`${styles.primaryNavItem} ${activeSection === "integrations" ? styles.primaryNavItemActive : ""}`} onClick={() => setActiveSection("integrations")}><span className={styles.navIcon}>+</span><span>Integrationer</span></button>
        <button type="button" className={`${styles.primaryNavItem} ${activeSection === "settings" ? styles.primaryNavItemActive : ""}`} onClick={() => setActiveSection("settings")}><span className={styles.navIcon}>⚙</span><span>Inställningar</span></button>
      </nav>

      <div className={styles.accountBlock}>
        <div className={styles.avatar}>{displayName.slice(0, 1).toUpperCase()}</div>
        <div className={styles.accountText}><strong>{displayName}</strong><small>{workspaceName}</small></div>
      </div>
    </aside>

    {activeSection === "chat" || activeSection === "code" || activeSection === "lab" || activeSection === "research" ? <aside className={styles.contextSidebar}>
      <div className={styles.contextHeader}>
        <div><small>{modeMeta[activeMode].label}</small><strong>{selectedProject?.name ?? "Alla projekt"}</strong></div>
        <button type="button" className={styles.iconButton} onClick={() => startNewChat(activeMode)}>＋</button>
      </div>

      <div className={styles.contextScroll}>
        <section className={styles.sidebarSection}>
          <div className={styles.sidebarSectionTitle}><span>Projekt</span><button type="button" onClick={() => setProjectFormOpen(true)}>Nytt</button></div>
          <button type="button" className={`${styles.projectFilter} ${selectedProjectId === null ? styles.projectFilterActive : ""}`} onClick={() => { setSelectedProjectId(null); setSelectedConversationId(conversations.find((item) => item.mode === activeMode)?.id ?? null); }}><span>Alla projekt</span><small>{conversations.filter((item) => item.mode === activeMode).length}</small></button>
          {currentModeProjects.map((project) => <button key={project.id} type="button" className={`${styles.projectFilter} ${selectedProjectId === project.id ? styles.projectFilterActive : ""}`} onClick={() => openProject(project.id, activeMode)}><span>{project.name}</span><small>{project.modeCount}</small></button>)}
        </section>

        <section className={styles.sidebarSection}>
          <div className={styles.sidebarSectionTitle}><span>Chattar</span><small>{modeConversations.length}</small></div>
          {modeConversations.length ? <div className={styles.chatList}>{modeConversations.map((conversation) => <button key={conversation.id} type="button" className={`${styles.chatItem} ${selectedConversationId === conversation.id ? styles.chatItemActive : ""}`} onClick={() => setSelectedConversationId(conversation.id)}><span>{conversation.title || "Ny chatt"}</span><small>{formatRelative(conversation.last_message_at || conversation.updated_at)}</small></button>)}</div> : <div className={styles.emptySidebar}>Inga chattar här ännu.</div>}
        </section>
      </div>
    </aside> : null}

    <main className={styles.main}>
      {(activeSection === "chat" || activeSection === "code" || activeSection === "lab" || activeSection === "research") && <>
        <header className={styles.chatHeader}>
          <div>
            <div className={styles.breadcrumb}>{selectedProject ? `${selectedProject.name} / ` : ""}{modeMeta[activeMode].label}</div>
            <h1>{selectedConversation?.title && selectedConversation.title !== "Ny chatt" ? selectedConversation.title : "Ny chatt"}</h1>
          </div>
          <div className={styles.headerActions}>
            {selectedProject && <button className={styles.smallButton} type="button" onClick={() => setActiveSection("projects")}>Projektinfo</button>}
            <button className={styles.smallButton} type="button" onClick={() => startNewChat(activeMode)}>Ny chatt</button>
          </div>
        </header>

        <section className={styles.chatCanvas}>
          {loadingConversation ? <div className={styles.centerState}>Laddar chatt…</div> : messages.length ? <div className={styles.messageStream}>{messages.map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}><div className={styles.messageMeta}>{message.role === "user" ? "Du" : "DIV3RSA"}</div><div className={styles.messageBody}>{messageText(message.content)}</div></article>)}</div> : <div className={styles.emptyChat}>
            <div className={styles.modeBadge}>{modeMeta[activeMode].short}</div>
            <h2>{selectedProject ? `Arbeta i ${selectedProject.name}` : modeMeta[activeMode].label}</h2>
            <p>{modeMeta[activeMode].description}</p>
            {activeMode === "lab" && <div className={styles.labNote}>Lab använder projektets godkända scope automatiskt. Inga authorization-ID:n behöver anges.</div>}
          </div>}

          {run && <div className={styles.runStrip}><span className={`${styles.runDot} ${terminalStatuses.has(run.status) ? styles.runDotIdle : ""}`} /><strong>{run.status}</strong><span>{run.model_alias}</span>{run.failure_code && <span className={styles.runError}>{run.failure_code}</span>}{!terminalStatuses.has(run.status) && <button type="button" onClick={cancelRun}>Stoppa</button>}</div>}
        </section>

        <footer className={styles.composerWrap}>
          <div className={styles.composer}>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } }} placeholder={modeMeta[activeMode].placeholder} disabled={busy} rows={3} />
            <div className={styles.composerFooter}>
              <div className={styles.composerContext}><span>{selectedProject?.name ?? "Ingen projektmapp"}</span><span>·</span><span>{modeMeta[activeMode].label}</span></div>
              <button type="button" className={styles.sendButton} onClick={() => void submitPrompt()} disabled={busy || !prompt.trim()}>{busy ? "…" : "↑"}</button>
            </div>
          </div>
          {error && <p className={styles.error}>{error}</p>}
        </footer>
      </>}

      {activeSection === "projects" && <section className={styles.pageSection}>
        <div className={styles.pageHeader}><div><span className={styles.kicker}>Workspace</span><h1>Projekt</h1><p>Samla chattar, kodarbete, research och Lab i tydliga projekt.</p></div><button className={styles.primaryButton} type="button" onClick={() => setProjectFormOpen(true)}>＋ Nytt projekt</button></div>

        {projectFormOpen && <form className={styles.projectForm} onSubmit={createProject}><div><label>Projektnamn<input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} autoFocus required /></label><label>Beskrivning<textarea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} maxLength={2000} rows={3} placeholder="Vad ska agenten arbeta med i projektet?" /></label></div><div className={styles.formActions}><button type="button" onClick={() => setProjectFormOpen(false)}>Avbryt</button><button className={styles.primaryButton} type="submit" disabled={busy}>Skapa projekt</button></div></form>}

        <div className={styles.projectGrid}>{projects.map((project) => {
          const chats = conversations.filter((conversation) => conversation.project_id === project.id);
          return <article className={styles.projectCard} key={project.id}>
            <div className={styles.projectCardTop}><div className={styles.projectMark}>{project.name.slice(0, 2).toUpperCase()}</div><div><h2>{project.name}</h2><p>{project.description || "Inga projektanteckningar ännu."}</p></div></div>
            <div className={styles.projectStats}><span><strong>{chats.length}</strong> chattar</span><span><strong>{project.repository_count ?? 0}</strong> repos</span></div>
            <div className={styles.projectModes}>{(Object.keys(modeMeta) as Mode[]).map((mode) => <button key={mode} type="button" onClick={() => openProject(project.id, mode)}>{modeMeta[mode].label}<small>{chats.filter((chat) => chat.mode === mode).length}</small></button>)}</div>
          </article>;
        })}</div>
        {!projects.length && !projectFormOpen && <div className={styles.bigEmpty}><h2>Skapa ditt första projekt</h2><p>Projekt håller ihop chattar, repos, research och Lab-arbete.</p><button className={styles.primaryButton} type="button" onClick={() => setProjectFormOpen(true)}>Skapa projekt</button></div>}
        {error && <p className={styles.error}>{error}</p>}
      </section>}

      {activeSection === "integrations" && <section className={styles.pageSection}>
        <div className={styles.pageHeader}><div><span className={styles.kicker}>Plugins & integrations</span><h1>Anslut dina verktyg</h1><p>Koppla arbetsytan till de system agenten ska kunna arbeta med.</p></div></div>
        <div className={styles.integrationGrid}>{providers.map((provider) => {
          const connection = integrations.find((item) => item.provider === provider.key && ["connected", "active", "ready", "pending"].includes(item.status));
          const connected = Boolean(connection && ["connected", "active", "ready"].includes(connection.status));
          return <article className={styles.integrationCard} key={provider.key}>
            <div className={styles.integrationHead}><div className={styles.integrationMark}>{provider.mark}</div><div><h2>{provider.name}</h2><p>{provider.description}</p></div><span className={`${styles.connectionStatus} ${connected ? styles.connectionOn : connection?.status === "pending" ? styles.connectionPending : ""}`}>{connected ? "Ansluten" : connection?.status === "pending" ? "Väntar" : "Inte ansluten"}</span></div>
            <div className={styles.capabilityList}>{provider.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
            <div className={styles.integrationFooter}><small>{connected ? "Tillgänglig för projekt med rätt behörighet." : connection?.status === "pending" ? "Anslutningsbegäran är registrerad. OAuth-konfiguration slutför kopplingen." : "Credentials lagras aldrig i klienten."}</small><button type="button" onClick={() => void connectProvider(provider.key)} disabled={busy || connected}>{connected ? "Ansluten" : connection?.status === "pending" ? "Begärd" : "Anslut"}</button></div>
          </article>;
        })}</div>
        <div className={styles.integrationInfo}><strong>Plugin-arkitektur</strong><p>Integrationerna ligger per organisation och kan få separata capabilities. GitHub, Supabase och Vercel är första providers; fler kan läggas till utan att ändra chat- eller projektmodellen.</p></div>
        {error && <p className={styles.error}>{error}</p>}
      </section>}

      {activeSection === "settings" && <section className={styles.pageSection}>
        <div className={styles.pageHeader}><div><span className={styles.kicker}>Konto & workspace</span><h1>Inställningar</h1><p>Hantera konto, säkerhet och kopplingar för arbetsytan.</p></div></div>
        <div className={styles.settingsGrid}>
          <article className={styles.settingsCard}><span className={styles.settingsLabel}>Konto</span><h2>{displayName}</h2><p>{email}</p><Link className={styles.settingsLink} href="/auth/set-password?mode=change">Ändra lösenord <span>→</span></Link></article>
          <article className={styles.settingsCard}><span className={styles.settingsLabel}>Workspace</span><h2>{workspaceName}</h2><p>{projects.length} projekt · {conversations.length} chattar</p><button className={styles.settingsLink} type="button" onClick={() => setActiveSection("projects")}>Hantera projekt <span>→</span></button></article>
          <article className={styles.settingsCard}><span className={styles.settingsLabel}>Plugins</span><h2>Integrationer</h2><p>{integrations.filter((item) => ["connected", "active", "ready"].includes(item.status)).length} aktiva kopplingar</p><button className={styles.settingsLink} type="button" onClick={() => setActiveSection("integrations")}>Öppna integrationer <span>→</span></button></article>
          {isSuperadmin && <article className={styles.settingsCard}><span className={styles.settingsLabel}>System</span><h2>Control center</h2><p>Modeller, GPU, policies, användare och runtime.</p><Link className={styles.settingsLink} href="/superadmin">Öppna control center <span>→</span></Link></article>}
        </div>
        <form className={styles.signoutCard} action="/auth/signout" method="post"><div><strong>Logga ut</strong><p>Avsluta sessionen på den här enheten.</p></div><button type="submit">Logga ut</button></form>
      </section>}
    </main>
  </div>;
}
