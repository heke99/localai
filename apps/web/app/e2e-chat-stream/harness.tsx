"use client";

import { useState } from "react";
import { RunStreamPreview } from "../dashboard/run-stream-preview";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";

export function ChatStreamHarness() {
  const [terminal, setTerminal] = useState(false);
  return <main>
    <h1>Chat stream E2E harness</h1>
    <RunStreamPreview
      runId={RUN_ID}
      conversationId={CONVERSATION_ID}
      activeConversationId={CONVERSATION_ID}
      terminal={terminal}
    />
    <button type="button" onClick={() => setTerminal(true)}>Mark terminal</button>
  </main>;
}
