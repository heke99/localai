import { NextResponse } from "next/server";
import { consumeExecutionGrant, finishExecutionGrant, updateCredential } from "../../../../../lib/integrations/broker";
import { executeGithubTool } from "../../../../../lib/integrations/github";
import { executeSupabaseTool, refreshSupabaseCredential } from "../../../../../lib/integrations/supabase-provider";
import { executeVercelTool, refreshVercelCredential } from "../../../../../lib/integrations/vercel-provider";
import type { StoredCredential } from "../../../../../lib/integrations/oauth";
import { gatewayToolByName, isForbiddenIntegrationToolName } from "../../../../../lib/integrations/tool-catalog";

export const runtime = "nodejs";

function objectField(record: Record<string,unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function stringField(record: Record<string,unknown>, key: string) { return typeof record[key] === "string" ? record[key] as string : ""; }
function credentialFrom(value: unknown): StoredCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string,unknown>;
  if (typeof record.accessToken !== "string" || !record.accessToken) return null;
  return { accessToken: record.accessToken, refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : null, tokenType: typeof record.tokenType === "string" ? record.tokenType : null, scope: typeof record.scope === "string" ? record.scope : null, expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null };
}
function needsRefresh(credential: StoredCredential) {
  if (!credential.expiresAt) return false;
  const expires = new Date(credential.expiresAt).getTime();
  return Number.isFinite(expires) && expires < Date.now() + 60_000;
}
function safeOutput(value: unknown) {
  const text = JSON.stringify(value);
  if (text.length <= 1_500_000) return value;
  return { truncated: true, preview: text.slice(0,1_500_000), originalBytes: Buffer.byteLength(text) };
}

export async function POST(request: Request) {
  let grantId = "";
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 2_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    const body = await request.json() as { grantId?: unknown; toolName?: unknown; args?: unknown };
    grantId = typeof body.grantId === "string" ? body.grantId : "";
    const toolName = typeof body.toolName === "string" ? body.toolName : "";
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string,unknown> : {};
    if (!/^[0-9a-f-]{36}$/i.test(grantId) || !toolName) return NextResponse.json({ error: "invalid_execution_request" }, { status: 400 });
    if (isForbiddenIntegrationToolName(toolName)) return NextResponse.json({ error: "vercel_log_drains_forbidden" }, { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } });
    const tool = gatewayToolByName(toolName);
    if (!tool) return NextResponse.json({ error: "unknown_integration_tool" }, { status: 404 });

    const grant = await consumeExecutionGrant(grantId, toolName);
    const provider = stringField(grant,"provider");
    const capability = stringField(grant,"capability");
    if (provider !== tool.provider || capability !== tool.capability) throw new Error("execution_grant_tool_mismatch");
    const metadata = objectField(grant,"resourceMetadata");
    const externalId = stringField(grant,"externalResourceId");
    const connectionId = stringField(grant,"connectionId");

    let result: unknown;
    if (provider === "github") {
      result = await executeGithubTool(toolName,args,metadata);
    } else {
      let credential = credentialFrom(grant.credential);
      if (!credential) throw new Error("integration_credential_missing");
      if (needsRefresh(credential)) {
        credential = provider === "supabase" ? await refreshSupabaseCredential(credential) : await refreshVercelCredential(credential);
        await updateCredential(connectionId,credential);
      }
      const execute = () => provider === "supabase" ? executeSupabaseTool(toolName,args,metadata,externalId,credential!) : executeVercelTool(toolName,args,metadata,externalId,credential!);
      try { result = await execute(); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("provider_http_401:") || !credential.refreshToken) throw error;
        credential = provider === "supabase" ? await refreshSupabaseCredential(credential) : await refreshVercelCredential(credential);
        await updateCredential(connectionId,credential);
        result = await execute();
      }
    }
    await finishExecutionGrant(grantId,"completed",{ tool: toolName, provider });
    const response = NextResponse.json({ result: safeOutput(result) });
    response.headers.set("Cache-Control","no-store, max-age=0");
    return response;
  } catch (error) {
    if (grantId) await finishExecutionGrant(grantId,"failed",{ errorCode: error instanceof Error ? error.message.split(":",1)[0].slice(0,120) : "execution_failed" });
    return NextResponse.json({ error: "integration_execution_failed" }, { status: 409, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
