import { setTimeout as sleep } from "node:timers/promises";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const STATUS_WAIT_MS = 900;
const STATUS_POLL_MS = 225;

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
  const { data, error } = await supabase.rpc("cancel_agent_run", { target_run_id: runId });
  if (error || !data) return NextResponse.json({ error: "run_not_cancellable" }, { status: 409 });
  return NextResponse.json({ cancelled: true });
}
