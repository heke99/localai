import "server-only";
import crypto from "node:crypto";
import { fetchJson, type StoredCredential } from "./oauth";

export const VERCEL_DEPLOYMENT_WEBHOOK_EVENTS = [
  "deployment.created",
  "deployment.ready",
  "deployment.error",
  "deployment.canceled",
  "deployment.promoted"
] as const;

interface VercelWebhookResponse {
  id?: string;
  secret?: string;
  ownerId?: string;
  events?: string[];
  projectIds?: string[];
}

export interface VercelDeploymentDetails {
  id?: string;
  url?: string;
  projectId?: string;
  name?: string;
  readyState?: string;
  state?: string;
  target?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  meta?: Record<string,unknown>;
  gitSource?: { ref?: string | null; sha?: string | null } | null;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function withTeam(path: string, teamId: string | null) {
  if (!teamId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}

export async function createVercelDeploymentWebhook(input: {
  credential: StoredCredential;
  connectionId: string;
  teamId: string | null;
  projectIds: string[];
  origin: string;
}) {
  if (!input.projectIds.length) throw new Error("vercel_webhook_projects_required");
  const webhookUrl = new URL(`/api/integrations/vercel/webhook/${input.connectionId}`, input.origin).toString();
  const response = await fetchJson<VercelWebhookResponse>(
    `https://api.vercel.com${withTeam("/v1/webhooks", input.teamId)}`,
    {
      method: "POST",
      headers: { ...authHeaders(input.credential.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        events: [...VERCEL_DEPLOYMENT_WEBHOOK_EVENTS],
        projectIds: [...new Set(input.projectIds)]
      })
    }
  );
  if (!response.id || !response.secret) throw new Error("vercel_webhook_response_invalid");
  return {
    webhookId: response.id,
    secret: response.secret,
    ownerId: response.ownerId ?? null,
    teamId: input.teamId,
    projectIds: [...new Set(response.projectIds?.length ? response.projectIds : input.projectIds)],
    events: [...new Set(response.events?.length ? response.events : VERCEL_DEPLOYMENT_WEBHOOK_EVENTS)]
  };
}

export async function deleteVercelDeploymentWebhook(credential: StoredCredential, webhookId: string, teamId: string | null) {
  const response = await fetch(`https://api.vercel.com${withTeam(`/v1/webhooks/${encodeURIComponent(webhookId)}`, teamId)}`, {
    method: "DELETE",
    headers: authHeaders(credential.accessToken),
    cache: "no-store"
  });
  if (response.status === 404 || response.status === 410) return;
  if (!response.ok) throw new Error(`provider_http_${response.status}:vercel_webhook_delete_failed`);
}

export function verifyVercelWebhookSignature(rawBody: string, headerSignature: string | null, secret: string) {
  if (!headerSignature || !secret) return false;
  const expected = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  const provided = Buffer.from(headerSignature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return provided.length === computed.length && crypto.timingSafeEqual(provided, computed);
}

export async function fetchVercelDeploymentDetails(credential: StoredCredential, deploymentId: string, teamId: string | null) {
  return fetchJson<VercelDeploymentDetails>(
    `https://api.vercel.com${withTeam(`/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true`, teamId)}`,
    { headers: authHeaders(credential.accessToken) }
  );
}

export function deploymentGitCommitSha(details: VercelDeploymentDetails) {
  const meta = details.meta ?? {};
  const candidates = [
    details.gitSource?.sha,
    meta.githubCommitSha,
    meta.gitlabCommitSha,
    meta.bitbucketCommitSha,
    meta.gitCommitSha
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

export function deploymentGitBranch(details: VercelDeploymentDetails) {
  const meta = details.meta ?? {};
  const candidates = [
    details.gitSource?.ref,
    meta.githubCommitRef,
    meta.gitlabCommitRef,
    meta.bitbucketCommitRef,
    meta.gitCommitRef
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}
