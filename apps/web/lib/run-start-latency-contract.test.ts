import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "apps/web/app/api/runs/route.ts"), "utf8");

describe("agent run start latency contract", () => {
  it("returns the queued run identity without awaiting runtime prewarm", () => {
    expect(source).toContain('import { after, NextResponse } from "next/server"');
    expect(source).toContain("after(async () => {");
    expect(source).toContain("const runtime = await ensureModelRuntime(alias);");
    expect(source).not.toContain("const runtimeWake = await ensureModelRuntime(alias)");
    expect(source).toContain("runtimeWake: null");

    const queuedAt = source.indexOf('"start_agent_run"');
    const deferredAt = source.indexOf("after(async () => {");
    const responseAt = source.indexOf("return NextResponse.json({ runId: run.run_id");
    expect(queuedAt).toBeGreaterThanOrEqual(0);
    expect(deferredAt).toBeGreaterThan(queuedAt);
    expect(responseAt).toBeGreaterThan(deferredAt);
  });

  it("keeps resource selection and run creation inside one transactional RPC", () => {
    expect(source).not.toContain('rpc.rpc<Record<string, unknown>>("set_conversation_resources"');
    expect(source).toContain("resource_ids: resourceIds");
    expect(source.match(/rpc\.rpc</g)?.length).toBe(1);
  });
});
