"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./workspace-shell-v3.module.css";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const AUTO_FOLLOW_THRESHOLD_PX = 180;
const PERSISTED_HANDOFF_OBSERVER_MS = 15_000;

export type RunStreamSnapshot = {
  runId: string;
  conversationId: string;
  status: string;
  content: string;
  revision: number;
};

function persistedAssistantCount(canvas: HTMLElement, stream: HTMLElement | null) {
  return Array.from(canvas.querySelectorAll(`.${styles.assistantMessage}`))
    .filter((message) => !stream?.contains(message))
    .length;
}

export function RunStreamPreview({ runId, conversationId, activeConversationId, terminal, onSnapshot }: {
  runId: string;
  conversationId: string;
  activeConversationId: string | null;
  terminal: boolean;
  onSnapshot?: (snapshot: RunStreamSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<RunStreamSnapshot | null>(null);
  const onSnapshotRef = useRef(onSnapshot);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowRef = useRef(true);
  const persistedAssistantBaselineRef = useRef(0);
  useEffect(() => { onSnapshotRef.current = onSnapshot; }, [onSnapshot]);

  useEffect(() => {
    if (activeConversationId !== conversationId) return;
    const canvas = document.querySelector(`.${styles.chatCanvas}`);
    if (!(canvas instanceof HTMLElement)) return;

    const updateFollowState = () => {
      const distanceFromBottom = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
      shouldFollowRef.current = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
    };
    updateFollowState();
    canvas.addEventListener("scroll", updateFollowState, { passive: true });
    return () => canvas.removeEventListener("scroll", updateFollowState);
  }, [activeConversationId, conversationId]);

  useEffect(() => {
    if (!snapshot?.content || activeConversationId !== conversationId || !shouldFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      streamRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.revision, snapshot?.content, activeConversationId, conversationId]);

  useEffect(() => {
    if (activeConversationId !== conversationId) {
      setSnapshot(null);
      return;
    }
    const canvas = document.querySelector(`.${styles.chatCanvas}`);
    if (canvas instanceof HTMLElement) {
      persistedAssistantBaselineRef.current = persistedAssistantCount(canvas, streamRef.current);
    }

    // Preserve the last streamed answer while the parent replaces it with the
    // persisted assistant message. The handoff effect below removes the stream
    // only after that replacement is actually visible in this chat.
    if (terminal) return;

    setSnapshot(null);
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const onStreamSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as RunStreamSnapshot;
        if (next.runId !== runId || next.conversationId !== conversationId) return;
        setSnapshot(next);
        onSnapshotRef.current?.(next);
        if (TERMINAL.has(next.status)) source.close();
      } catch { /* malformed stream event is ignored */ }
    };
    const onDone = () => source.close();
    source.addEventListener("snapshot", onStreamSnapshot as EventListener);
    source.addEventListener("done", onDone);
    source.onerror = () => {
      // EventSource reconnects automatically while CONNECTING. REST polling in
      // the parent remains the recovery path if the stream closes permanently.
      if (source.readyState === EventSource.CLOSED) source.close();
    };
    return () => {
      source.removeEventListener("snapshot", onStreamSnapshot as EventListener);
      source.removeEventListener("done", onDone);
      source.close();
    };
  }, [runId, conversationId, activeConversationId, terminal]);

  useEffect(() => {
    if (!terminal || !snapshot?.content || activeConversationId !== conversationId) return;
    const canvas = document.querySelector(`.${styles.chatCanvas}`);
    if (!(canvas instanceof HTMLElement)) return;
    const baseline = persistedAssistantBaselineRef.current;

    const handoffReady = () => persistedAssistantCount(canvas, streamRef.current) > baseline;
    if (handoffReady()) {
      setSnapshot(null);
      return;
    }

    const observer = new MutationObserver(() => {
      if (!handoffReady()) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      setSnapshot(null);
    });
    observer.observe(canvas, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), PERSISTED_HANDOFF_OBSERVER_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [terminal, snapshot?.content, activeConversationId, conversationId]);

  if (activeConversationId !== conversationId || !snapshot?.content) return null;
  return <div
    ref={streamRef}
    className={styles.messageStream}
    data-run-stream={runId}
    data-stream-revision={snapshot.revision}
    role="status"
    aria-live="polite"
    aria-atomic="false"
  >
    <article className={`${styles.message} ${styles.assistantMessage}`}>
      <div className={styles.messageMeta}>DIV3RSA</div>
      <div className={styles.messageBody}>{snapshot.content}</div>
    </article>
  </div>;
}
