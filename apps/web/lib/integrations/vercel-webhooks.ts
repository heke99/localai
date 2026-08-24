import "server-only";
import crypto from "node:crypto";

export const VERCEL_WEBHOOK_EVENTS = [
  "deployment.created",
  "deployment.build-requested",
  "deployment.error",
  "deployment.blocked",
  "deployment.canceled",
  "deployment.succeeded",
  "deployment.promoted",
  "deployment.rollback",
  "deployment.ready",
  "project.env-variable.created",
  "project.env-variable.updated",
  "project.env-variable.deleted",
  "project.created",
  "project.removed",
  "project.renamed",
  "integration-configuration.permission-upgraded",
  "integration-configuration.scope-change-confirmed",
  "integration-configuration.transferred",
  "integration-resource.project-connected",
  "integration-resource.project-disconnected"
] as const;

export const VERCEL_RESYNC_WEBHOOK_EVENTS = new Set<string>([
  "project.created",
  "project.removed",
  "project.renamed",
  "integration-configuration.permission-upgraded",
  "integration-configuration.scope-change-confirmed",
  "integration-configuration.transferred",
  "integration-resource.project-connected",
  "integration-resource.project-disconnected"
]);

export function verifyVercelWebhookSignature(rawBody: string, headerSignature: string | null, integrationSecret: string) {
  if (!headerSignature || !integrationSecret) return false;
  const expected = crypto.createHmac("sha1", integrationSecret).update(rawBody).digest("hex");
  const provided = Buffer.from(headerSignature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return provided.length === computed.length && crypto.timingSafeEqual(provided, computed);
}

export function vercelEventState(eventType: string) {
  const states: Record<string,string> = {
    "deployment.created": "CREATED",
    "deployment.build-requested": "BUILD_REQUESTED",
    "deployment.error": "ERROR",
    "deployment.blocked": "BLOCKED",
    "deployment.canceled": "CANCELED",
    "deployment.succeeded": "SUCCEEDED",
    "deployment.promoted": "PROMOTED",
    "deployment.rollback": "ROLLBACK",
    "deployment.ready": "READY"
  };
  return states[eventType] ?? null;
}
