"use client";

import { useEffect, useState } from "react";
import { WorkspaceShellV5 } from "./workspace-shell-v5";
import { dashboardRecoveryRequest, upsertRecoveredConversation, withoutProvisionalRun } from "./workspace-navigation-recovery";

type WorkspaceShellV6Props = Parameters<typeof WorkspaceShellV5>[0];
type Snapshot = WorkspaceShellV6Props["snapshot"];
type Conversation = NonNullable<Snapshot["conversations"]>[number];
type Message = { id: string; role: string; content: unknown; created_at: string };

type ConversationRecoveryResponse = {
  conversation?: {
    id?: string;
    project_id?: string | null;
    mode?: string;
    title?: string | null;
    created_at?: string;
    updated_at?: string;
  };
  messages?: Message[];
  selectedResourceIds?: string[];
  error?: string;
};

const validModes = new Set(["chat", "code", "lab", "research"]);

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function recoveredConversation(body: ConversationRecoveryResponse, expectedId: string): Conversation {
  const conversation = body.conversation;
  if (!conversation?.id || conversation.id !== expectedId) throw new Error("conversation_identity_mismatch");
  if (!conversation.mode || !validModes.has(conversation.mode)) throw new Error("conversation_mode_invalid");
  if (!conversation.created_at || !conversation.updated_at) throw new Error("conversation_timestamps_missing");
  const latestMessageAt = body.messages?.at(-1)?.created_at ?? conversation.updated_at;

  return {
    id: conversation.id,
    project_id: conversation.project_id ?? null,
    mode: conversation.mode as Conversation["mode"],
    title: conversation.title ?? null,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    last_message_at: latestMessageAt,
    selected_resource_ids: (body.selectedResourceIds ?? []).filter((value): value is string => typeof value === "string")
  };
}

function removeProvisionalRunFromLocation() {
  if (!new URLSearchParams(window.location.search).has("run")) return;
  const next = `${window.location.pathname}${withoutProvisionalRun(window.location.search)}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

export function WorkspaceShellV6(props: WorkspaceShellV6Props) {
  const [preparedSnapshot, setPreparedSnapshot] = useState<Snapshot>(props.snapshot);
  const [navigationResolved, setNavigationResolved] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function prepareNavigation() {
      const request = dashboardRecoveryRequest(
        window.location.search,
        (props.snapshot.conversations ?? []).map((conversation) => conversation.id)
      );

      if (!request) {
        if (!cancelled) {
          setPreparedSnapshot(props.snapshot);
          setRecoveryError(null);
          setNavigationResolved(true);
        }
        return;
      }

      // The URL run id is deliberately consumed before WorkspaceShellV4 mounts.
      // V4 will restore only the server-confirmed activeRun from the conversation
      // endpoint, eliminating the old URL -> queued -> hydration-clear race.
      if (request.runId) removeProvisionalRunFromLocation();

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const response = await fetch(`/api/conversations/${encodeURIComponent(request.conversationId)}`, { cache: "no-store" });
          const body = await response.json() as ConversationRecoveryResponse;
          if (!response.ok) throw new Error(body.error ?? `conversation_recovery_http_${response.status}`);
          const recovered = recoveredConversation(body, request.conversationId);
          if (cancelled) return;

          setPreparedSnapshot({
            ...props.snapshot,
            conversations: upsertRecoveredConversation(props.snapshot.conversations ?? [], recovered)
          });
          setRecoveryError(null);
          setNavigationResolved(true);
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < 2) await sleep(150);
        }
      }

      if (!cancelled) {
        setPreparedSnapshot(props.snapshot);
        setRecoveryError(lastError?.message ?? "conversation_recovery_failed");
        setNavigationResolved(true);
      }
    }

    void prepareNavigation();
    return () => { cancelled = true; };
  }, [props.snapshot]);

  if (!navigationResolved) {
    return <div aria-busy="true" aria-live="polite" style={{ minHeight: "100vh", background: "#101114", color: "#b8bbc2", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif" }}>
      Återställer chatten…
    </div>;
  }

  return <>
    <WorkspaceShellV5 {...props} snapshot={preparedSnapshot} />
    {recoveryError ? <div role="alert" style={{ position: "fixed", right: 18, bottom: 18, zIndex: 100, maxWidth: 420, border: "1px solid #5a3232", borderRadius: 10, padding: "10px 12px", background: "#241616", color: "#f0c4c4", font: "13px/1.4 system-ui, sans-serif" }}>
      Chatten kunde inte återställas efter siduppdateringen. URL-runnen användes inte som state; försök uppdatera sidan igen.
    </div> : null}
  </>;
}
