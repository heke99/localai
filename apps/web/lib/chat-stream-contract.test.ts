import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeFromRepoRoot: string) {
  return readFileSync(new URL(`../../../${relativeFromRepoRoot}`, import.meta.url), "utf8");
}

describe("chat streaming UI contract", () => {
  it("uses low-latency unbuffered SSE for first visible response text", () => {
    const route = source("apps/web/app/api/runs/[runId]/stream/route.ts");
    expect(route).toContain("const POLL_MS = 50;");
    expect(route).toContain('"content-type": "text/event-stream; charset=utf-8"');
    expect(route).toContain('"cache-control": "no-cache, no-transform"');
    expect(route).toContain('"x-accel-buffering": "no"');
    expect(route).toContain('send("snapshot"');
  });

  it("rotates long SSE connections before the Vercel 300 second function timeout", () => {
    const route = source("apps/web/app/api/runs/[runId]/stream/route.ts");
    expect(route).toContain("const STREAM_RETRY_MS = 250;");
    expect(route).toContain("const MAX_CONNECTION_MS = 240_000;");
    expect(route).toContain("retry: ${STREAM_RETRY_MS}");
    expect(route).toContain('send("rotate"');
    expect(route).toContain("Date.now() - connectionStartedAt >= MAX_CONNECTION_MS");
  });

  it("keeps the last streamed answer visible while persisted conversation state catches up", () => {
    const preview = source("apps/web/app/dashboard/run-stream-preview.tsx");
    expect(preview).toContain("if (terminal) return;");
    expect(preview).toContain("if (activeConversationId !== conversationId || !snapshot?.content) return null;");
    expect(preview).not.toContain("if (terminal || activeConversationId !== conversationId || !snapshot?.content) return null;");
    expect(preview).toContain("data-stream-revision");
  });

  it("prewarms the runtime before submit and preserves SSE preview in the active dashboard", () => {
    const shellV5 = source("apps/web/app/dashboard/workspace-shell-v5.tsx");
    const shellV4 = source("apps/web/app/dashboard/workspace-shell-v4.tsx");
    expect(shellV5).toContain('/api/runtime/prewarm');
    expect(shellV5).toContain("if (composerAvailable()) void requestPrewarm();");
    expect(shellV4).toContain("RunStreamPreview");
    expect(shellV4).toContain("/api/runs/${run.id}");
  });

  it("checkpoints the exact conversation and active run so reload can resume safely", () => {
    const shellV4 = source("apps/web/app/dashboard/workspace-shell-v4.tsx");
    const conversationRoute = source("apps/web/app/api/conversations/[conversationId]/route.ts");

    expect(shellV4).toContain('const dashboardConversationParam = "conversation";');
    expect(shellV4).toContain('const dashboardRunParam = "run";');
    expect(shellV4).toContain("window.history.replaceState");
    expect(shellV4).toContain("requestedConversationId");
    expect(shellV4).toContain("requestedRunId");
    expect(shellV4).toContain("replaceDashboardLocation(mode, conversation.id, null);");
    expect(shellV4).toContain("replaceDashboardLocation(activeMode, body.conversationId, body.runId);");
    expect(shellV4).toContain("body.activeRun");
    expect(shellV4).toContain("void refreshRun();");

    expect(conversationRoute).toContain('rpc.rpc<ActiveRun[]>("get_active_agent_run"');
    expect(conversationRoute).not.toContain("createSupabaseAdminClient");
    expect(conversationRoute).not.toContain('.schema("internal")');
    expect(conversationRoute).toContain("activeRun: activeRunResult.data?.[0] ?? null");
  });
});
