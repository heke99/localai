import { NextResponse } from "next/server";
import { readCredential, resyncIntegrationConnection } from "../../../../../lib/integrations/broker";
import { requiredProviderEnv, type StoredCredential } from "../../../../../lib/integrations/oauth";
import { discoverVercel } from "../../../../../lib/integrations/vercel-provider";
import { findVercelWebhookConnections, recordVercelWebhookEvent } from "../../../../../lib/integrations/vercel-webhook-broker";
import {
  VERCEL_RESYNC_WEBHOOK_EVENTS,
  VERCEL_WEBHOOK_EVENTS,
  vercelEventState,
  verifyVercelWebhookSignature
} from "../../../../../lib/integrations/vercel-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedEvents = new Set<string>(VERCEL_WEBHOOK_EVENTS);

function object(value: unknown): Record<string,unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0,1000) : [];
}
function eventCreatedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}
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
function knownGitMetadata(deployment: Record<string,unknown>) {
  const meta = object(deployment.meta);
  const pick = (key: string) => text(meta[key]);
  return {
    gitCommitSha: pick("githubCommitSha") || pick("gitlabCommitSha") || pick("bitbucketCommitSha") || pick("gitCommitSha"),
    gitBranch: pick("githubCommitRef") || pick("gitlabCommitRef") || pick("bitbucketCommitRef") || pick("gitCommitRef")
  };
}
function safeMetadata(payload: Record<string,unknown>, eventType: string) {
  const deployment = object(payload.deployment);
  const project = object(payload.project);
  const configuration = object(payload.configuration);
  const projects = object(payload.projects);
  const git = knownGitMetadata(deployment);
  return {
    teamId: text(object(payload.team).id) || text(payload.teamId),
    configurationId: text(configuration.id) || text(payload.installationId),
    projectName: text(project.name),
    previousProjectName: text(payload.previousName),
    envVarId: text(payload.envVarId),
    projectSelection: text(configuration.projectSelection),
    projectsAdded: stringArray(projects.added),
    projectsRemoved: stringArray(projects.removed),
    scopes: stringArray(configuration.scopes),
    previousTeamId: text(payload.previousTeamId),
    newTeamId: text(payload.newTeamId),
    fromDeploymentId: text(payload.fromDeploymentId),
    toDeploymentId: text(payload.toDeploymentId),
    gitCommitSha: git.gitCommitSha,
    gitBranch: git.gitBranch,
    source: "vercel_integration_webhook",
    eventType
  };
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > 1_500_000) return NextResponse.json({ error: "request_too_large" }, { status: 413 });

  let integrationSecret: string;
  try { integrationSecret = requiredProviderEnv("vercel", "CLIENT_SECRET"); }
  catch { return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 }); }

  if (!verifyVercelWebhookSignature(rawBody, request.headers.get("x-vercel-signature"), integrationSecret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: Record<string,unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid_payload");
    event = parsed as Record<string,unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const eventId = text(event.id);
  const eventType = text(event.type);
  if (!eventId || !eventType) return NextResponse.json({ error: "event_identity_required" }, { status: 400 });
  if (!allowedEvents.has(eventType)) return NextResponse.json({ ok: true, ignored: true });

  const payload = object(event.payload);
  const deployment = object(payload.deployment);
  const project = object(payload.project);
  const configuration = object(payload.configuration);
  const configurationId = text(configuration.id) || text(payload.installationId);
  const projectId = text(project.id) || text(payload.projectId);
  const teamId = text(object(payload.team).id) || text(payload.teamId);
  const deploymentId = text(deployment.id) || (eventType === "deployment.rollback" ? text(payload.toDeploymentId) : null);
  const deploymentUrl = text(deployment.url);
  const deploymentTarget = text(payload.target) || text(deployment.target);
  const createdAt = eventCreatedAt(event.createdAt);
  const metadata = safeMetadata(payload,eventType);

  let connections;
  try {
    connections = await findVercelWebhookConnections({ configurationId, projectId, teamId });
  } catch (error) {
    console.error("vercel_webhook_lookup_failed", { eventType, code: error instanceof Error ? error.message.slice(0,120) : "unknown" });
    return NextResponse.json({ error: "webhook_lookup_failed" }, { status: 500 });
  }
  if (!connections.length) return NextResponse.json({ ok: true, matched: 0 });

  let recorded = 0;
  let resynced = 0;
  let failed = 0;
  for (const connection of connections) {
    try {
      const inserted = await recordVercelWebhookEvent({
        connectionId: connection.connectionId,
        eventId,
        eventType,
        eventCreatedAt: createdAt,
        projectId,
        deploymentId,
        deploymentUrl,
        deploymentState: vercelEventState(eventType),
        deploymentTarget,
        metadata
      });
      if (inserted) recorded += 1;

      if (VERCEL_RESYNC_WEBHOOK_EVENTS.has(eventType)) {
        const stored = await readCredential(connection.connectionId);
        if (stored.provider !== "vercel") throw new Error("provider_connection_mismatch");
        const credential = credentialFrom(stored.credential);
        if (!credential) throw new Error("integration_credential_missing");
        const storedConfigurationId = text(stored.metadata.callbackConfigurationId);
        const nextConfigurationId = configurationId || storedConfigurationId;
        const transferredTeamId = text(payload.newTeamId);
        const nextTeamId = transferredTeamId || teamId || text(stored.metadata.callbackTeamId);
        if (!nextConfigurationId) throw new Error("vercel_configuration_id_missing");
        const discovery = await discoverVercel(credential, {
          configurationId: nextConfigurationId,
          teamId: nextTeamId,
          source: `webhook:${eventType}`
        });
        await resyncIntegrationConnection({
          connectionId: connection.connectionId,
          metadata: { ...stored.metadata, ...discovery.metadata, webhook: { status: "active", mode: "integration_console", lastEventType: eventType, lastEventAt: createdAt } },
          capabilities: discovery.capabilities,
          resources: discovery.resources
        });
        resynced += 1;
      }
    } catch (error) {
      failed += 1;
      console.error("vercel_webhook_processing_failed", {
        connectionId: connection.connectionId,
        eventType,
        code: error instanceof Error ? error.message.split(":",1)[0].slice(0,120) : "unknown"
      });
    }
  }

  return NextResponse.json({ ok: failed === 0, matched: connections.length, recorded, resynced, failed });
}
