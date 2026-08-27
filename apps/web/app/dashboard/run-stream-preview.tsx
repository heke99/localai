"use client";

import { useEffect, useState } from "react";
import styles from "./workspace-shell-v3.module.css";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

type Snapshot = {
  runId: string;
  conversationId: string;
  status: string;
  content: string;
  revision: number;
};

export function RunStreamPreview({ runId, conversationId, activeConversationId, terminal }: {
  runId: string;
  conversationId: string;
  activeConversationId: string | null;
  terminal: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (activeConversationId !== conversationId) {
      setSnapshot(null);
      return;
    }
    // Preserve the last streamed answer while the parent replaces it with the
    // persisted assistant message. This prevents very fast deterministic runs
    // from briefly disappearing when status reaches completed before the
    // conversation refresh finishes.
    if (terminal) return;

    setSnapshot(null);
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as Snapshot;
        if (next.runId !== runId || next.conversationId !== conversationId) return;
        setSnapshot(next);
        if (TERMINAL.has(next.status)) source.close();
      } catch { /* malformed stream event is ignored */ }
    };
    const onDone = () => source.close();
    source.addEventListener("snapshot", onSnapshot as EventListener);
    source.addEventListener("done", onDone);
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) source.close();
    };
    return () => {
      source.removeEventListener("snapshot", onSnapshot as EventListener);
      source.removeEventListener("done", onDone);
      source.close();
    };
  }, [runId, conversationId, activeConversationId, terminal]);

  if (activeConversationId !== conversationId || !snapshot?.content) return null;
  return <div className={styles.messageStream} data-run-stream={runId} data-stream-revision={snapshot.revision}>
    <article className={`${styles.message} ${styles.assistantMessage}`}>
      <div className={styles.messageMeta}>DIV3RSA</div>
      <div className={styles.messageBody}>{snapshot.content}</div>
    </article>
  </div>;
}
