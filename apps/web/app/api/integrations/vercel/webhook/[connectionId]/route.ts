import { NextResponse } from "next/server";
import { readCredential } from "../../../../../../../lib/integrations/broker";
import type { StoredCredential } from "../../../../../../../lib/integrations/oauth";
import { getVercelWebhookSecret, recordVercelDeploymentEvent } from "../../../../../../../lib/integrations/vercel-webhook-broker";
import {
  deploymentGitBranch,
  deploymentGitCommitSha,
  fetchVercelDeploymentDetails,
  verifyVercelWebhookSignature,
  VERCEL_DEPLOYMENT_WEBHOOK_EVENTS
} from "../../../../../../../lib/integrations/vercel-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedEvents = new Set<string>(VERCEL_DEPLOYMENT_WEBHOOK_EVENTS);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string,unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function credentialFrom(value: Record<string,unknown> | null): StoredCredential | null {
  if (!value || typeof value.accessToken !== "string" || !value.accessToken) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
    tokenType: typeof value.tokenType === "string" ? value.tokenType : null,
    scope: typeof value.scope === "string" ? value.scope : null,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null
  };
}
function eventCreatedAt(value: unknown) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return new Date().toISOString();
  return new Date(milliseconds).toISOString();
}
function deploymentIdFromPayload(payload: Record<string,unknown>) {
  const deployment = object(payload.deployment);
  const candidates = [deployment.id, payload.deploymentId, payload.deployment_id];
  return candidates.map(text).find((value): value is string => Boolean(value)) ?? null;
}

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  if (!uuidPattern.test(connectionId)) return NextResponse.json({ error: "connection_not_found" }, { status: 404 });

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > 1_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });

  let subscription: Awaited<ReturnType<typeof getVercelWebhookSecret>>;
  try {
    subscription = await getVercelWebhookSecret(connectionId);
  } catch {
    // A stale Vercel webhook may briefly outlive a disconnected connection.
    // Acknowledge it so Vercel does not retry indefinitely; no event is stored.
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (!verifyVercelWebhookSignature(rawBody, request.headers.get("x-vercel-signature"), subscription.secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: Record<string,unknown>;
  try { event = object(JSON.parse(rawBody)); }
  catch { return NextResponse.json({ error: "invalid_payload" }, { status: 400 }); }

  const eventId = text(event.id);
  const eventType = text(event.type);
  if (!eventId || !eventType) return NextResponse.json({ error: "event_identity_required" }, { status: 400 });
  if (!allowedEvents.has(eventType)) return NextResponse.json({ ok: true, ignored: true });

  const payload = object(event.payload);
  const deploymentId = deploymentIdFromPayload(payload);
  if (!deploymentId) return NextResponse.json({ ok: true, ignored: true });

  try {
    const stored = await readCredential(connectionId);
    if (stored.provider !== "vercel") throw new Error("provider_connection_mismatch");
    const credential = credentialFrom(stored.credential);
    if (!credential) throw new Error("integration_credential_missing");

    const teamId = subscription.teamId || text(stored.metadata.callbackTeamId);
    const details = await fetchVercelDeploymentDetails(credential, deploymentId, teamId);
    const projectId = text(details.projectId);
    if (!projectId || !subscription.projectIds.includes(projectId)) throw new Error("vercel_project_not_authorized");

    const recorded = await recordVercelDeploymentEvent({
      connectionId,
      eventId,
      eventType,
      eventCreatedAt: eventCreatedAt(event.createdAt),
      projectId,
      deploymentId: text(details.id) || deploymentId,
      deploymentUrl: text(details.url),
      deploymentState: text(details.readyState) || text(details.state),
      deploymentTarget: text(details.target),
      gitCommitSha: deploymentGitCommitSha(details),
      gitBranch: deploymentGitBranch(details),
      errorCode: text(details.errorCode),
      errorMessage: text(details.errorMessage)
    });

    return NextResponse.json({ ok: true, recorded });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":",1)[0].slice(0,120) : "vercel_webhook_processing_failed";
    console.error("vercel_webhook_processing_failed", { connectionId, eventType, code });
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
