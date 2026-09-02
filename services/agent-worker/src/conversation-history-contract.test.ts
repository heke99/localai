import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../supabase/migrations/20260902163000_agent_worker_conversation_history.sql", import.meta.url);

describe("agent conversation history database contract", () => {
  it("keeps history retrieval service-only, run-bound and excludes the current input turn", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("worker_load_agent_conversation_history");
    expect(sql).toContain("auth.jwt()->>'role'");
    expect(sql).toContain("service_role_required");
    expect(sql).toContain("where r.request_id = target_request_id");
    expect(sql).toContain("m.conversation_id = target_run.conversation_id");
    expect(sql).toContain("m.id <> target_run.input_message_id");
    expect(sql).toContain("m.role in ('user', 'assistant')");
    expect(sql).toContain("limit bounded_limit");
    expect(sql).toContain("revoke all on function public.worker_load_agent_conversation_history(text, integer) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.worker_load_agent_conversation_history(text, integer) to service_role");
  });
});
