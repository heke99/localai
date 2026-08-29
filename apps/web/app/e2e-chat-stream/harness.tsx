"use client";

import { useState } from "react";
import { RunStreamPreview } from "../dashboard/run-stream-preview";
import styles from "../dashboard/workspace-shell-v3.module.css";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";

export function ChatStreamHarness() {
  const [terminal, setTerminal] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState(CONVERSATION_ID);
  return <main>
    <h1>Chat stream E2E harness</h1>
    <div className={styles.chatCanvas} data-testid="chat-canvas" style={{ height: 160, overflowY: "auto" }}>
      <div style={{ height: 900 }} aria-hidden="true" />
      <RunStreamPreview
        runId={RUN_ID}
        conversationId={CONVERSATION_ID}
        activeConversationId={activeConversationId}
        terminal={terminal}
      />
    </div>
    <button type="button" onClick={() => setTerminal(true)}>Mark terminal</button>
    <button type="button" onClick={() => setActiveConversationId(OTHER_CONVERSATION_ID)}>Switch conversation</button>
  </main>;
}
