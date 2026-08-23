import { NextResponse } from "next/server";
import { findGithubWebhookConnections, resyncGithubConnection } from "../../../../../lib/integrations/broker";
import { discoverGithubInstallations, verifyGithubWebhook } from "../../../../../lib/integrations/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubWebhookPayload {
  action?: string;
  installation?: { id?: number };
  sender?: { id?: number };
}

function installationIds(metadata: Record<string,unknown>) {
  const value = metadata.installationIds;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > 2_000_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });

  try {
    if (!verifyGithubWebhook(rawBody, request.headers.get("x-hub-signature-256"))) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  } catch (error) {
    console.error("github_webhook_configuration_error", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") return NextResponse.json({ ok: true });
  if (!new Set(["installation", "installation_repositories"]).has(event)) return NextResponse.json({ ok: true, ignored: true });

  let payload: GithubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GithubWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const installationId = Number(payload.installation?.id);
  if (!Number.isInteger(installationId) || installationId <= 0) return NextResponse.json({ error: "installation_required" }, { status: 400 });
  const senderId = Number.isInteger(Number(payload.sender?.id)) ? String(payload.sender?.id) : null;
  const connections = await findGithubWebhookConnections(installationId, senderId);
  if (!connections.length) return NextResponse.json({ ok: true, synced: 0 });

  let synced = 0;
  let failed = 0;
  for (const connection of connections) {
    try {
      const current = installationIds(connection.metadata);
      const next = payload.action === "deleted"
        ? current.filter((id) => id !== installationId)
        : [...new Set([...current, installationId])];
      const discovery = await discoverGithubInstallations(next);
      await resyncGithubConnection({
        connectionId: connection.connectionId,
        metadata: { ...connection.metadata, ...discovery.metadata },
        capabilities: discovery.capabilities,
        resources: discovery.resources
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error("github_webhook_resync_failed", connection.connectionId, error instanceof Error ? error.message : "unknown");
    }
  }

  return NextResponse.json({ ok: failed === 0, synced, failed }, { status: failed > 0 && synced === 0 ? 500 : 200 });
}
