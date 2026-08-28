from pathlib import Path
import re

path = Path("apps/web/app/dashboard/workspace-shell-v4.tsx")
text = path.read_text()

poll_pattern = re.compile(r'''  useEffect\(\(\) => \{\n    if \(!run \|\| terminalStatuses\.has\(run\.status\)\) return;\n    let disposed = false;\n    const refreshRun = async \(\) => \{.*?\n  \}, \[run\?\.id, run\?\.conversationId, run\?\.status\]\);''', re.S)
poll_replacement = '''  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    let disposed = false;
    let refreshPending = false;
    const refreshRun = async () => {
      if (refreshPending || disposed) return;
      refreshPending = true;
      try {
        const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
        if (!response.ok || disposed) return;
        const next = await response.json() as Run;
        if (next.conversation_id && next.conversation_id !== run.conversationId) {
          setError("Svarskedjan matchade inte den öppna chatten. Svaret renderades inte i fel chatt.");
          setRun({ ...next, conversationId: run.conversationId, failure_code: "conversation_identity_mismatch" });
          return;
        }
        const nextRun = { ...next, conversationId: run.conversationId };
        setRun(nextRun);
        if (terminalStatuses.has(next.status) && selectedConversationIdRef.current === run.conversationId) void loadConversation(run.conversationId);
      } finally {
        refreshPending = false;
      }
    };
    // SSE is primary; REST polling is only a slow recovery path if EventSource is interrupted.
    const timer = window.setInterval(() => { void refreshRun(); }, 5_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [run?.id, run?.conversationId, run?.status]);'''
text, count = poll_pattern.subn(poll_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"expected one run polling block, got {count}")

submit_pattern = re.compile(r'''  async function submitPrompt\(\) \{.*?\n  \}\n  async function cancelRun\(\)''', re.S)
submit_replacement = '''  async function submitPrompt() {
    const text = prompt.trim(); if (!text || busy || runInProgress) return;
    const optimisticId = `local-${crypto.randomUUID()}`;
    const submittedAt = new Date().toISOString();
    const existingConversationId = selectedConversationId;
    const projectIdAtSubmit = selectedProjectId;
    // Acknowledge the click visually before any network round trip.
    setMessages((current) => [...current, { id: optimisticId, role: "user", content: { text }, created_at: submittedAt }]);
    setPrompt("");
    setBusy(true); setError(null);
    try {
      // start_agent_run can create standalone conversations transactionally.
      // Project chats still create their project-bound conversation first.
      const conversationId = existingConversationId ?? (projectIdAtSubmit ? await ensureConversation(activeMode) : null);
      const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, conversationId, mode: activeMode, prompt: text, resourceIds: selectedResourceIds }) });
      const body = await response.json() as { runId?: string; conversationId?: string; error?: string };
      if (!response.ok || !body.runId || !body.conversationId) throw new Error(body.error ?? "run_start_failed");
      if (conversationId && body.conversationId !== conversationId) throw new Error("conversation_identity_mismatch");
      const title = text.slice(0, 100);
      const now = new Date().toISOString();
      if (!conversationId) {
        const created: Conversation = { id: body.conversationId, project_id: null, mode: activeMode, title, created_at: now, updated_at: now, last_message_at: now, selected_resource_ids: selectedResourceIds };
        setConversations((current) => [created, ...current.filter((conversation) => conversation.id !== created.id)]);
        setSelectedConversationId(created.id);
        selectedConversationIdRef.current = created.id;
      } else {
        setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, title: conversation.title === "Ny chatt" || !conversation.title ? title : conversation.title, updated_at: now, last_message_at: now, selected_resource_ids: selectedResourceIds } : conversation));
      }
      replaceDashboardLocation(activeMode, body.conversationId, body.runId);
      setRun({ id: body.runId, conversationId: body.conversationId, conversation_id: body.conversationId, status: "queued", mode: activeMode, model_alias: `${activeMode === "chat" ? "general" : activeMode}-prod` });
    } catch (caught) {
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setPrompt((current) => current || text);
      if (caught instanceof Error && caught.message === "conversation_identity_mismatch") setError("Chatten tappade sin identitet mellan request och run. Inget svar renderades i fel chatt.");
      else setError(caught instanceof Error && /resource|access|permission|mode/.test(caught.message) ? "Projektet eller en vald resurs passar inte den här arbetsytan längre. Uppdatera valet och försök igen." : "Uppgiften kunde inte startas. Försök igen.");
    }
    finally { setBusy(false); }
  }
  async function cancelRun()'''
text, count = submit_pattern.subn(submit_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"expected one submitPrompt block, got {count}")

old_preview = '{run && <RunStreamPreview runId={run.id} conversationId={run.conversationId} activeConversationId={selectedConversationId} terminal={terminalStatuses.has(run.status)}/>}'
new_preview = '''{run && <RunStreamPreview runId={run.id} conversationId={run.conversationId} activeConversationId={selectedConversationId} terminal={terminalStatuses.has(run.status)} onSnapshot={(snapshot) => {
          if (snapshot.runId !== run.id || snapshot.conversationId !== run.conversationId) return;
          setRun((current) => current && current.id === snapshot.runId ? { ...current, status: snapshot.status } : current);
          if (terminalStatuses.has(snapshot.status) && selectedConversationIdRef.current === snapshot.conversationId) void loadConversation(snapshot.conversationId);
        }}/>}'''
if text.count(old_preview) != 1:
    raise SystemExit(f"expected one stream preview, got {text.count(old_preview)}")
text = text.replace(old_preview, new_preview, 1)

path.write_text(text)
