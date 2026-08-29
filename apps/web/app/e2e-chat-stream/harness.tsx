"use client";

import { useEffect, useRef, useState } from "react";
import { RunStreamPreview } from "../dashboard/run-stream-preview";
import styles from "../dashboard/workspace-shell-v3.module.css";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";
const ANSWER = "The current time in Europe/Stockholm is 00:09:00.";

export function ChatStreamHarness() {
  const [terminal, setTerminal] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState(CONVERSATION_ID);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollTop = canvas.scrollHeight;
  }, []);

  return <main>
    <h1>Chat stream E2E harness</h1>
    <div ref={canvasRef} className={styles.chatCanvas} data-testid="chat-canvas" style={{ height: 160, overflowY: "auto" }}>
      <div style={{ height: 900 }} aria-hidden="true" />
      {persisted && activeConversationId === CONVERSATION_ID && <div className={styles.messageStream} data-testid="persisted-answer">
        <article className={`${styles.message} ${styles.assistantMessage}`}>
          <div className={styles.messageMeta}>DIV3RSA</div>
          <div className={styles.messageBody}>{ANSWER}</div>
        </article>
      </div>}
      <RunStreamPreview
        runId={RUN_ID}
        conversationId={CONVERSATION_ID}
        activeConversationId={activeConversationId}
        terminal={terminal}
      />
    </div>
    <button type="button" onClick={() => setTerminal(true)}>Mark terminal</button>
    <button type="button" onClick={() => setPersisted(true)}>Persist answer</button>
    <button type="button" onClick={() => setActiveConversationId(OTHER_CONVERSATION_ID)}>Switch conversation</button>
  </main>;
}
