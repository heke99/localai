import "server-only";
import crypto from "node:crypto";
import { fetchJson, requiredProviderEnv } from "./oauth";

interface GitTreeEntry { path?: string; mode?: string; type?: string; sha?: string; size?: number }
interface GitTreeResponse { sha: string; truncated?: boolean; tree?: GitTreeEntry[] }
interface GitBlobResponse { content?: string; encoding?: string; size?: number }

const excludedPath = /(^|\/)(?:\.git|node_modules|vendor|dist|build|\.next)(\/|$)|(^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i;
const binaryPath = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|rar|wasm|woff2?|ttf|otf|mp[34]|mov|avi|mkv)$/i;
const MAX_FILE_BYTES = 750_000;

function githubHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

function githubAppJwt() {
  const appId = requiredProviderEnv("github", "APP_ID");
  const privateKey = requiredProviderEnv("github", "PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function installationToken(installationId: number) {
  const result = await fetchJson<{ token: string }>(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(githubAppJwt())
  });
  return result.token;
}

function repositoryCoordinates(metadata: Record<string, unknown>) {
  const fullName = typeof metadata.fullName === "string" ? metadata.fullName : "";
  const installationId = Number(metadata.installationId);
  const defaultBranch = typeof metadata.defaultBranch === "string" && metadata.defaultBranch ? metadata.defaultBranch : "main";
  if (!fullName || !Number.isInteger(installationId) || installationId <= 0) throw new Error("github_resource_metadata_invalid");
  return { fullName, installationId, defaultBranch };
}

async function githubApi<T>(token: string, path: string) {
  return fetchJson<T>(`https://api.github.com${path}`, { headers: githubHeaders(token) });
}

function encodeRefPath(ref: string) {
  return ref.replace(/^refs\/heads\//, "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function resolveCommitSha(token: string, repoPath: string, ref: string) {
  if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
  const result = await githubApi<{ object?: { sha?: string } }>(token, `${repoPath}/git/ref/heads/${encodeRefPath(ref)}`);
  const sha = result.object?.sha;
  if (!sha) throw new Error("github_snapshot_ref_unresolved");
  return sha;
}

function safeText(content: Buffer) {
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

export async function executeGithubRepositorySnapshot(args: Record<string, unknown>, metadata: Record<string, unknown>) {
  const { fullName, installationId, defaultBranch } = repositoryCoordinates(metadata);
  const token = await installationToken(installationId);
  const repoPath = `/repos/${fullName}`;
  const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : defaultBranch;
  const cursor = Math.max(0, Number.isInteger(Number(args.cursor)) ? Number(args.cursor) : 0);
  const requestedBytes = Number(args.maxBytes);
  const maxBytes = Number.isFinite(requestedBytes) ? Math.min(900_000, Math.max(250_000, Math.floor(requestedBytes))) : 800_000;
  const commitSha = await resolveCommitSha(token, repoPath, ref);
  const commit = await githubApi<{ tree?: { sha?: string } }>(token, `${repoPath}/git/commits/${commitSha}`);
  const treeSha = commit.tree?.sha;
  if (!treeSha) throw new Error("github_snapshot_tree_unresolved");
  const tree = await githubApi<GitTreeResponse>(token, `${repoPath}/git/trees/${treeSha}?recursive=1`);
  const eligible = (tree.tree ?? [])
    .filter((entry): entry is Required<Pick<GitTreeEntry, "path" | "sha">> & GitTreeEntry => entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string")
    .filter((entry) => !excludedPath.test(entry.path) && !binaryPath.test(entry.path) && (entry.size ?? 0) <= MAX_FILE_BYTES)
    .sort((a, b) => a.path.localeCompare(b.path));

  const files: Array<{ path: string; content: string; blobSha: string; size: number }> = [];
  let consumedBytes = 0;
  let index = cursor;
  for (; index < eligible.length; index += 1) {
    const entry = eligible[index]!;
    const estimated = Math.max(entry.size ?? 0, 1);
    if (files.length > 0 && consumedBytes + estimated > maxBytes) break;
    const blob = await githubApi<GitBlobResponse>(token, `${repoPath}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string") continue;
    const buffer = Buffer.from(blob.content.replace(/\s+/g, ""), "base64");
    const content = safeText(buffer);
    if (content === null) continue;
    files.push({ path: entry.path, content, blobSha: entry.sha, size: buffer.byteLength });
    consumedBytes += buffer.byteLength;
  }

  const nextCursor = index < eligible.length ? index : null;
  return {
    repository: fullName,
    ref,
    revisionSha: commitSha,
    treeSha,
    treeTruncated: tree.truncated === true,
    eligibleFileCount: eligible.length,
    cursor,
    nextCursor,
    files,
    complete: tree.truncated !== true && nextCursor === null
  };
}
