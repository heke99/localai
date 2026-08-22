import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { runId } = await context.params;
  const { data, error } = await supabase.rpc("get_agent_run", { target_run_id: runId });
  if (error || !data?.[0]) return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  return NextResponse.json(data[0]);
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
