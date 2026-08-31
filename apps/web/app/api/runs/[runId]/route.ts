import { setTimeout as sleep } from "node:timers/promises";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const STATUS_WAIT_MS = 900;
const STATUS_POLL_MS = 225;

type RpcClient = { rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { runId } = await context.params;
  const deadline = Date.now() + STATUS_WAIT_MS;

  while (true) {
    const { data, error } = await supabase.rpc("get_agent_run", { target_run_id: runId });
    const run = data?.[0];
    if (error || !run) return NextResponse.json({ error: "run_not_found" }, { status: 404 });
    if (terminalStatuses.has(run.status) || Date.now() >= deadline) return NextResponse.json(run);
    await sleep(STATUS_POLL_MS);
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ runId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { runId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rpc = supabase as unknown as RpcClient;
  const { data, error } = await rpc.rpc<Record<string, unknown>>("request_agent_run_cancellation", { target_run_id: runId });
  if (error || !data) return NextResponse.json({ error: "run_not_cancellable" }, { status: 409 });
  return NextResponse.json({
    cancelled: data.ready === true,
    status: typeof data.status === "string" ? data.status : "cancelling",
    activeToolExecutions: Number(data.activeToolExecutions ?? 0),
    unsafeRollbacks: Number(data.unsafeRollbacks ?? 0)
  });
}
