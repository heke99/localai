"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./workspace-shell-v3.module.css";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const AUTO_FOLLOW_THRESHOLD_PX = 180;
const PERSISTED_HANDOFF_OBSERVER_MS = 15_000;
const WRITING_ACTIVITY_HOLD_MS = 420;

export type RunActivity = {
  kind: string;
  label: string;
  target?: string;
};

export type RunStreamSnapshot = {
  runId: string;
  conversationId: string;
  status: string;
  content: string;
  revision: number;
  activity?: RunActivity | null;
};

function persistedAssistantCount(canvas: HTMLElement, stream: HTMLElement | null) {
  return Array.from(canvas.querySelectorAll(`.${styles.assistantMessage}`))
    .filter((message) => !stream?.contains(message))
    .length;
}

function fallbackActivity(status: string, hasContent: boolean): RunActivity {
  if (hasContent) return { kind: "model", label: "Skriver svar" };
  if (status === "planning") return { kind: "plan", label: "Planerar svaret" };
  if (status === "waiting_for_tool") return { kind: "tool", label: "Väntar på verktyg" };
  if (status === "verifying") return { kind: "verification", label: "Verifierar resultat" };
  return { kind: "run", label: "Arbetar med svaret" };
}

function revealStep(remaining: number, terminal: boolean) {
  if (terminal) return Math.max(remaining, 1);
  if (remaining > 1600) return 120;
  if (remaining > 700) return 64;
  if (remaining > 280) return 32;
  if (remaining > 100) return 16;
  if (remaining > 36) return 8;
  return Math.min(4, remaining);
}

export function RunStreamPreview({ runId, conversationId, activeConversationId, terminal, onSnapshot }: {
  runId: string;
  conversationId: string;
  activeConversationId: string | null;
  terminal: boolean;
  onSnapshot?: (snapshot: RunStreamSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<RunStreamSnapshot | null>(null);
  const [displayedContent, setDisplayedContent] = useState("");
  const [receivingText, setReceivingText] = useState(false);
  const onSnapshotRef = useRef(onSnapshot);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowRef = useRef(true);
  const persistedAssistantBaselineRef = useRef(0);
  const previousTargetLengthRef = useRef(0);
  const writingTimerRef = useRef<number | null>(null);
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
    if (!displayedContent || activeConversationId !== conversationId || !shouldFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      streamRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayedContent, activeConversationId, conversationId]);

  useEffect(() => {
    const target = snapshot?.content ?? "";
    if (!target) {
      setDisplayedContent("");
      return;
    }

    let frame = 0;
    const animate = () => {
      let finished = false;
      setDisplayedContent((current) => {
        if (current === target) {
          finished = true;
          return current;
        }
        if (!target.startsWith(current)) {
          finished = true;
          return target;
        }
        const remaining = target.length - current.length;
        const nextLength = current.length + revealStep(remaining, terminal);
        if (nextLength >= target.length) finished = true;
        return target.slice(0, Math.min(nextLength, target.length));
      });
      if (!finished) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.content, terminal]);

  useEffect(() => {
    if (activeConversationId !== conversationId) {
      setSnapshot(null);
      setDisplayedContent("");
      previousTargetLengthRef.current = 0;
      return;
    }

    // Preserve the last streamed answer while the parent replaces it with the
    // persisted assistant message. The handoff effect below removes the stream
    // only after that replacement is actually visible in this chat.
    if (terminal) return;

    const canvas = document.querySelector(`.${styles.chatCanvas}`);
    if (canvas instanceof HTMLElement) {
      persistedAssistantBaselineRef.current = persistedAssistantCount(canvas, streamRef.current);
    }

    setSnapshot(null);
    setDisplayedContent("");
    previousTargetLengthRef.current = 0;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const onStreamSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as RunStreamSnapshot;
        if (next.runId !== runId || next.conversationId !== conversationId) return;
        if (next.content.length > previousTargetLengthRef.current) {
          setReceivingText(true);
          if (writingTimerRef.current !== null) window.clearTimeout(writingTimerRef.current);
          writingTimerRef.current = window.setTimeout(() => {
            writingTimerRef.current = null;
            setReceivingText(false);
          }, WRITING_ACTIVITY_HOLD_MS);
        }
        previousTargetLengthRef.current = next.content.length;
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
      if (writingTimerRef.current !== null) {
        window.clearTimeout(writingTimerRef.current);
        writingTimerRef.current = null;
      }
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
      setDisplayedContent("");
      return;
    }

    const observer = new MutationObserver(() => {
      if (!handoffReady()) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      setSnapshot(null);
      setDisplayedContent("");
    });
    observer.observe(canvas, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), PERSISTED_HANDOFF_OBSERVER_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [terminal, snapshot?.content, activeConversationId, conversationId]);

  if (activeConversationId !== conversationId || !snapshot) return null;
  const activity = receivingText
    ? { kind: "model", label: "Skriver svar" }
    : snapshot.activity ?? fallbackActivity(snapshot.status, Boolean(snapshot.content));
  const showActivity = !TERMINAL.has(snapshot.status);
  if (!displayedContent && !showActivity) return null;

  return <div
    ref={streamRef}
    className={styles.messageStream}
    data-run-stream={runId}
    data-stream-revision={snapshot.revision}
    role="status"
    aria-live="polite"
    aria-atomic="false"
  >
    {showActivity && <div
      data-run-activity={activity.kind}
      style={{
        justifySelf: "start",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        width: "fit-content",
        maxWidth: "min(92%, 680px)",
        padding: "7px 11px",
        border: "1px solid #2f3339",
        borderRadius: 999,
        background: "#15181c",
        color: "#b9bdc5",
        fontSize: 11,
        lineHeight: 1.35,
        boxShadow: "0 8px 24px rgba(0,0,0,.18)"
      }}
    >
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: "#6ed69a", boxShadow: "0 0 0 4px rgba(110,214,154,.08)", flex: "0 0 auto" }} />
      <strong style={{ color: "#e0e2e5", fontWeight: 650 }}>{activity.label}</strong>
      {activity.target && <span title={activity.target} style={{ color: "#7f858f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>· {activity.target}</span>}
    </div>}
    {displayedContent && <article className={`${styles.message} ${styles.assistantMessage}`}>
      <div className={styles.messageMeta}>DIV3RSA</div>
      <div className={styles.messageBody}>{displayedContent}</div>
    </article>}
  </div>;
}
