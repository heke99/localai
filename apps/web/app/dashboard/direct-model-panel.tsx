"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Mode = "chat" | "code" | "research";
type DirectMessage = { id: string; role: "user" | "assistant"; text: string; createdAt?: string };

type ConversationResponse = {
  conversation?: { id?: string; mode?: string; title?: string | null };
  messages?: Array<{ id?: string; role?: string; content?: unknown; created_at?: string }>;
  error?: string;
};

type DirectResponse = {
  conversationId?: string;
  directRunId?: string | null;
  modelAlias?: string;
  message?: string;
  error?: string;
};

const modes: Array<{ value: Mode; label: string; detail: string }> = [
  { value: "chat", label: "Chat", detail: "ren modellchatt" },
  { value: "code", label: "Code", detail: "kodfokus utan repo-tools" },
  { value: "research", label: "Research", detail: "modellkunskap utan webbsökning" }
];

function messageText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";
  const record = content as Record<string, unknown>;
  return typeof record.text === "string" ? record.text.trim() : typeof record.content === "string" ? record.content.trim() : "";
}

function directLocation(conversationId?: string | null) {
  const params = new URLSearchParams(window.location.search);
  params.set("section", "direct");
  params.delete("run");
  if (conversationId) params.set("conversation", conversationId);
  else params.delete("conversation");
  return `${window.location.pathname}?${params.toString()}${window.location.hash}`;
}

function errorLabel(code: string | undefined) {
  if (code === "runtime_warming") return "Modellen startar på GPU:n. Vänta några sekunder och skicka igen.";
  if (code === "subscription_required") return "Kontot har inte aktiv modellåtkomst.";
  if (code === "access_denied") return "Du saknar behörighet för det här modell-läget.";
  if (code === "conversation_busy") return "Den här chatten har redan en aktiv körning. Vänta tills den är klar.";
  if (code === "direct_model_schema_pending") return "Direct model-databasen håller på att uppdateras. Försök igen när releasen är klar.";
  if (code === "lab_requires_agent") return "Lab kräver Agent-läget eftersom säkerhetsverktyg och scope körs där.";
  return "Direktkörningen misslyckades. Försök igen.";
}

export function DirectModelPanel({ workspaceId, onExit }: { workspaceId: string; onExit: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelAlias, setModelAlias] = useState<string>("general-prod");

  const loadConversation = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = await response.json() as ConversationResponse;
      if (!response.ok || body.conversation?.id !== id) throw new Error(body.error ?? "conversation_load_failed");
      if (body.conversation.mode && modes.some((item) => item.value === body.conversation?.mode)) setMode(body.conversation.mode as Mode);
      setMessages((body.messages ?? [])
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({
          id: item.id ?? crypto.randomUUID(),
          role: item.role as "user" | "assistant",
          text: messageText(item.content),
          createdAt: item.created_at
        }))
        .filter((item) => item.text));
      setError(body.conversation?.mode === "lab" ? "Den här äldre Direct Lab-chatten är skrivskyddad här. Fortsätt säkerhetsarbete i Agent-läget." : null);
    } catch {
      setError("Direct-chatten kunde inte laddas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("section") === "direct" ? params.get("conversation") : null;
    setConversationId(id);
    if (id) void loadConversation(id);
  }, [loadConversation]);

  useEffect(() => {
    void fetch("/api/runtime/prewarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, mode }),
      keepalive: true
    }).catch(() => undefined);
  }, [workspaceId, mode]);

  function newConversation() {
    if (busy) return;
    setConversationId(null);
    setMessages([]);
    setPrompt("");
    setError(null);
    setModelAlias(mode === "code" ? "code-prod" : mode === "research" ? "research-prod" : "general-prod");
    window.history.pushState(window.history.state, "", directLocation(null));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;

    const optimisticId = crypto.randomUUID();
    setPrompt("");
    setError(null);
    setBusy(true);
    setMessages((current) => [...current, { id: optimisticId, role: "user", text }]);

    try {
      const response = await fetch("/api/model/direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, conversationId, mode, prompt: text })
      });
      const body = await response.json() as DirectResponse;
      const resolvedConversationId = body.conversationId ?? conversationId;

      if (!response.ok || !body.message || !resolvedConversationId) {
        if (!body.directRunId) setMessages((current) => current.filter((item) => item.id !== optimisticId));
        setError(errorLabel(body.error));
        if (resolvedConversationId) {
          setConversationId(resolvedConversationId);
          window.history.replaceState(window.history.state, "", directLocation(resolvedConversationId));
          if (body.directRunId) void loadConversation(resolvedConversationId);
        }
        return;
      }

      setConversationId(resolvedConversationId);
      setModelAlias(body.modelAlias ?? modelAlias);
      setMessages((current) => [...current, { id: body.directRunId ?? crypto.randomUUID(), role: "assistant", text: body.message! }]);
      window.history.replaceState(window.history.state, "", directLocation(resolvedConversationId));
    } catch {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setError("Anslutningen till direct model bröts. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  return <main style={{ minHeight: "100vh", background: "#101114", color: "#e6e7e9", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
    <header style={{ minHeight: 64, borderBottom: "1px solid #25282e", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 22px", position: "sticky", top: 0, zIndex: 10, background: "rgba(16,17,20,.96)", backdropFilter: "blur(16px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={onExit} style={{ border: "1px solid #30343b", background: "#17191d", color: "#d8dade", borderRadius: 9, padding: "8px 11px", cursor: "pointer" }}>← Agent</button>
        <div>
          <strong style={{ display: "block", fontSize: 14 }}>Direkt modell</strong>
          <span style={{ display: "block", color: "#8e939d", fontSize: 12, marginTop: 2 }}>Qwen V3 Q8 · ingen agent-loop · inga tools</span>
        </div>
      </div>
      <button type="button" disabled={busy} onClick={newConversation} style={{ border: "1px solid #30343b", background: "transparent", color: "#c7cbd2", borderRadius: 9, padding: "8px 11px", cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1 }}>Ny direct-chatt</button>
    </header>

    <section style={{ width: "min(900px, calc(100% - 32px))", margin: "0 auto", padding: "24px 0 160px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {modes.map((item) => <button
          key={item.value}
          type="button"
          disabled={Boolean(conversationId) || busy}
          onClick={() => { setMode(item.value); setModelAlias(item.value === "code" ? "code-prod" : item.value === "research" ? "research-prod" : "general-prod"); }}
          title={conversationId ? "Läget låses när chatten har skapats" : item.detail}
          style={{ border: mode === item.value ? "1px solid #6c7482" : "1px solid #2c3037", background: mode === item.value ? "#23272e" : "#17191d", color: mode === item.value ? "#fff" : "#aeb2ba", borderRadius: 999, padding: "7px 11px", cursor: conversationId || busy ? "default" : "pointer", opacity: conversationId && mode !== item.value ? .45 : 1 }}
        >{item.label}</button>)}
        <span style={{ alignSelf: "center", marginLeft: 4, color: "#737984", fontSize: 12 }}>{modelAlias}</span>
      </div>

      <div style={{ marginBottom: 20, border: "1px solid #343943", background: "#17191d", borderRadius: 12, padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <span style={{ color: "#aeb3bc", fontSize: 12, lineHeight: 1.5 }}>Lab och pentest körs alltid via Agent så att scope, riktiga security-tools och audit-logg används.</span>
        <button type="button" onClick={onExit} style={{ flexShrink: 0, border: "1px solid #596170", background: "#23272e", color: "#fff", borderRadius: 9, padding: "8px 10px", cursor: "pointer", fontSize: 12 }}>Öppna Agent Lab</button>
      </div>

      {!messages.length && !loading ? <div style={{ padding: "56px 0 24px", maxWidth: 660 }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 50px)", lineHeight: 1.02, letterSpacing: "-.04em", margin: 0 }}>Kör modellen utan mellanlager.</h1>
        <p style={{ color: "#969ba5", lineHeight: 1.6, maxWidth: 580, marginTop: 18 }}>Det här går direkt till den aktiva Qwen-runtime:n. Ingen agent planerar, inga skills körs och inga GitHub/Supabase/Vercel-resurser skickas med. Använd Agent-läget när modellen ska göra saker.</p>
      </div> : null}

      {loading ? <div style={{ color: "#8e939d", padding: "32px 0" }}>Laddar direct-chatten…</div> : null}
      <div style={{ display: "grid", gap: 22 }}>
        {messages.map((message) => <article key={message.id} style={{ justifySelf: message.role === "user" ? "end" : "start", width: message.role === "user" ? "min(76%, 680px)" : "min(92%, 820px)" }}>
          <div style={{ color: "#777d87", fontSize: 11, marginBottom: 6, textAlign: message.role === "user" ? "right" : "left" }}>{message.role === "user" ? "Du" : "Qwen · direct"}</div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6, border: message.role === "user" ? "1px solid #30343b" : "0", background: message.role === "user" ? "#1b1e23" : "transparent", padding: message.role === "user" ? "10px 13px" : "0", borderRadius: message.role === "user" ? "16px 16px 4px 16px" : 0 }}>{message.text}</div>
        </article>)}
        {busy ? <div style={{ color: "#8e939d", fontSize: 13 }}>Qwen genererar direkt…</div> : null}
      </div>
      {error ? <div role="alert" style={{ marginTop: 20, border: "1px solid #5a3232", background: "#241616", color: "#f0c4c4", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>{error}</div> : null}
    </section>

    <form onSubmit={submit} style={{ position: "fixed", left: 0, right: 0, bottom: 0, padding: "18px 16px 24px", background: "linear-gradient(180deg, rgba(16,17,20,0), #101114 28%)" }}>
      <div style={{ width: "min(900px, 100%)", margin: "0 auto", border: "1px solid #30343b", background: "#17191d", borderRadius: 16, padding: 10, boxShadow: "0 14px 44px rgba(0,0,0,.28)" }}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          onFocus={() => { void fetch("/api/runtime/prewarm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, mode }), keepalive: true }).catch(() => undefined); }}
          disabled={busy}
          rows={3}
          placeholder={busy ? "Qwen arbetar…" : "Skriv direkt till modellen…"}
          style={{ width: "100%", resize: "none", border: 0, outline: 0, background: "transparent", color: "#f1f2f3", font: "14px/1.5 inherit", padding: "6px 7px", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "5px 3px 0" }}>
          <span style={{ color: "#737984", fontSize: 11 }}>Direct: text + historik endast</span>
          <button type="submit" disabled={busy || !prompt.trim()} style={{ border: 0, borderRadius: 10, padding: "9px 14px", background: "#e9eaec", color: "#111318", fontWeight: 700, cursor: busy || !prompt.trim() ? "default" : "pointer", opacity: busy || !prompt.trim() ? .45 : 1 }}>Skicka</button>
        </div>
      </div>
    </form>
  </main>;
}
