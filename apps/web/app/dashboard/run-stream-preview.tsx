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
    setSnapshot(null);
    if (terminal || activeConversationId !== conversationId) return;
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

  if (terminal || activeConversationId !== conversationId || !snapshot?.content) return null;
  return <div className={styles.messageStream} data-run-stream={runId}>
    <article className={`${styles.message} ${styles.assistantMessage}`}>
      <div className={styles.messageMeta}>DIV3RSA</div>
      <div className={styles.messageBody}>{snapshot.content}</div>
    </article>
  </div>;
}
