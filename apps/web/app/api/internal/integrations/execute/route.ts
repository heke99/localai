import { NextResponse } from "next/server";
import { updateCredential } from "../../../../../lib/integrations/broker";
import { consumeIdempotentExecution, finishIdempotentExecution } from "../../../../../lib/integrations/idempotent-execution";
import { executeGithubTool } from "../../../../../lib/integrations/github";
import { executeGithubRepositorySnapshot } from "../../../../../lib/integrations/github-snapshot";
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
  const text = JSON.stringify(value ?? null);
  if (text.length <= 1_500_000) return value ?? null;
  return { truncated: true, preview: text.slice(0,1_500_000), originalBytes: Buffer.byteLength(text) };
}
function retryableProviderFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|502|503|504|timeout|temporar|connection|unavailable/i.test(message);
}

export async function POST(request: Request) {
  let grantId = "";
  let operationId = "";
  let provider = "";
  let toolName = "";
  let executionStarted = false;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 2_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    const body = await request.json() as { grantId?: unknown; toolName?: unknown; args?: unknown; operationId?: unknown; attempt?: unknown };
    grantId = typeof body.grantId === "string" ? body.grantId : "";
    toolName = typeof body.toolName === "string" ? body.toolName : "";
    operationId = typeof body.operationId === "string" ? body.operationId : "";
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string,unknown> : {};
    if (!/^[0-9a-f-]{36}$/i.test(grantId) || !toolName || !/^[a-f0-9]{64}$/.test(operationId)) return NextResponse.json({ error: "invalid_execution_request" }, { status: 400 });
    if (idempotencyKey !== operationId) return NextResponse.json({ error: "idempotency_key_mismatch" }, { status: 409, headers: { "Cache-Control": "no-store, max-age=0" } });
    if (isForbiddenIntegrationToolName(toolName)) return NextResponse.json({ error: "vercel_log_drains_forbidden" }, { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } });
    const tool = gatewayToolByName(toolName);
    if (!tool) return NextResponse.json({ error: "unknown_integration_tool" }, { status: 404 });

    const grant = await consumeIdempotentExecution(grantId, toolName, operationId);
    const executionStatus = stringField(grant,"executionStatus");
    if (executionStatus === "completed") {
      const response = NextResponse.json({ result: safeOutput(grant.result), replayed: true });
      response.headers.set("Cache-Control","no-store, max-age=0");
      response.headers.set("Idempotency-Replayed","true");
      return response;
    }
    if (grant.executeAllowed !== true) {
      return NextResponse.json({ error: executionStatus === "running" ? "operation_in_progress" : "operation_not_executable", operationStatus: executionStatus }, { status: 409, headers: { "Cache-Control": "no-store, max-age=0" } });
    }
    executionStarted = true;

    provider = stringField(grant,"provider");
    const capability = stringField(grant,"capability");
    if (provider !== tool.provider || capability !== tool.capability || stringField(grant,"operationId") !== operationId) throw new Error("execution_grant_tool_mismatch");
    const metadata = objectField(grant,"resourceMetadata");
    const externalId = stringField(grant,"externalResourceId");
    const connectionId = stringField(grant,"connectionId");

    let result: unknown;
    if (provider === "github") {
      result = toolName === "github_read_repository_snapshot"
        ? await executeGithubRepositorySnapshot(args, metadata)
        : await executeGithubTool(toolName,args,metadata);
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

    const storedResult = safeOutput(result);
    await finishIdempotentExecution({ grantId, operationId, outcome: "completed", result: storedResult, metadata: { tool: toolName, provider } });
    const response = NextResponse.json({ result: storedResult, replayed: false });
    response.headers.set("Cache-Control","no-store, max-age=0");
    return response;
  } catch (error) {
    if (grantId && operationId && executionStarted) {
      await finishIdempotentExecution({
        grantId,
        operationId,
        outcome: request.signal.aborted ? "cancelled" : "failed",
        metadata: { errorCode: error instanceof Error ? error.message.split(":",1)[0].slice(0,120) : "execution_failed", tool: toolName, provider },
        retryable: !request.signal.aborted && retryableProviderFailure(error)
      }).catch(() => undefined);
    }
    return NextResponse.json({ error: request.signal.aborted ? "integration_execution_cancelled" : "integration_execution_failed" }, { status: 409, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
