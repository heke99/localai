import { setTimeout as sleep } from "node:timers/promises";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const POLL_MS = 50;
const HEARTBEAT_MS = 15_000;
const STREAM_RETRY_MS = 250;
const MAX_CONNECTION_MS = 240_000;
const SAFE_TEXT_MAX = 120;

type RunActivity = {
  kind: string;
  label: string;
  target?: string;
};

type RunStreamRow = {
  id: string;
  conversation_id: string;
  status: string;
  stream_content: string;
  stream_revision: number;
  updated_at: string;
  activity_kind: string | null;
  activity_status: string | null;
  activity_summary: string | null;
  activity_state: Record<string, unknown>;
};
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };

function objectFrom(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
}

function rowFrom(value: unknown): RunStreamRow | null {
  const candidate = Array.isArray(value) ? value[0] : null;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.conversation_id !== "string" || typeof row.status !== "string") return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    status: row.status,
    stream_content: typeof row.stream_content === "string" ? row.stream_content : "",
    stream_revision: typeof row.stream_revision === "number" ? row.stream_revision : Number(row.stream_revision ?? 0),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
    activity_kind: typeof row.activity_kind === "string" ? row.activity_kind : null,
    activity_status: typeof row.activity_status === "string" ? row.activity_status : null,
    activity_summary: typeof row.activity_summary === "string" ? row.activity_summary : null,
    activity_state: objectFrom(row.activity_state)
  };
}

function compactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, SAFE_TEXT_MAX);
}

function safeUrlTarget(value: unknown): string | undefined {
  const text = compactText(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/{2,}/g, "/");
    return `${url.host}${path}`.slice(0, SAFE_TEXT_MAX);
  } catch {
    // Only accept conservative host/IP-like targets when a full URL is absent.
    return /^[a-z0-9.-]+(?::\d{1,5})?(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(text)
      ? text.slice(0, SAFE_TEXT_MAX)
      : undefined;
  }
}

function activityLabel(kind: string | null, summary: string | null): string {
  const tool = (summary ?? "").toLowerCase();
  if (kind === "tool") {
    if (tool === "web_search" || tool.includes("search")) return "Söker på nätet";
    if (tool === "web_fetch" || tool.includes("fetch")) return "Läser källa";
    if (tool.includes("github") || tool.includes("repository")) return "Läser projektet";
    if (tool.includes("security") || tool.includes("scan")) return "Kör säkerhetskontroll";
    if (tool.includes("database") || tool.includes("supabase")) return "Kontrollerar data";
    return "Kör verktyg";
  }
  if (kind === "repository_index") return "Läser projektet";
  if (kind === "verification" || kind === "verify" || kind === "review") return "Verifierar resultat";
  if (kind === "skill") return "Förbereder verktyg";
  if (kind === "plan") return "Planerar svaret";
  return "Arbetar med svaret";
}

function safeActivity(row: RunStreamRow): RunActivity | null {
  if (TERMINAL.has(row.status)) return null;
  const state = row.activity_state;
  const kind = row.activity_kind ?? "run";
  const label = activityLabel(row.activity_kind, row.activity_summary);

  // Never forward the raw checkpoint state. Only a tiny allowlist can become a
  // visible target; URL query strings/fragments are intentionally removed.
  const urlTarget = safeUrlTarget(state.url) ?? safeUrlTarget(state.target);
  const repositoryTarget = compactText(state.repository);
  const queryTarget = row.activity_summary?.toLowerCase() === "web_search" ? compactText(state.query) : undefined;
  const target = urlTarget ?? repositoryTarget ?? queryTarget;
  return target ? { kind, label, target } : { kind, label };
}

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("authentication_required", { status: 401 });

  const { runId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return new Response("run_not_found", { status: 404 });
  const rpc = supabase as unknown as RpcClient;
  const firstResult = await rpc.rpc("get_agent_run_stream", { target_run_id: runId });
  const first = firstResult.error ? null : rowFrom(firstResult.data);
  if (!first) return new Response("run_not_found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastRevision = -1;
      let lastStatus = "";
      let lastActivityKey = "";
      let lastHeartbeat = Date.now();
      const connectionStartedAt = Date.now();

      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      const abort = () => close();
      request.signal.addEventListener("abort", abort, { once: true });
      controller.enqueue(encoder.encode(`retry: ${STREAM_RETRY_MS}\n\n`));

      try {
        let current: RunStreamRow | null = first;
        while (!closed && current) {
          const activity = safeActivity(current);
          const activityKey = JSON.stringify(activity);
          if (current.stream_revision !== lastRevision || current.status !== lastStatus || activityKey !== lastActivityKey) {
            send("snapshot", {
              runId: current.id,
              conversationId: current.conversation_id,
              status: current.status,
              content: current.stream_content,
              revision: current.stream_revision,
              activity,
              updatedAt: current.updated_at
            });
            lastRevision = current.stream_revision;
            lastStatus = current.status;
            lastActivityKey = activityKey;
          }
          if (TERMINAL.has(current.status)) {
            send("done", { runId: current.id, conversationId: current.conversation_id, status: current.status });
            break;
          }
          if (Date.now() - connectionStartedAt >= MAX_CONNECTION_MS) {
            send("rotate", {
              runId: current.id,
              conversationId: current.conversation_id,
              status: current.status,
              revision: current.stream_revision
            });
            break;
          }
          if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastHeartbeat = Date.now();
          }
          await sleep(POLL_MS, undefined, { signal: request.signal }).catch(() => undefined);
          if (request.signal.aborted) break;
          const result = await rpc.rpc("get_agent_run_stream", { target_run_id: runId });
          if (result.error) {
            send("error", { error: "run_stream_failed" });
            break;
          }
          current = rowFrom(result.data);
          if (!current) {
            send("error", { error: "run_not_found" });
            break;
          }
        }
      } catch {
        if (!request.signal.aborted) send("error", { error: "run_stream_failed" });
      } finally {
        request.signal.removeEventListener("abort", abort);
        close();
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}
