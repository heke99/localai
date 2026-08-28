import { setTimeout as sleep } from "node:timers/promises";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const POLL_MS = 50;
const HEARTBEAT_MS = 15_000;

type RunStreamRow = {
  id: string;
  conversation_id: string;
  status: string;
  stream_content: string;
  stream_revision: number;
  updated_at: string;
};
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };

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
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString()
  };
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
      let lastHeartbeat = Date.now();

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

      try {
        let current: RunStreamRow | null = first;
        while (!closed && current) {
          if (current.stream_revision !== lastRevision || current.status !== lastStatus) {
            send("snapshot", {
              runId: current.id,
              conversationId: current.conversation_id,
              status: current.status,
              content: current.stream_content,
              revision: current.stream_revision,
              updatedAt: current.updated_at
            });
            lastRevision = current.stream_revision;
            lastStatus = current.status;
          }
          if (TERMINAL.has(current.status)) {
            send("done", { runId: current.id, conversationId: current.conversation_id, status: current.status });
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
